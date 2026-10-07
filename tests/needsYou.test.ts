import test from 'node:test';
import assert from 'node:assert/strict';
import { AwayBanners, bannerFor, bannerText, compareNeedsYou, deriveNeedsYou, isAway, reportMaxAgeMs, type NeedsYouFacts, type NeedsYouItem } from '../src/core/needsYou';

const NOW = 1_000_000_000;
const minute = 60_000;
const facts = (extra: Partial<NeedsYouFacts> = {}): NeedsYouFacts => ({ projectId: 'p1', projectName: 'Hydra', ...extra });
const at = { focused: false, idleSeconds: 0 };
const present = { focused: true, idleSeconds: 3 };

test('each kind of item appears, and leaves when its state does', () => {
  const waiting = facts({
    chats: [{ id: 'c1', title: 'Fix login', status: 'needs', since: NOW - 5 }, { id: 'c2', title: 'Docs', status: 'unread', since: NOW - 4 }, { id: 'c3', title: 'Busy', status: 'working', since: NOW - 3 }, { id: 'c4', title: 'Idle', since: NOW - 2 }],
    heads: [{ id: 'h1', title: 'Builder', state: 'blocked', since: NOW - 6, leadWaiting: false, answersAt: NOW + 10 * minute }, { id: 'h2', title: 'Runner', state: 'running', since: NOW - 6, leadWaiting: false }],
    plans: [{ id: 'pl1', title: 'Ship it', since: NOW - 7, stopped: false, readyToMerge: true, leadWaiting: false, reportReady: false }, { id: 'pl2', title: 'Stuck', since: NOW - 8, stopped: true, readyToMerge: false, leadWaiting: false, reportReady: false }, { id: 'pl3', title: 'Overnight', since: NOW - 9, stopped: false, readyToMerge: false, leadWaiting: false, reportReady: true }],
    limitOffers: [{ id: 'l1', provider: 'claude', since: NOW - 10, resetsAt: NOW + 30 * minute }],
  });
  assert.deepEqual(deriveNeedsYou([waiting], NOW).map(item => item.kind).sort(), ['chat-needs', 'chat-unread', 'head-question', 'limit-offer', 'plan-merge', 'plan-report', 'plan-stopped']);
  // The same state a moment later: the chat answered, the head resumed, the plan merged, the limit reset.
  const settled = facts({
    chats: [{ id: 'c1', title: 'Fix login', status: 'working', since: NOW }, { id: 'c2', title: 'Docs', since: NOW }],
    heads: [{ id: 'h1', title: 'Builder', state: 'running', since: NOW, leadWaiting: false }],
    plans: [{ id: 'pl1', title: 'Ship it', since: NOW, stopped: false, readyToMerge: false, leadWaiting: false, reportReady: false }],
    limitOffers: [{ id: 'l1', provider: 'claude', since: NOW, resetsAt: NOW - 1 }],
  });
  assert.deepEqual(deriveNeedsYou([settled], NOW), []);
});

test('a head or plan whose lead is waiting is the lead\'s to answer, not the user\'s', () => {
  const items = deriveNeedsYou([facts({
    heads: [{ id: 'h1', title: 'Builder', state: 'blocked', since: NOW, leadWaiting: true }],
    plans: [{ id: 'pl1', title: 'Ship it', since: NOW, stopped: true, readyToMerge: true, leadWaiting: true, reportReady: false }],
  })], NOW);
  assert.deepEqual(items, []);
});

test('an unattended plan\'s report is only waiting while it is recent', () => {
  const plan = (since: number) => facts({ plans: [{ id: 'pl1', title: 'Overnight', since, stopped: false, readyToMerge: false, leadWaiting: false, reportReady: true }] });
  assert.equal(deriveNeedsYou([plan(NOW - reportMaxAgeMs + 1)], NOW).length, 1);
  assert.equal(deriveNeedsYou([plan(NOW - reportMaxAgeMs - 1)], NOW).length, 0);
});

test('the order holds with mixed items: clock, then decisions, then reading; oldest first inside each; nothing else moves them', () => {
  const items = deriveNeedsYou([
    facts({
      chats: [{ id: 'c1', title: 'Old read', status: 'unread', since: 1 }, { id: 'c2', title: 'New decision', status: 'needs', since: 90 }],
      heads: [{ id: 'h1', title: 'Late question', state: 'blocked', since: 100, leadWaiting: false }],
      plans: [{ id: 'pl1', title: 'Old decision', since: 10, stopped: false, readyToMerge: true, leadWaiting: false, reportReady: false }],
    }),
    { projectId: 'p2', projectName: 'Other', limitOffers: [{ id: 'l1', provider: 'codex', since: 50 }], chats: [{ id: 'c9', title: 'Newest read', status: 'unread', since: 99 }] },
  ], 1000);
  assert.deepEqual(items.map(item => `${item.projectId}/${item.sourceId}`), ['p2/l1', 'p1/h1', 'p1/pl1', 'p1/c2', 'p1/c1', 'p2/c9']);
  // The same facts in any input order give the same list.
  const shuffled = deriveNeedsYou([facts({ chats: [{ id: 'c2', title: 'New decision', status: 'needs', since: 90 }] })], 1000);
  assert.equal(compareNeedsYou(shuffled[0]!, shuffled[0]!), 0);
});

test('ids are stable and distinct across projects', () => {
  const [a, b] = deriveNeedsYou([facts({ chats: [{ id: 'c1', title: 'x', status: 'needs', since: 1 }] }), { projectId: 'p2', projectName: 'Other', chats: [{ id: 'c1', title: 'x', status: 'needs', since: 1 }] }], NOW);
  assert.notEqual(a!.id, b!.id);
  assert.equal(a!.id, deriveNeedsYou([facts({ chats: [{ id: 'c1', title: 'x', status: 'needs', since: 99 }] })], NOW + 5)[0]!.id);
});

// ---- Presence ----

test('away is an unfocused window, or five idle minutes', () => {
  assert.equal(isAway({ focused: true, idleSeconds: 0 }), false);
  assert.equal(isAway({ focused: true, idleSeconds: 299 }), false);
  assert.equal(isAway({ focused: true, idleSeconds: 300 }), true);
  assert.equal(isAway({ focused: false, idleSeconds: 0 }), true);
});

// ---- Banner text ----

test('banner text is one redacted line cut at a word boundary to about 110 characters', () => {
  assert.equal(bannerText('Fix the login page'), 'Fix the login page');
  const long = bannerText('word '.repeat(60));
  assert.ok(long.length <= 110, String(long.length));
  assert.ok(long.endsWith('…'));
  assert.ok(!/\bwor…$/.test(long), 'cut inside a word');
  assert.equal(bannerText('a'.repeat(300)).length, 110);
  assert.equal(bannerText('line one\nline two\u0007'), 'line one line two');
  const secret = 'sk-abcdefghij1234567890';
  assert.ok(!bannerText(`rotate ${secret} today`).includes(secret));
  // A secret that would straddle the cut is masked first, so no half of it survives.
  assert.ok(!bannerText(`${'x '.repeat(50)}${secret}`).includes('sk-abcdef'));
});

test('a banner names the project and the title, never a count, a question or a summary', () => {
  const [item] = deriveNeedsYou([facts({ heads: [{ id: 'h1', title: 'Builder sk-abcdefghij1234567890', state: 'blocked', since: NOW, leadWaiting: false }] })], NOW) as [NeedsYouItem];
  const banner = bannerFor(item);
  assert.equal(banner.title, 'Hydra needs you in Hydra');
  assert.ok(!banner.body.includes('sk-abcdefghij1234567890'));
  assert.equal(Object.keys(banner).sort().join(), 'body,itemId,kind,projectId,title');
  assert.ok(!/\d/.test(banner.title));
});

// ---- When banners fire ----

const chat = (id: string, status: 'needs' | 'unread' = 'unread', since = NOW) => deriveNeedsYou([facts({ chats: [{ id, title: `Chat ${id}`, status, since }] })], NOW)[0]!;
const head = (id: string) => deriveNeedsYou([facts({ heads: [{ id, title: `Head ${id}`, state: 'blocked', since: NOW, leadWaiting: false, answersAt: NOW + 20 * minute }] })], NOW)[0]!;

test('no banner while Hydra is focused and the user is active', () => {
  const banners = new AwayBanners();
  assert.equal(banners.update([chat('a', 'needs')], present), undefined);
  assert.equal(banners.update([chat('a', 'needs'), head('h')], present), undefined);
});

test('one banner for three arrivals while away', () => {
  const banners = new AwayBanners();
  const first = banners.update([chat('a')], at);
  assert.equal(first?.title, 'Hydra needs you in Hydra');
  assert.equal(first?.body, 'Chat a');
  assert.equal(banners.update([chat('a'), chat('b', 'needs')], at), undefined);
  assert.equal(banners.update([chat('a'), chat('b', 'needs'), chat('c')], at), undefined);
});

test('a blocked head after a finished chat earns a second banner, and nothing earns a third', () => {
  const banners = new AwayBanners();
  assert.ok(banners.update([chat('a')], at));
  assert.equal(banners.update([chat('a'), chat('b', 'needs')], at), undefined);
  const second = banners.update([chat('a'), chat('b', 'needs'), head('h1')], at);
  assert.equal(second?.body, 'Head h1');
  assert.equal(banners.update([chat('a'), chat('b', 'needs'), head('h1'), head('h2')], at), undefined);
  assert.equal(banners.update([chat('a'), chat('b', 'needs'), head('h1'), head('h2'), chat('d')], at), undefined);
});

test('away because idle counts, and coming back starts a new stretch', () => {
  const banners = new AwayBanners();
  const idle = { focused: true, idleSeconds: 301 };
  assert.ok(banners.update([chat('a')], idle));
  assert.equal(banners.update([chat('a'), chat('b')], idle), undefined);
  // Back at the window: the stretch ends. The item is still waiting, but it was already announced.
  assert.equal(banners.update([chat('a'), chat('b')], present), undefined);
  assert.equal(banners.update([chat('a'), chat('b')], at), undefined);
  // A new arrival in the new stretch gets its banner.
  assert.ok(banners.update([chat('a'), chat('b'), chat('c')], at));
});

test('an item that left and came back is announced again', () => {
  const banners = new AwayBanners();
  assert.ok(banners.update([chat('a')], at));
  assert.equal(banners.update([], at), undefined);
  banners.update([], present);
  assert.ok(banners.update([chat('a')], at));
});

test('a stretch begun with items already waiting banners once, for the most urgent', () => {
  const banners = new AwayBanners();
  const items = deriveNeedsYou([facts({ chats: [{ id: 'a', title: 'Read me', status: 'unread', since: 1 }], heads: [{ id: 'h', title: 'Asks', state: 'blocked', since: 5, leadWaiting: false }] })], NOW);
  assert.equal(banners.update(items, present), undefined);
  assert.equal(banners.update(items, at)?.body, 'Asks');
  assert.equal(banners.update(items, at), undefined);
});

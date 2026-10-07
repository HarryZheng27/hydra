import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent } from '../../src/core/chat/events';
import type { BannerContent, NeedsYouFacts, Presence } from '../../src/core/needsYou';
import { whenAwayOn } from '../src/shared/ipc';
import { bannerGraceMs, WhenAwayBanners } from '../src/main/needsYouBanners';
import { defaultSettings, parseSettings } from '../src/main/settings';

const done: ChatEvent = { type: 'done', status: 'success' };
const user: ChatEvent = { type: 'user', text: 'go' };
const approval: ChatEvent = { type: 'approval', id: 'a1', kind: 'tool', tool: 'Bash', input: {}, choices: ['allow', 'deny'] };
const away: Presence = { focused: false, idleSeconds: 0 };
const active: Presence = { focused: true, idleSeconds: 2 };

function setup(options: { enabled?: boolean } = {}) {
  let now = 1_000_000;
  let presence: Presence = active;
  let facts: NeedsYouFacts[] = [{ projectId: 'p1', projectName: 'Hydra' }];
  const shown: BannerContent[] = [];
  const clicks: Array<() => void> = [];
  const opened: BannerContent[] = [];
  const titles: Record<string, string> = { c1: 'Fix the login page', c2: 'Docs pass', c3: 'Third chat sk-abcdefghij1234567890' };
  const banners = new WhenAwayBanners({
    now: () => now, presence: () => presence, enabled: () => options.enabled ?? true,
    projects: () => facts,
    chat: async id => ({ title: titles[id] ?? 'A chat', cwd: 'C:\\work\\hydra\\app' }),
    known: async () => [{ id: 'p1', name: 'Hydra', path: 'C:\\work\\hydra' }],
    show: (banner, click) => { shown.push(banner); clicks.push(click); },
    open: banner => opened.push(banner),
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  return {
    banners, shown, clicks, opened,
    setPresence: (value: Presence) => { presence = value; },
    setFacts: (value: NeedsYouFacts[]) => { facts = value; },
    /** Time passes, and the banners' own timer looks again. */
    advance: async (ms: number) => { now += ms; banners.changed(); await settle(); },
    event: async (chat: string, events: ChatEvent[]) => { banners.chatEvents(chat, events, 0); await settle(); },
  };
}
const blocked = (...ids: string[]): NeedsYouFacts => ({ projectId: 'p1', projectName: 'Hydra', heads: ids.map(id => ({ id, title: id === 'h1' ? 'Builder' : `Head ${id}`, state: 'blocked', since: 0, leadWaiting: false, answersAt: 1_000_000_000 })) });

test('no banner while Hydra is focused and the user is active', async () => {
  const t = setup();
  await t.event('c1', [user, approval]);
  t.setFacts([blocked('h1')]);
  await t.advance(bannerGraceMs + 1);
  await t.advance(60_000);
  assert.deepEqual(t.shown, []);
});

test('one banner for three arrivals while away, naming the project and the chat, never a count', async () => {
  const t = setup();
  t.setPresence(away);
  await t.event('c1', [user, done]);
  await t.advance(bannerGraceMs);
  assert.equal(t.shown.length, 1);
  assert.equal(t.shown[0]!.title, 'Hydra needs you in Hydra');
  assert.equal(t.shown[0]!.body, 'Fix the login page');
  await t.event('c2', [user, approval]);
  await t.event('c3', [user, done]);
  await t.advance(bannerGraceMs * 3);
  assert.equal(t.shown.length, 1);
});

test('a blocked head after a finished chat earns a second banner, and nothing earns a third', async () => {
  const t = setup();
  t.setPresence(away);
  await t.event('c1', [user, done]);
  await t.advance(bannerGraceMs);
  assert.equal(t.shown.length, 1);
  t.setFacts([blocked('h1')]);
  await t.advance(bannerGraceMs);
  assert.equal(t.shown.length, 2);
  assert.equal(t.shown[1]!.body, 'Builder');
  t.setFacts([blocked('h1', 'h2')]);
  await t.event('c2', [user, done]);
  await t.advance(bannerGraceMs * 3);
  assert.equal(t.shown.length, 2);
});

test('the banner text is redacted and holds no question text', async () => {
  const t = setup();
  t.setPresence(away);
  await t.event('c3', [user, { type: 'question', id: 'q1', questions: [{ question: 'Should I drop the users table?', header: 'Drop', options: [], multiSelect: false }] } as ChatEvent]);
  t.setFacts([blocked('h1')]);
  await t.advance(bannerGraceMs);
  const text = JSON.stringify(t.shown);
  assert.ok(t.shown.length >= 1);
  assert.ok(!text.includes('sk-abcdefghij1234567890'), text);
  assert.ok(!text.includes('users table'), text);
  assert.ok(!/\b\d+ (things|items|chats|heads)\b/.test(text));
});

test('a head whose lead is waiting is never bannered', async () => {
  const t = setup();
  t.setPresence(away);
  t.setFacts([{ projectId: 'p1', projectName: 'Hydra', heads: [{ id: 'h1', title: 'Builder', state: 'blocked', since: 0, leadWaiting: true }] }]);
  await t.advance(bannerGraceMs * 3);
  assert.deepEqual(t.shown, []);
});

test('a chat that finished while the user was at the window is not something to come back to', async () => {
  const t = setup();
  await t.event('c1', [user, done]);
  t.setPresence(away);
  await t.advance(bannerGraceMs * 3);
  assert.deepEqual(t.shown, []);
});

test('coming back clears what finished while away', async () => {
  const t = setup();
  t.setPresence(away);
  await t.event('c1', [user, done]);
  t.setPresence(active);
  await t.advance(bannerGraceMs * 2);
  t.setPresence(away);
  await t.advance(bannerGraceMs * 2);
  assert.deepEqual(t.shown, []);
});

test('idle for five minutes counts as away even with Hydra focused', async () => {
  const t = setup();
  await t.event('c1', [user, approval]);
  t.setPresence({ focused: true, idleSeconds: 300 });
  await t.advance(bannerGraceMs);
  assert.equal(t.shown.length, 1);
});

test('clicking the banner opens what it was about', async () => {
  const t = setup();
  t.setPresence(away);
  await t.event('c1', [user, approval]);
  await t.advance(bannerGraceMs);
  t.clicks[0]!();
  assert.equal(t.opened[0]?.kind, 'chat-needs');
  assert.equal(t.opened[0]?.sourceId, 'c1');
  assert.equal(t.opened[0]?.projectId, 'p1');
});

test('notifications.whenAway is on by default, and turned off, shows nothing', async () => {
  assert.equal(whenAwayOn(defaultSettings()), true);
  assert.equal(whenAwayOn({ ...defaultSettings(), notifications: { whenAway: false } }), false);
  assert.deepEqual(parseSettings({ version: 1, theme: 'dark', cliPaths: {}, notifications: { whenAway: false } })?.notifications, { whenAway: false });
  for (const bad of [{ whenAway: 'no' }, { other: true }, 'on']) assert.equal(parseSettings({ version: 1, theme: 'dark', cliPaths: {}, notifications: bad }), undefined);
  const t = setup({ enabled: false });
  t.setPresence(away);
  await t.event('c1', [user, approval]);
  await t.advance(bannerGraceMs * 3);
  assert.deepEqual(t.shown, []);
});

test('startup feeds every chat event and tree change to the banners', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'startup.ts'), 'utf8');
  assert.match(source, /whenAway\.chatEvents\(chatId, events, start\)/);
  assert.match(source, /HYDRA_TREE, message\); whenAway\.changed\(\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/core/model';
import { deriveNeedsYou, type NeedsYouFacts, type NeedsYouItem } from '../src/core/needsYou';
import { clampCursor, emptyNeedsYou, keyStep, kindLabel, openAction, optionAction, primaryAction, primaryLabel, putOffChoices, putOffKey, PutOffs, replyAction, timeLeft, type ListState } from '../src/core/needsYouList';

const NOW = 1_000_000_000;
const minute = 60_000;
const facts = (extra: Partial<NeedsYouFacts> = {}): NeedsYouFacts => ({ projectId: 'p1', projectName: 'Hydra', ...extra });
const HEAD = 'abcdef012345', LANE = '0123456789ab';

const question = deriveNeedsYou([facts({ heads: [{ id: HEAD, title: 'Builder', state: 'blocked', since: NOW, leadWaiting: false, answersAt: NOW + 20 * minute, question: 'Which store?', options: [{ option: 1, text: 'Postgres', recommended: true }, { option: 2, text: 'SQLite' }] }] })], NOW)[0]!;
const merge = deriveNeedsYou([facts({ plans: [{ id: 'aabbccddee11', title: 'Ship it', since: NOW, stopped: false, readyToMerge: true, leadWaiting: false, reportReady: false, gate: 'Passed', branch: 'hydra/ship' }] })], NOW)[0]!;
const lane = deriveNeedsYou([facts({ lanes: [{ id: LANE, name: 'Checkout', since: NOW, attention: 'waiting' }] })], NOW)[0]!;

const sample = (): NeedsYouItem[] => deriveNeedsYou([facts({
  chats: [{ id: 'c1', title: 'A chat', status: 'needs', since: NOW - 5 }],
  heads: [{ id: HEAD, title: 'Builder', state: 'blocked', since: NOW - 6, leadWaiting: false, options: [{ option: 1, text: 'One', recommended: true }, { option: 2, text: 'Two' }] }],
  plans: [{ id: 'aabbccddee11', title: 'Ship it', since: NOW - 4, stopped: false, readyToMerge: true, leadWaiting: false, reportReady: false }],
  lanes: [{ id: LANE, name: 'Checkout', since: NOW - 3, attention: 'waiting' }],
})], NOW);

test('every primary action is a message the canvas already sends, so it takes the same controller path', () => {
  const stopped = deriveNeedsYou([facts({ plans: [{ id: 'aabbccddee11', title: 'Stuck', since: NOW, stopped: true, readyToMerge: false, leadWaiting: false, reportReady: false }] })], NOW)[0]!;
  const gates = deriveNeedsYou([facts({ lanes: [{ id: LANE, name: 'Checkout', since: NOW, failedGates: ['unit'] }] })], NOW)[0]!;
  const finished = deriveNeedsYou([facts({ finishedHeads: [{ id: HEAD, title: 'Builder', since: NOW }] })], NOW)[0]!;
  const report = deriveNeedsYou([facts({ plans: [{ id: 'aabbccddee11', title: 'Overnight', since: NOW, stopped: false, readyToMerge: false, leadWaiting: false, reportReady: true }] })], NOW)[0]!;
  const limit = deriveNeedsYou([facts({ limitOffers: [{ id: 'claude:2026-10-07T12:00:00.000Z', provider: 'claude', since: NOW, resetsAt: NOW + minute }] })], NOW)[0]!;
  const chat = deriveNeedsYou([facts({ chats: [{ id: 'c1', title: 'A chat', status: 'needs', since: NOW }] })], NOW)[0]!;
  // The canvas's: "Answer question…" is helperAnswer, a head chip opens helperReview, Retry failed jobs is planRetryJobs, Merge plan is planMerge via merge.
  assert.deepEqual(primaryAction(question), { kind: 'send', message: { type: 'helperAnswer', jobId: HEAD } });
  assert.deepEqual(primaryAction(finished), { kind: 'send', message: { type: 'helperReview', jobId: HEAD } });
  assert.deepEqual(primaryAction(stopped), { kind: 'send', message: { type: 'planRetryJobs', id: 'aabbccddee11' } });
  assert.deepEqual(primaryAction(gates), { kind: 'send', message: { type: 'laneAction', id: LANE, action: 'sendGates' } });
  assert.deepEqual(primaryAction(report), { kind: 'send', message: { type: 'planReport', id: 'aabbccddee11' } });
  assert.deepEqual(primaryAction(limit), { kind: 'send', message: { type: 'limitContinue', id: 'claude:2026-10-07T12:00:00.000Z' } });
  assert.deepEqual(primaryAction(chat), { kind: 'chat', chatId: 'c1' });
  assert.deepEqual(primaryAction(lane), { kind: 'open', view: 'lanes', focus: LANE });
  // Each is a message the host parses, so the controller's own checks apply to it.
  for (const item of [question, finished, stopped, gates, report, limit]) {
    const action = primaryAction(item);
    assert.equal(action.kind, 'send');
    if (action.kind === 'send') assert.deepEqual(parseMessage(JSON.parse(JSON.stringify(action.message))), action.message);
  }
  for (const kind of Object.keys(kindLabel)) assert.ok(primaryLabel[kind as keyof typeof primaryLabel], `${kind} has a primary label`);
});

test('a merge is never one key: the primary action asks first, and what it asks to send is the canvas\'s Merge plan', () => {
  const action = primaryAction(merge);
  assert.equal(action.kind, 'confirm');
  if (action.kind === 'confirm') {
    assert.deepEqual(action.message, { type: 'planMerge', id: 'aabbccddee11', via: 'merge' });
    assert.match(action.question, /Ship it/);
  }
  // E asks, Enter opens, and neither sends the merge.
  const asked = keyStep({ cursor: 0 }, [merge], 'e');
  assert.equal(asked.effect, undefined);
  assert.equal(asked.state.confirming, merge.id);
  const opened = keyStep({ cursor: 0 }, [merge], 'Enter');
  assert.equal(opened.effect?.kind, 'action');
  if (opened.effect?.kind === 'action') assert.notEqual(opened.effect.action.kind, 'send');
  // Nothing else, from any state, sends it: not 1-4, R, L, Z or a second E.
  for (const key of ['1', '2', '3', '4', 'r', 'l', 'z', 'e', 'Enter', 'j', 'k', 'ArrowDown', 'Escape', ' ', 'x']) {
    for (const state of [{ cursor: 0 }, asked.state] as ListState[]) {
      const result = keyStep(state, [merge], key);
      assert.ok(!(result.effect?.kind === 'action' && result.effect.action.kind !== 'open'), `${key} must not run a merge`);
    }
  }
});

test('J/K and the arrows move, and stop at the ends', () => {
  const items = sample();
  assert.equal(keyStep({ cursor: 0 }, items, 'j').state.cursor, 1);
  assert.equal(keyStep({ cursor: 1 }, items, 'ArrowDown').state.cursor, 2);
  assert.equal(keyStep({ cursor: 1 }, items, 'k').state.cursor, 0);
  assert.equal(keyStep({ cursor: 0 }, items, 'ArrowUp').state.cursor, 0);
  assert.equal(keyStep({ cursor: items.length - 1 }, items, 'J').state.cursor, items.length - 1);
});

test('1 to 4 pick an option on a head\'s question, R replies in words, Enter opens', () => {
  assert.deepEqual(optionAction(question, 2), { kind: 'send', message: { type: 'headOption', jobId: HEAD, option: 2 } });
  assert.equal(optionAction(question, 3), undefined); // it offered two
  assert.equal(optionAction(lane, 1), undefined);
  assert.deepEqual(replyAction(question), { kind: 'send', message: { type: 'helperReply', jobId: HEAD } });
  assert.equal(replyAction(merge), undefined);
  const items = [question];
  const pick = keyStep({ cursor: 0 }, items, '1');
  assert.deepEqual(pick.effect, { kind: 'action', item: question, action: { kind: 'send', message: { type: 'headOption', jobId: HEAD, option: 1 } } });
  assert.equal(keyStep({ cursor: 0 }, items, '4').handled, false);
  assert.equal(keyStep({ cursor: 0 }, items, 'r').effect?.kind, 'action');
  assert.deepEqual(openAction(question), { kind: 'open', view: 'canvas', focus: HEAD });
  assert.deepEqual(keyStep({ cursor: 0 }, [lane], 'Enter').effect, { kind: 'action', item: lane, action: { kind: 'open', view: 'lanes', focus: LANE } });
});

test('L opens the put-off menu, a number picks how long, and Z undoes', () => {
  const items = sample();
  const menu = keyStep({ cursor: 1 }, items, 'l');
  assert.equal(menu.state.menu, items[1]!.id);
  const picked = keyStep(menu.state, items, '2');
  assert.deepEqual(picked.effect, { kind: 'putOff', item: items[1], ms: putOffChoices[1]!.ms });
  assert.equal(picked.state.menu, undefined);
  // With the menu open, the other keys don't act on the item.
  assert.equal(keyStep(menu.state, items, 'e').effect, undefined);
  assert.equal(keyStep(menu.state, items, 'Escape').state.menu, undefined);
  assert.deepEqual(keyStep({ cursor: 0 }, items, 'z').effect, { kind: 'undo' });
  assert.deepEqual(keyStep({ cursor: 0 }, [], 'z').effect, { kind: 'undo' });
  assert.equal(keyStep({ cursor: 0 }, [], 'j').handled, false);
});

test('the cursor stays on the same item when the list changes', () => {
  const items = sample();
  assert.equal(clampCursor(items, 0, items[2]!.id), 2);
  assert.equal(clampCursor(items.slice(0, 2), 3, 'gone'), 1);
  assert.equal(clampCursor([], 5), 0);
});

test('put-off items come back at their time, and Z brings back the last one at once', () => {
  const items = sample();
  const a = items[0]!, b = items[1]!;
  const putOffs = new PutOffs();
  putOffs.putOff(putOffKey(a), NOW + 60 * minute);
  putOffs.putOff(putOffKey(b), NOW + 4 * 60 * minute);
  assert.deepEqual(putOffs.visible(items, NOW).map(item => item.id), items.slice(2).map(item => item.id));
  assert.equal(putOffs.nextReturn(NOW), NOW + 60 * minute);
  // An hour on, the first is back and the second still isn't.
  assert.ok(putOffs.visible(items, NOW + 60 * minute + 1).some(item => item.id === a.id));
  assert.ok(!putOffs.visible(items, NOW + 60 * minute + 1).some(item => item.id === b.id));
  // Z: the last put off, and then the one before; an expired one isn't brought back as if it were still off.
  assert.equal(putOffs.undo(NOW), putOffKey(b));
  assert.ok(putOffs.visible(items, NOW).some(item => item.id === b.id));
  assert.equal(putOffs.undo(NOW), putOffKey(a));
  assert.equal(putOffs.undo(NOW), undefined);
  putOffs.putOff(putOffKey(a), NOW + 10);
  assert.equal(putOffs.undo(NOW + 20), undefined);
});

test('put-offs are kept as plain data, and a bad or stale value is no put-offs', () => {
  const putOffs = new PutOffs();
  putOffs.putOff('chat-needs:c1', NOW + minute);
  putOffs.putOff('lane-waiting:x', NOW - 1);
  const stored = JSON.parse(JSON.stringify(putOffs));
  const back = PutOffs.parse(stored, NOW);
  assert.deepEqual(back.toJSON(), [{ id: 'chat-needs:c1', until: NOW + minute }]); // the ended one is dropped
  assert.deepEqual(PutOffs.parse(JSON.stringify(stored), NOW).toJSON(), back.toJSON());
  for (const bad of [undefined, null, 5, 'not json', { id: 'x' }, [null, 3, { id: 4, until: NOW + 1 }, { id: 'a', until: 'soon' }, { id: 'b', until: Number.NaN }]]) assert.deepEqual(PutOffs.parse(bad, NOW).toJSON(), []);
  // A put-off is by kind and source, so it survives the project's id being known differently on each side.
  assert.equal(putOffKey(lane), `lane-waiting:${LANE}`);
  const other = deriveNeedsYou([facts({ projectId: 'other', lanes: [{ id: LANE, name: 'Checkout', since: NOW, attention: 'waiting' }] })], NOW)[0]!;
  assert.equal(putOffKey(other), putOffKey(lane));
});

test('the empty state and the clock read plainly', () => {
  assert.equal(emptyNeedsYou, 'Nothing needs you.');
  assert.equal(timeLeft(NOW + 30_000, NOW), '30s');
  assert.equal(timeLeft(NOW + 12 * minute, NOW), '12m');
  assert.equal(timeLeft(NOW + 65 * minute, NOW), '1h 05m');
  assert.equal(timeLeft(NOW - 5, NOW), '0s');
});

test('the messages the list adds are checked like every other from the view', () => {
  assert.deepEqual(parseMessage({ type: 'headOption', jobId: HEAD, option: 3 }), { type: 'headOption', jobId: HEAD, option: 3 });
  for (const option of [0, 5, 1.5, '1', undefined]) assert.throws(() => parseMessage({ type: 'headOption', jobId: HEAD, option }));
  assert.throws(() => parseMessage({ type: 'headOption', jobId: 'nope', option: 1 }));
  assert.deepEqual(parseMessage({ type: 'helperReply', jobId: HEAD }), { type: 'helperReply', jobId: HEAD });
  assert.deepEqual(parseMessage({ type: 'planReport', id: 'aabbccddee11' }), { type: 'planReport', id: 'aabbccddee11' });
  assert.throws(() => parseMessage({ type: 'planReport', id: '../x' }));
  assert.deepEqual(parseMessage({ type: 'limitContinue', id: 'claude:2026-10-07T12:00:00.000Z' }), { type: 'limitContinue', id: 'claude:2026-10-07T12:00:00.000Z' });
  assert.throws(() => parseMessage({ type: 'limitContinue', id: 'claude; rm -rf' }));
  assert.deepEqual(parseMessage({ type: 'laneAction', id: LANE, action: 'sendGates' }), { type: 'laneAction', id: LANE, action: 'sendGates' });
  assert.deepEqual(parseMessage({ type: 'view', view: 'needs' }), { type: 'view', view: 'needs' });
  const until = Date.now() + 60 * minute;
  assert.deepEqual(parseMessage({ type: 'needsYouPutOff', key: `lane-waiting:${LANE}`, until }), { type: 'needsYouPutOff', key: `lane-waiting:${LANE}`, until });
  assert.throws(() => parseMessage({ type: 'needsYouPutOff', key: 'lane-waiting:x', until: Date.now() - 1 }));
  assert.throws(() => parseMessage({ type: 'needsYouPutOff', key: 'lane-waiting:x', until: Date.now() + 365 * 24 * 60 * minute }));
  assert.throws(() => parseMessage({ type: 'needsYouPutOff', key: 'bad key', until }));
  assert.deepEqual(parseMessage({ type: 'needsYouUndo', key: `lane-waiting:${LANE}` }), { type: 'needsYouUndo', key: `lane-waiting:${LANE}` });
});

test('an SSR render of the Needs you tab shows each kind, a head\'s options, the clock and the empty state', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { NeedsYouView } = await import('../webview/NeedsYouView');
  const items = deriveNeedsYou([facts({
    chats: [{ id: 'c1', title: 'Fix login', status: 'needs', since: NOW - 5 }],
    heads: [{ id: HEAD, title: 'Builder', state: 'blocked', since: NOW - 6, leadWaiting: false, answersAt: NOW + 12 * minute, question: 'Which store?', options: [{ option: 1, text: 'Postgres', recommended: true }, { option: 2, text: 'SQLite' }] }],
    lanes: [{ id: LANE, name: 'Checkout', since: NOW, failedGates: ['unit'] }],
  })], NOW);
  const noop = () => undefined;
  const html = renderToStaticMarkup(React.createElement(NeedsYouView, { items, onAction: noop, onPutOff: noop, onUndo: noop, clock: () => NOW }));
  assert.match(html, /Question/); assert.match(html, /Hydra answers in 12m/); assert.match(html, /Which store\?/);
  assert.match(html, /Postgres/); assert.match(html, /recommended/); assert.match(html, /SQLite/);
  assert.match(html, /Chat waiting/); assert.match(html, /Fix login/);
  assert.match(html, /Gates failed/); assert.match(html, /Gates failed: unit/);
  assert.match(html, /Answer/); // the selected item's primary action
  assert.doesNotMatch(html, /Nothing needs you/);
  const empty = renderToStaticMarkup(React.createElement(NeedsYouView, { items: [], onAction: noop, onPutOff: noop, onUndo: noop, clock: () => NOW }));
  assert.match(empty, /Nothing needs you\./);
});

test('the Agents body shows the Needs you tab with its count, only when it has the items', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsBody } = await import('../webview/AgentsBody');
  const props = { view: 'needs' as const, onViewChange: () => undefined, heads: [], terminals: true, onLaneFocused: () => undefined, onAction: () => undefined, onOpenLane: () => undefined, onSend: () => undefined };
  const with_ = renderToStaticMarkup(React.createElement(AgentsBody, { ...props, needsYou: sampleItems() }));
  assert.match(with_, /Needs you <span class="agents-view-count">2<\/span>/);
  assert.match(with_, /role="tab" aria-selected="true" class="on"[^>]*>Needs you/);
  const without = renderToStaticMarkup(React.createElement(AgentsBody, { ...props, view: 'canvas' as const }));
  assert.doesNotMatch(without, /Needs you/);
});
const sampleItems = () => deriveNeedsYou([facts({ chats: [{ id: 'c1', title: 'A chat', status: 'needs', since: NOW }], lanes: [{ id: LANE, name: 'Checkout', since: NOW, attention: 'waiting' }] })], NOW);

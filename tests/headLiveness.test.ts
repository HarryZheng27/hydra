import test from 'node:test';
import assert from 'node:assert/strict';
import { headSilenceLimits, headSilenceStep, headSilentMs, StreamActivity } from '../src/core/headSilence';
import { describeProviderWait, providerWaitLabel, ProviderWaitTracker, validateProviderWait, type ProviderWait } from '../src/core/providerWait';
import { buildPlanReport, type Plan, type PlanReportJobDetail } from '../src/core/plans';
import { noAnswerReply, unattendedAnswer } from '../src/core/helperService';

/** A head's liveness (docs/Heads.md, "When nobody answers" and "A silent head"): the pure pieces, with an injected clock. */

const assistant = (...content: Record<string, unknown>[]) => ({ type: 'assistant', message: { role: 'assistant', content } });
const user = (...content: Record<string, unknown>[]) => ({ type: 'user', message: { role: 'user', content } });

test('Claude: a tool_use without its tool_result is in flight; a result ends the turn', () => {
  let clock = 1000;
  const activity = new StreamActivity(() => clock);
  assert.deepEqual(activity.snapshot(), { lastLineAt: 1000, toolsInFlight: 0, turnOpen: false });
  clock = 2000; activity.turnStarted();
  assert.deepEqual(activity.snapshot(), { lastLineAt: 2000, toolsInFlight: 0, turnOpen: true });
  clock = 3000; activity.observeClaude(assistant({ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }));
  assert.deepEqual(activity.snapshot(), { lastLineAt: 3000, toolsInFlight: 1, turnOpen: true });
  // Two tools at once (a parallel call): one answered is not both.
  activity.observeClaude(assistant({ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }));
  clock = 4000; activity.observeClaude(user({ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }));
  assert.equal(activity.snapshot().toolsInFlight, 1);
  activity.observeClaude(user({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'pass' }));
  assert.equal(activity.snapshot().toolsInFlight, 0);
  // Malformed content is ignored, not thrown on.
  activity.observeClaude({ type: 'assistant', message: { content: 'text' } });
  activity.observeClaude(assistant({ type: 'tool_use', name: 'no id' }));
  assert.equal(activity.snapshot().toolsInFlight, 0);
  activity.observeClaude(assistant({ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: {} }));
  clock = 5000; activity.observeClaude({ type: 'result', subtype: 'success' });
  assert.deepEqual(activity.snapshot(), { lastLineAt: 5000, toolsInFlight: 0, turnOpen: false });
  // A nudge's turn isn't fresh: the silence it answers keeps its start.
  clock = 9000; activity.turnStarted(false);
  assert.deepEqual(activity.snapshot(), { lastLineAt: 5000, toolsInFlight: 0, turnOpen: true });
});

test('Codex: an item started and not completed is in flight; its own messages and reasoning are not', () => {
  let clock = 0;
  const activity = new StreamActivity(() => clock);
  activity.turnStarted();
  clock = 10; activity.observeCodex({ type: 'item.started', item: { id: 'item_0', type: 'reasoning' } });
  activity.observeCodex({ type: 'item.started', item: { id: 'item_1', type: 'agent_message' } });
  assert.equal(activity.snapshot().toolsInFlight, 0);
  activity.observeCodex({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'npm test', status: 'in_progress' } });
  assert.deepEqual(activity.snapshot(), { lastLineAt: 10, toolsInFlight: 1, turnOpen: true });
  clock = 20; activity.observeCodex({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', exit_code: 0 } });
  assert.deepEqual(activity.snapshot(), { lastLineAt: 20, toolsInFlight: 0, turnOpen: true });
  activity.observeCodex({ type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call' } });
  activity.turnEnded();
  assert.deepEqual(activity.snapshot(), { lastLineAt: 20, toolsInFlight: 0, turnOpen: false });
});

test('silence counts only with a turn open and no tool in flight; the steps are record, nudge, fail', () => {
  assert.equal(headSilentMs(undefined, 10), undefined);
  assert.equal(headSilentMs({ lastLineAt: 0, toolsInFlight: 1, turnOpen: true }, 3_600_000), undefined, 'a long npm test is not silence');
  assert.equal(headSilentMs({ lastLineAt: 0, toolsInFlight: 0, turnOpen: false }, 3_600_000), undefined, 'between turns is not silence');
  assert.equal(headSilentMs({ lastLineAt: 1000, toolsInFlight: 0, turnOpen: true }, 181_000), 180_000);
  assert.equal(headSilentMs({ lastLineAt: 5000, toolsInFlight: 0, turnOpen: true }, 1000), 0, 'never negative');
  assert.deepEqual(headSilenceLimits, { waitMs: 180_000, nudgeMs: 300_000, failMs: 600_000 });
  const none = { recorded: false, nudged: false };
  assert.equal(headSilenceStep(undefined, none), undefined);
  assert.equal(headSilenceStep(179_999, none), undefined);
  assert.equal(headSilenceStep(180_000, none), 'record');
  assert.equal(headSilenceStep(200_000, { recorded: true, nudged: false }), undefined, 'recorded once');
  assert.equal(headSilenceStep(300_000, { recorded: true, nudged: false }), 'nudge');
  assert.equal(headSilenceStep(300_000, none), 'nudge', 'a coarse tick that skipped the wait still nudges (and the caller records)');
  assert.equal(headSilenceStep(400_000, { recorded: true, nudged: true }), undefined, 'nudged once');
  assert.equal(headSilenceStep(600_000, { recorded: true, nudged: true }), 'fail');
  assert.equal(headSilenceStep(60_000, none, { waitMs: 10_000, nudgeMs: 20_000, failMs: 50_000 }), 'fail', 'limits are configurable');
});

test('a silent stream is a wait on the provider: dated from the last line, closed by the next one', () => {
  let clock = Date.parse('2026-09-29T10:00:00.000Z');
  const events: [ProviderWait | undefined, number][] = [];
  const tracker = new ProviderWaitTracker((wait, waitedMs) => events.push([wait, waitedMs]), () => clock);
  tracker.quiet();
  tracker.observe({ kind: 'resume' });
  clock += 180_000;
  tracker.stall();
  assert.deepEqual(events, [[{ since: '2026-09-29T10:00:00.000Z', retries: 0, silent: true }, 0]]);
  tracker.stall();
  assert.equal(events.length, 1, 'a second stall adds nothing');
  const wait = tracker.current!;
  assert.equal(providerWaitLabel('claude', wait, clock), 'No response from Claude for 3m');
  assert.equal(providerWaitLabel('codex', wait, clock + 60_000), 'No response from Codex for 4m');
  assert.equal(describeProviderWait('claude', wait, clock).silent, true);
  assert.deepEqual(validateProviderWait(wait), wait);
  assert.equal(validateProviderWait({ ...wait, silent: 'yes' })?.silent, undefined);
  clock += 60_000;
  // A limit note isn't a retry, but it is a line: the silence is over.
  tracker.observe({ kind: 'note', detail: '5-hour limit 40% used' });
  assert.deepEqual(events.at(-1), [undefined, 240_000]);
  assert.equal(tracker.current, undefined);
});

test('a retry notice after a silence turns it into an ordinary wait from the same start; stall adds nothing to a retry wait', () => {
  let clock = Date.parse('2026-09-29T10:00:00.000Z');
  const events: [ProviderWait | undefined, number][] = [];
  const tracker = new ProviderWaitTracker((wait, waitedMs) => events.push([wait, waitedMs]), () => clock);
  tracker.quiet();
  clock += 200_000; tracker.stall();
  clock += 10_000; tracker.observe({ kind: 'retry', limit: true, attempt: 1, maxRetries: 10, detail: 'rate limit, HTTP 429' });
  assert.deepEqual(tracker.current, { since: '2026-09-29T10:00:00.000Z', retries: 1, attempt: 1, maxRetries: 10, limit: true, detail: 'rate limit, HTTP 429' });
  const before = events.length;
  tracker.stall();
  assert.equal(events.length, before);
  clock += 5_000; tracker.observe({ kind: 'resume' });
  assert.deepEqual(events.at(-1), [undefined, 215_000]);
});

test('what a head is told when nobody answers', () => {
  assert.match(unattendedAnswer, /^Nobody is watching this plan, so no one will answer\. Decide within your scope and brief\. If something outside your write scope needs changing, finish your own part and describe what needs changing in hydra_done's summary\. Then call hydra_done\.$/);
  assert.match(noAnswerReply('timeout', 20 * 60_000), /^No answer came within 20m, so carry on without one\./);
  assert.match(noAnswerReply('ended', 0), /^Your question's call ended before anyone answered, so carry on without one\./);
});

test('the plan report says which questions were answered automatically, and lists them under Needs you', () => {
  const plan = { id: 'p'.repeat(12), title: 'Nightly', state: 'done', unattended: { maxJobs: 2 }, startedAt: '2026-01-01T00:00:00.000Z', jobs: [], amendments: [] } as unknown as Plan;
  const details: PlanReportJobDetail[] = [
    { key: 'finish', title: 'Finish up', status: 'done', provider: 'claude', summary: 'Done; a leftover in src/other/ needs deleting.', autoAnswered: [{ at: '2026-01-01T00:05:28.000Z', why: 'unattended', question: 'May I delete the leftover?' }] },
    { key: 'late', title: 'Late answer', status: 'done', provider: 'codex', autoAnswered: [{ at: '2026-01-01T00:30:00.000Z', why: 'no-answer' }] },
    { key: 'plain', title: 'Plain', status: 'done', provider: 'claude' },
  ];
  const report = buildPlanReport(plan, details, 5);
  assert.match(report, /## Finish up[\s\S]*Asked "May I delete the leftover\?" and was answered automatically: nobody is watching this plan, so it decided within its brief\./);
  assert.match(report, /## Late answer[\s\S]*Asked a question and was answered automatically: no answer came in time, so it decided within its brief\./);
  assert.doesNotMatch(report.split('## Plain')[1]!.split('## Integration gate')[0]!, /answered automatically/);
  const needs = report.split('## Needs you')[1]!;
  assert.match(needs, /- Finish up: its question was answered automatically; check its summary for anything it left outside its scope\./);
  assert.match(needs, /- Late answer: its question was answered automatically/);
  assert.doesNotMatch(needs, /Plain/);
});

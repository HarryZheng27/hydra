import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeNudge, claudeSilenceLimits, claudeStreamLine, codexSilenceLimits, headSilenceLimits, headSilenceStep, headSilentMs, StreamActivity } from '../src/core/headSilence';
import { describeProviderWait, providerWaitLabel, ProviderWaitTracker, validateProviderWait, type ProviderWait } from '../src/core/providerWait';
import { buildPlanReport, type Plan, type PlanReportJobDetail } from '../src/core/plans';
import { noAnswerReply, unattendedAnswer } from '../src/core/helperService';

/** A head's liveness (docs/Heads.md, "When nobody answers" and "A silent head"): the pure pieces, with an injected clock. */

const assistant = (...content: Record<string, unknown>[]) => ({ type: 'assistant', message: { role: 'assistant', content } });
const user = (...content: Record<string, unknown>[]) => ({ type: 'user', message: { role: 'user', content } });

test('Claude: a tool_use without its tool_result is in flight; a result ends the turn', () => {
  let clock = 1000;
  const activity = new StreamActivity(() => clock);
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 1000, toolsInFlight: 0, turnOpen: false });
  clock = 2000; activity.turnStarted();
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 2000, toolsInFlight: 0, turnOpen: true });
  clock = 3000; activity.observeClaude(assistant({ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }));
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 3000, toolsInFlight: 1, turnOpen: true });
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
  clock = 5000; assert.equal(activity.observeClaude({ type: 'result', subtype: 'success' }), false, 'a result is not model output');
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 4000, toolsInFlight: 0, turnOpen: false });
  // A nudge's turn isn't fresh: the silence it answers keeps its start.
  clock = 9000; activity.turnStarted(false);
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 4000, toolsInFlight: 0, turnOpen: true });
});

test('Claude: only model output counts; the lines a nudge causes, init and rate-limit notes do not', () => {
  let clock = 0;
  const activity = new StreamActivity(() => clock);
  activity.turnStarted();
  for (const line of [
    { type: 'control_response', response: { subtype: 'success', request_id: 'hydra-helper-nudge-1' } },
    { type: 'result', subtype: 'error_during_execution', is_error: true },
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  ]) { clock += 1000; assert.equal(activity.observeClaude(line), false, JSON.stringify(line)); }
  assert.equal(activity.snapshot().lastOutputAt, 0);
  // A partial-message chunk (--include-partial-messages) is output: a long Write being generated is not silence.
  clock = 7000; assert.equal(activity.observeClaude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"content":"' } } }), true);
  assert.equal(activity.snapshot().lastOutputAt, 7000);
  clock = 8000; assert.equal(activity.observeClaude({ type: 'system', subtype: 'api_retry', attempt: 1 }), true, 'a retry notice: the CLI is working on it');
  assert.equal(activity.snapshot().lastOutputAt, 8000);
});

/** What Claude Code 2.1.282 really sends after Hydra's interrupt, in order (from a live run against the CLI). */
const interruptLines = (id: string) => [
  { type: 'control_response', response: { subtype: 'success', request_id: id, response: { still_queued: [] } } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I\'ll finish up n' }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' },
];

test('Claude, replayed from the real CLI: a nudge\'s interrupt lines are not output, so a head still silent after it fails at 10 minutes', () => {
  let clock = 0;
  const activity = new StreamActivity(() => clock);
  const sent: string[] = [];
  const nudge = new ClaudeNudge(text => { sent.push(text); activity.turnStarted(false); });
  activity.turnStarted();
  clock = 1000; assert.deepEqual(claudeStreamLine(activity, nudge, { type: 'assistant', message: { content: [{ type: 'text', text: 'I\'ll finish up now.' }] } }), { held: false, output: true, turnEnd: false });
  const done = { recorded: false, nudged: false };
  // Silent: recorded at 3m, nudged at 5m.
  clock = 1000 + 5 * 60_000;
  assert.equal(headSilenceStep(headSilentMs(activity.snapshot(), clock), done), 'nudge');
  done.recorded = done.nudged = true;
  nudge.started('hydra-helper-nudge-1', 'continue');
  const seen = interruptLines('hydra-helper-nudge-1').map(line => { clock += 200; return claudeStreamLine(activity, nudge, line); });
  assert.deepEqual(seen, [
    { held: true, output: false, turnEnd: false },
    { held: true, output: false, turnEnd: false },
    { held: true, output: false, turnEnd: false },
    { held: false, output: false, turnEnd: false },
  ], 'the interrupted turn\'s result is no turn end to report');
  assert.deepEqual(sent, ['continue']);
  // Then the "continue" turn opens with system init, and the head stays hung.
  clock += 200; assert.deepEqual(claudeStreamLine(activity, nudge, { type: 'system', subtype: 'init', session_id: 's' }), { held: false, output: false, turnEnd: false });
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 1000, toolsInFlight: 0, turnOpen: true }, 'the silence still dates from the last real output');
  clock = 1000 + 9 * 60_000;
  assert.equal(headSilenceStep(headSilentMs(activity.snapshot(), clock), done), undefined, 'no second nudge');
  clock = 1000 + 10 * 60_000;
  assert.equal(headSilenceStep(headSilentMs(activity.snapshot(), clock), done), 'fail');
  // Had the model come back, its output counts again, and a real turn end is reported.
  clock += 1000; assert.equal(claudeStreamLine(activity, nudge, { type: 'assistant', message: { content: [{ type: 'text', text: 'Continuing.' }] } }).output, true);
  assert.deepEqual(claudeStreamLine(activity, nudge, { type: 'result', subtype: 'success' }), { held: false, output: false, turnEnd: true });
});

test('Claude: a user line is output only with a tool_result in it', () => {
  const activity = new StreamActivity(() => 5);
  assert.equal(activity.observeClaude({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), false);
  assert.equal(activity.observeClaude({ type: 'user', message: { content: 'plain' } }), false);
  assert.equal(activity.observeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }), true);
});

test('Claude nudge: the "continue" message waits for the interrupted turn\'s result, which is not a turn end; a later real one is', () => {
  const sent: string[] = [];
  const nudge = new ClaudeNudge(text => sent.push(text));
  assert.equal(nudge.result(), false, 'no nudge: a result is a real turn end');
  nudge.started('hydra-helper-nudge-1', 'continue');
  assert.equal(nudge.waiting, true);
  nudge.controlResponse({ type: 'control_response', response: { subtype: 'success', request_id: 'hydra-helper-nudge-1' } });
  assert.deepEqual(sent, [], 'an interrupt that worked: wait for its result');
  assert.equal(nudge.result(), true, 'the interrupted turn\'s result is swallowed');
  assert.deepEqual(sent, ['continue']);
  assert.equal(nudge.result(), false, 'the continue turn\'s own result is reported');
  // A guarded fallback: the real CLI answers even an idle interrupt with success, but an error answer would send the message at once.
  nudge.started('hydra-helper-nudge-2', 'again');
  nudge.controlResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'another-request' } });
  assert.deepEqual(sent, ['continue'], 'someone else\'s control response changes nothing');
  nudge.controlResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'hydra-helper-nudge-2', error: 'no turn' } });
  assert.deepEqual(sent, ['continue', 'again']);
  assert.equal(nudge.result(), false);
  nudge.started('hydra-helper-nudge-3', 'lost'); nudge.cancel();
  assert.equal(nudge.result(), false); assert.deepEqual(sent, ['continue', 'again']);
});

test('Codex: an item started and not completed is in flight; its own messages and reasoning are not', () => {
  let clock = 0;
  const activity = new StreamActivity(() => clock);
  activity.turnStarted();
  clock = 10; activity.observeCodex({ type: 'item.started', item: { id: 'item_0', type: 'reasoning' } });
  activity.observeCodex({ type: 'item.started', item: { id: 'item_1', type: 'agent_message' } });
  assert.equal(activity.snapshot().toolsInFlight, 0);
  activity.observeCodex({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'npm test', status: 'in_progress' } });
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 10, toolsInFlight: 1, turnOpen: true });
  clock = 20; activity.observeCodex({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', exit_code: 0 } });
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 20, toolsInFlight: 0, turnOpen: true });
  // A resumed exec's first lines (after a nudge) are not model output.
  clock = 30;
  assert.equal(activity.observeCodex({ type: 'thread.started', thread_id: 't' }), false);
  assert.equal(activity.observeCodex({ type: 'turn.started' }), false);
  assert.equal(activity.observeCodex({ type: 'turn.completed', usage: {} }), false);
  assert.equal(activity.snapshot().lastOutputAt, 20);
  clock = 20;
  activity.observeCodex({ type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call' } });
  activity.turnEnded();
  assert.deepEqual(activity.snapshot(), { lastOutputAt: 20, toolsInFlight: 0, turnOpen: false });
});

test('silence counts only with a turn open and no tool in flight; the steps are record, nudge, fail', () => {
  assert.equal(headSilentMs(undefined, 10), undefined);
  assert.equal(headSilentMs({ lastOutputAt: 0, toolsInFlight: 1, turnOpen: true }, 3_600_000), undefined, 'a long npm test is not silence');
  assert.equal(headSilentMs({ lastOutputAt: 0, toolsInFlight: 0, turnOpen: false }, 3_600_000), undefined, 'between turns is not silence');
  assert.equal(headSilentMs({ lastOutputAt: 1000, toolsInFlight: 0, turnOpen: true }, 181_000), 180_000);
  assert.equal(headSilentMs({ lastOutputAt: 5000, toolsInFlight: 0, turnOpen: true }, 1000), 0, 'never negative');
  assert.deepEqual(headSilenceLimits('claude'), claudeSilenceLimits);
  assert.deepEqual(claudeSilenceLimits, { waitMs: 180_000, nudgeMs: 300_000, failMs: 600_000 });
  assert.deepEqual(headSilenceLimits('codex'), codexSilenceLimits);
  assert.deepEqual(codexSilenceLimits, { waitMs: 180_000, nudgeMs: 600_000, failMs: 900_000 }, 'Codex has no partial output, and a nudge stops its exec: it waits longer');
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

test('a silent stream is a wait on the provider: dated from the last output, closed only by the next output', () => {
  let clock = Date.parse('2026-09-29T10:00:00.000Z');
  const events: [ProviderWait | undefined, number][] = [];
  const tracker = new ProviderWaitTracker((wait, waitedMs) => events.push([wait, waitedMs]), () => clock);
  tracker.quiet();
  const lastOutput = clock;
  clock += 90_000; tracker.observe({ kind: 'resume' });
  clock += 90_000;
  tracker.stall(lastOutput);
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
  // The lines a nudge causes (an interrupted turn's result), or a rate-limit note, don't end it.
  tracker.observe({ kind: 'note', detail: '5-hour limit 40% used' });
  tracker.observe({ kind: 'resume' });
  tracker.observe(undefined);
  assert.equal(events.length, 1); assert.equal(tracker.current?.silent, true);
  tracker.output();
  assert.deepEqual(events.at(-1), [undefined, 240_000]);
  assert.equal(tracker.current, undefined);
  tracker.output();
  assert.equal(events.length, 2, 'output with no silent wait adds nothing');
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

test('the plan report shows each job\'s headline and names the option an automatic answer chose', () => {
  const plan = { id: 'p'.repeat(12), title: 'Nightly', state: 'done', unattended: { maxJobs: 2 }, startedAt: '2026-01-01T00:00:00.000Z', jobs: [], amendments: [] } as unknown as Plan;
  const details: PlanReportJobDetail[] = [
    { key: 'finish', title: 'Finish up', status: 'done', provider: 'claude', headline: 'Parser added; the leftover in src/other/ is yours to delete.', summary: 'Long detail.', autoAnswered: [{ at: '2026-01-01T00:05:28.000Z', why: 'unattended', question: 'May I delete it?', option: 2, choice: 'Leave it and say so' }] },
    { key: 'plain', title: 'Plain', status: 'done', provider: 'claude' },
  ];
  const report = buildPlanReport(plan, details, 5);
  assert.match(report, /## Finish up\n\nStatus: done\.\nHeadline: Parser added; the leftover in src\/other\/ is yours to delete\./);
  assert.match(report, /so it went with its recommended option 2: Leave it and say so\./);
  assert.match(report.split('## Needs you')[1]!, /- Finish up: its question was answered automatically, going with its recommended option 2: Leave it and say so; check its summary/);
  assert.doesNotMatch(report.split('## Plain')[1]!.split('## Integration gate')[0]!, /Headline/);
});

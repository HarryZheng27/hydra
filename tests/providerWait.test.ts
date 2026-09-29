import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeProviderWaitSignal, codexProviderWaitSignal, describeProviderWait, providerWaitLabel, ProviderWaitTracker, validateProviderWait, waitDuration, type ProviderWait } from '../src/core/providerWait';
import { claudeHeadLimit } from '../src/core/limitDetection';
import { JobStore } from '../src/core/jobs';
import { buildPlanReport, type Plan, type PlanReportJobDetail } from '../src/core/plans';
import { buildHydraTree } from '../src/core/hydraTree';
import type { HelperJobView } from '../src/core/model';

/**
 * A real head's stream (Claude Code 2.1, a head that sat about 13 minutes): its `at` times and stream-json
 * lines, from the head's transcript. The last ordinary line, 12¾ minutes of nothing, seven api_retry
 * notices, a rate_limit_event, then ordinary output again.
 */
const session = 'd3cbbe76-75dc-484c-8bba-fe7b2afae3ac';
const retry = (attempt: number, delay: number) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: delay, error_status: null, error: 'unknown', session_id: session, uuid: `u${attempt}` });
const rateLimitEvent = (status: string, utilization: number) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1791028800, rateLimitType: 'seven_day', utilization, isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 1790637000 }, seven_day: { utilization, resetsAt: 1791028800 } } }, uuid: 'r', session_id: session });
const stream: [number, Record<string, unknown>][] = [
  [1790626746350, rateLimitEvent('allowed_warning', 0.55)],
  [1790626766561, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1150, estimated_tokens_delta: 100, session_id: session, uuid: 't' }],
  [1790627531926, retry(1, 529)], [1790627533317, retry(2, 1225)], [1790627533600, retry(3, 2453)], [1790627536066, retry(4, 4318)],
  [1790627540396, retry(5, 8264)], [1790627550718, retry(6, 19426)], [1790627569855, retry(7, 39571)],
  [1790627638439, rateLimitEvent('allowed_warning', 0.56)],
  [1790627640000, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Carrying on.' }] }, session_id: session }],
];

test('Claude Code: api_retry is a retry, rate_limit_event is a note unless rejected, anything else is output', () => {
  assert.deepEqual(claudeProviderWaitSignal(retry(3, 2453)), { kind: 'retry', limit: false, attempt: 3, maxRetries: 10 });
  assert.deepEqual(claudeProviderWaitSignal({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' }),
    { kind: 'retry', limit: true, attempt: 2, maxRetries: 10, detail: 'rate limit, HTTP 429' });
  assert.deepEqual(claudeProviderWaitSignal(rateLimitEvent('allowed_warning', 0.56)), { kind: 'note', detail: '7-day limit 56% used', resetsAt: '2026-10-03T12:00:00.000Z' });
  assert.deepEqual(claudeProviderWaitSignal(rateLimitEvent('rejected', 1)), { kind: 'limited', detail: '7-day limit 100% used', resetsAt: '2026-10-03T12:00:00.000Z' });
  assert.deepEqual(claudeProviderWaitSignal({ type: 'system', subtype: 'thinking_tokens' }), { kind: 'resume' });
  assert.deepEqual(claudeProviderWaitSignal({ type: 'result', is_error: false }), { kind: 'resume' });
});

test('Codex: a "Reconnecting... n/m" error line or error item is a retry; other errors are neither', () => {
  assert.deepEqual(codexProviderWaitSignal({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: 429 Too Many Requests)' }),
    { kind: 'retry', limit: true, attempt: 2, maxRetries: 5, detail: 'Reconnecting... 2/5 (stream disconnected before completion: 429 Too Many Requests)' });
  assert.deepEqual(codexProviderWaitSignal({ type: 'item.completed', item: { id: 'item_3', type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' } }),
    { kind: 'retry', limit: false, attempt: 1, maxRetries: 5, detail: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  assert.equal(codexProviderWaitSignal({ type: 'error', message: "You've hit your usage limit." }), undefined, 'a final limit is codexHeadLimit\'s');
  assert.deepEqual(codexProviderWaitSignal({ type: 'item.completed', item: { type: 'agent_message', text: 'Reconnecting... 1/5' } }), { kind: 'resume' });
  assert.deepEqual(codexProviderWaitSignal({ type: 'turn.completed', usage: {} }), { kind: 'resume' });
});

test('the tracker opens a wait at the first retry, dated from the last line before it, and closes it at the next output', () => {
  let clock = 0;
  const changes: [ProviderWait | undefined, number][] = [];
  const tracker = new ProviderWaitTracker((wait, waitedMs) => changes.push([wait, waitedMs]), () => clock);
  for (const [at, line] of stream) { clock = at; tracker.observe(claudeProviderWaitSignal(line)); }
  const opened = changes[0]![0]!;
  assert.equal(opened.since, new Date(1790626766561).toISOString(), 'dated from the last line before the stall');
  assert.equal(opened.retries, 1);
  const last = changes.at(-2)![0]!;
  assert.deepEqual(last, { since: new Date(1790626766561).toISOString(), retries: 7, attempt: 7, maxRetries: 10, detail: '7-day limit 56% used', resetsAt: '2026-10-03T12:00:00.000Z' });
  const [closed, waitedMs] = changes.at(-1)!;
  assert.equal(closed, undefined);
  assert.equal(waitedMs, 1790627640000 - 1790626766561);
  assert.equal(waitDuration(waitedMs), '15m');
  assert.equal(tracker.current, undefined);
  // The turn-start rate_limit_event (allowed) outside a wait changes nothing.
  assert.equal(changes.filter(([wait]) => wait && !wait.retries).length, 0);
});

test('the tracker: a rejected rate-limit event is a limit wait; the run ending closes it; quiet() dates a new turn', () => {
  let clock = 1_000_000;
  const changes: [ProviderWait | undefined, number][] = [];
  const tracker = new ProviderWaitTracker((wait, waitedMs) => changes.push([wait, waitedMs]), () => clock);
  tracker.observe({ kind: 'resume' });
  clock += 3_600_000; tracker.quiet();
  clock += 5_000; tracker.observe(claudeProviderWaitSignal(rateLimitEvent('rejected', 1)));
  assert.deepEqual(changes[0]![0], { since: new Date(1_000_000 + 3_600_000).toISOString(), retries: 0, limit: true, detail: '7-day limit 100% used', resetsAt: '2026-10-03T12:00:00.000Z' });
  clock += 10_000; tracker.observe(claudeProviderWaitSignal({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 429, error: 'rate_limit' }));
  assert.equal(changes.at(-1)![0]!.retries, 1);
  assert.equal(changes.at(-1)![0]!.limit, true);
  clock += 20_000; tracker.end();
  assert.deepEqual(changes.at(-1), [undefined, 35_000]);
  tracker.end();
  assert.equal(changes.length, 3, 'ending twice closes nothing more');
});

test('a hard usage limit is still limitDetection\'s: a retry notice alone is no limit', () => {
  assert.equal(claudeHeadLimit(retry(7, 39571)), undefined);
  assert.equal(claudeHeadLimit(rateLimitEvent('rejected', 1)), undefined);
});

test('labels: the card, the heads list and hydra_get_head say what it waits on', () => {
  const since = '2026-09-28T10:00:00.000Z', now = Date.parse(since) + 13 * 60_000;
  assert.equal(providerWaitLabel('claude', { since, retries: 3, attempt: 3, maxRetries: 10, limit: true }, now), 'Waiting on your Claude usage limit for 13m (retry 3)');
  assert.equal(providerWaitLabel('claude', { since, retries: 7, attempt: 7, maxRetries: 10 }, now), "Waiting on Claude's servers for 13m (retry 7 of 10)");
  assert.equal(providerWaitLabel('codex', { since, retries: 0, limit: true }), 'Waiting on your Codex usage limit');
  assert.deepEqual(describeProviderWait('claude', { since, retries: 3, attempt: 3, limit: true, resetsAt: '2026-10-03T12:00:00.000Z', detail: 'rate limit, HTTP 429' }, now),
    { message: 'Waiting on your Claude usage limit for 13m (retry 3)', since, retries: 3, attempt: 3, limit: true, resets_at: '2026-10-03T12:00:00.000Z', detail: 'rate limit, HTTP 429', waited_ms: 13 * 60_000 });
  const head = { id: 'a'.repeat(12), title: 'Slow head', state: 'running', provider: 'claude', createdAt: since, changedFiles: 0, checks: [], dependsOn: [], providerWait: { since, retries: 2, attempt: 2, limit: true } } as HelperJobView;
  assert.equal(buildHydraTree([], [head], []).heads[0]!.description, 'Waiting on your Claude usage limit (retry 2)');
});

test('the job keeps an open wait and the total of those that ended, across a reload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-provider-wait-'));
  try {
    const store = new JobStore(dir); await store.load();
    const { job } = await store.create('window', { title: 'Slow', brief: 'Do it.', writeScope: ['src/'], provider: 'claude', idempotencyKey: 'k' });
    await store.transition(job.id, 'starting'); await store.transition(job.id, 'running');
    const wait: ProviderWait = { since: '2026-09-28T10:00:00.000Z', retries: 1, attempt: 1, maxRetries: 10 };
    await store.recordProviderWait(job.id, wait);
    assert.deepEqual(store.get(job.id)!.providerWait, wait);
    await store.recordProviderWait(job.id, undefined, 60_000);
    await store.recordProviderWait(job.id, { ...wait, retries: 2 });
    await store.recordProviderWait(job.id, undefined, 30_500.4);
    assert.equal(store.get(job.id)!.providerWait, undefined);
    assert.equal(store.get(job.id)!.providerWaitMs, 90_500);
    const reloaded = new JobStore(dir); await reloaded.load();
    assert.equal(reloaded.get(job.id)!.providerWaitMs, 90_500);
    assert.match(await readFile(path.join(dir, 'jobs.json'), 'utf8'), /"providerWaitMs": 90500/);
    assert.equal(validateProviderWait({ since: 'nope', retries: 1 }), undefined);
    assert.deepEqual(validateProviderWait({ ...wait, limit: 'yes', detail: 7 }), wait);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('the plan report names the jobs slowed by provider limits and their total wait', () => {
  const plan = { id: 'p'.repeat(12), title: 'Nightly', state: 'done', startedAt: '2026-01-01T00:00:00.000Z', jobs: [], amendments: [] } as unknown as Plan;
  const details: PlanReportJobDetail[] = [
    { key: 'api', title: 'Build the API', status: 'done', provider: 'claude', providerWaitMs: 13 * 60_000 },
    { key: 'ui', title: 'Build the UI', status: 'done', provider: 'codex', providerWaitMs: 2 * 60_000 },
    { key: 'docs', title: 'Docs', status: 'done', provider: 'claude' },
  ];
  const report = buildPlanReport(plan, details, 5);
  assert.match(report, /^Slowed by provider limits: 2 jobs waited 15m in total on their provider \(api, ui\)\.$/m);
  assert.match(report, /## Build the API\n\nStatus: done\.\nProvider: claude\.\nSlowed by provider limits: waited 13m on Claude \(part of its time, not its work\)\./);
  assert.match(report, /Slowed by provider limits: waited 2m on Codex/);
  assert.doesNotMatch(report.split('## Docs')[1]!, /Slowed by provider limits/);
  assert.doesNotMatch(buildPlanReport(plan, [details[2]!], 5), /Slowed by provider limits/);
});

test('a stale wait never survives: leaving running, a restart mid-wait, or a late notice clears it; the total stays', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-provider-wait-'));
  try {
    const wait: ProviderWait = { since: '2026-09-28T10:00:00.000Z', retries: 3, attempt: 3, limit: true };
    const store = new JobStore(dir); await store.load();
    const { job } = await store.create('window', { title: 'Slow', brief: 'Do it.', writeScope: ['src/'], provider: 'claude', idempotencyKey: 'k' });
    await store.recordProviderWait(job.id, wait);
    assert.equal(store.get(job.id)!.providerWait, undefined, 'a queued job opens no wait');
    await store.transition(job.id, 'starting'); await store.transition(job.id, 'running');
    await store.recordProviderWait(job.id, undefined, 45_000);
    await store.recordProviderWait(job.id, wait);
    // Hydra dies mid-wait: the record still has the open wait when it loads again.
    const restarted = new JobStore(dir); await restarted.load();
    const after = restarted.get(job.id)!;
    assert.equal(after.state, 'failed');
    assert.equal(after.providerWait, undefined);
    assert.equal(after.providerWaitMs, 45_000);
    assert.doesNotMatch(await readFile(path.join(dir, 'jobs.json'), 'utf8'), /"providerWait":/);
    // Any move out of running ends a wait, and a notice arriving after that opens nothing.
    const { job: other } = await restarted.create('window', { title: 'Other', brief: 'Do it.', writeScope: ['src/'], provider: 'claude', idempotencyKey: 'k2' });
    await restarted.transition(other.id, 'starting'); await restarted.transition(other.id, 'running');
    await restarted.recordProviderWait(other.id, wait);
    await restarted.transition(other.id, 'blocked', 'A question.');
    assert.equal(restarted.get(other.id)!.providerWait, undefined);
    await restarted.recordProviderWait(other.id, wait);
    assert.equal(restarted.get(other.id)!.providerWait, undefined);
    await restarted.transition(other.id, 'running');
    assert.equal(restarted.get(other.id)!.providerWait, undefined, 'back to running shows no stale wait');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

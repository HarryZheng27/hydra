import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, inScope, loadHelperChecks, helperPrompt, type HelperServiceOptions } from '../src/core/helperService';
import type { HelperRun, HelperRunSpec } from '../src/core/helperRunner';
import { claudeHelperArguments, codexHelperArguments } from '../src/core/helperRunner';
import { supportedCliVersion, supportedCliVersionIn } from '../src/core/cliVersions';
import type { HeadLimit } from '../src/core/limitDetection';
import type { LimitEvent } from '../src/core/limitEvents';
import type { ReviewerSpec } from '../src/core/gates';
import { dependencyBrief, maxDependencyBrief } from '../src/core/headStart';

/** A scripted stand-in for a helper process. It talks to Hydra only through the real endpoint, with its own token. */
type Script = (helper: { spec: HelperRunSpec; call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>; endTurn: () => void; nextMessage: () => Promise<string>; exit: (code: number) => void; limit: (hit: HeadLimit | undefined) => void; commit: (file: string, text: string) => Promise<void> }) => Promise<void>;

async function fixture(options: { script: Script; checks?: unknown; gates?: unknown; gateRuntime?: HelperServiceOptions['gateRuntime']; lanes?: (root: string, repo: string) => HelperServiceOptions['lanes']; now?: () => number; maxConcurrent?: number; plans?: HelperServiceOptions['plans']; planBoard?: HelperServiceOptions['planBoard'] }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-helpers-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  if (options.checks) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'checks.json'), JSON.stringify(options.checks)); }
  if (options.gates) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(options.gates)); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  const runs: HelperRunSpec[] = [];
  service = new HelperService({
    store, endpoint, leadFolder: repo, leadKey: 'window', worktreeRoot: () => path.join(root, 'worktrees'),
    executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => options.maxConcurrent ?? 2, now: options.now, watchdogMs: 20,
    gateRuntime: options.gateRuntime, lanes: options.lanes?.(root, repo), plans: options.plans, planBoard: options.planBoard,
    startRun: spec => {
      runs.push(spec);
      const listeners: (() => void)[] = [], inbox: string[] = [], readers: ((message: string) => void)[] = [];
      let exit!: (code: number) => void; let stopped = false; let limit: HeadLimit | undefined;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = {
        onTurnEnd: listener => { listeners.push(listener); }, exited,
        send: async message => { if (stopped) return false; const reader = readers.shift(); if (reader) reader(message); else inbox.push(message); return true; },
        stop: async () => exit(137),
        limitHit: () => limit,
      };
      const token = spec.bridge.env.HYDRA_HELPER_TOKEN!;
      // A real helper takes seconds to start; the fake one starts on the next tick.
      setTimeout(() => void options.script({
        spec, exit, limit: hit => { limit = hit; },
        call: (tool, args = {}) => callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), token, tool, args),
        endTurn: () => { for (const listener of listeners) listener(); },
        nextMessage: () => inbox.length ? Promise.resolve(inbox.shift()!) : new Promise(resolve => readers.push(resolve)),
        commit: async (file, text) => { await mkdir(path.dirname(path.join(spec.worktree, file)), { recursive: true }); await writeFile(path.join(spec.worktree, file), text); await git(spec.worktree, ['add', '.']); await git(spec.worktree, ['commit', '-qm', `head: ${file}`]); },
      }).catch(() => undefined), 0);
      return run;
    },
  });
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window' });
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> => callHelperEndpoint(port, lead, tool, args);
  const start = async (key: string, extra: Record<string, unknown> = {}): Promise<any> => (await call('hydra_start_head', { title: `Job ${key}`, brief: 'Do the thing.', write_scope: ['src/'], idempotency_key: key, ...extra })).result;
  const wait = async (ids: string[], max = 90): Promise<any> => (await call('hydra_wait_for_heads', { job_ids: ids, max_wait_s: max })).result;
  return { root, repo, store, service, endpoint, runs, call, start, wait, close: async () => { await service.dispose(); await endpoint.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

/** Wait for a condition instead of sleeping a fixed time; creating a worktree is slow on Windows. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

const passCheck = { checks: [{ id: 'unit', command: [process.execPath, '-e', "process.exit(require('fs').existsSync('src/fixed.ts') ? 0 : 1)"], timeoutSeconds: 60 }] };

test('a head that commits in scope and reports done is checked and handed back to the lead', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    const reported = await helper.call('hydra_done', { summary: 'Added fixed.ts' });
    assert.equal(reported.result.accepted, true);
    helper.endTurn();
  } });
  try {
    const started = await f.start('happy');
    assert.equal(started.created, true); assert.match(started.base_commit, /^[a-f0-9]{40}$/);
    const again = await f.start('happy');
    assert.equal(again.job_id, started.job_id); assert.equal(again.created, false, 'a repeated idempotency key never starts a second head');
    const waited = await f.wait([started.job_id]);
    assert.equal(waited.all_settled, true);
    const [helper] = waited.heads;
    assert.equal(helper.state, 'done'); assert.equal(helper.summary, 'Added fixed.ts');
    assert.deepEqual(helper.changed_files, ['src/fixed.ts']); assert.equal(helper.checks[0].passed, true);
    assert.match(helper.branch, /^agent\/job-happy-/);
    assert.equal(f.runs.length, 1, 'one head process');
    assert.match(f.runs[0]!.prompt, /Never stop without calling hydra_done or hydra_stuck/);
    assert.match(f.runs[0]!.prompt, /You may change only these paths: src\//);
  } finally { await f.close(); }
});

test('the first prompt lists the repository\'s tracked files and the project\'s gate commands (headStartContext), so a head needn\'t spend a turn on git ls-files or cat package.json', async () => {
  const f = await fixture({ gates: { gates: [{ id: 'test', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 600 }] }, script: async helper => {
    await helper.call('hydra_done', { summary: 'Looked around' });
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('context');
    await f.wait([job_id]);
    assert.equal(f.runs.length, 1);
    // .hydra/gates.json sorts before src/a.ts.
    assert.match(f.runs[0]!.prompt, /Repository:\n2 tracked files:\n\.hydra\/gates\.json\nsrc\/a\.ts\n\n/);
    assert.match(f.runs[0]!.prompt, /Hydra runs these gates after you call hydra_done:\n- test: npm test\n\nHow to work:/);
  } finally { await f.close(); }
});

test('with no command gate, the first prompt falls back to package.json\'s own "test" script', async () => {
  const f = await fixture({ script: async helper => {
    await helper.call('hydra_done', { summary: 'Looked around' });
    helper.endTurn();
  } });
  try {
    await writeFile(path.join(f.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    await git(f.repo, ['add', '.']); await git(f.repo, ['commit', '-qm', 'add package.json']);
    const { job_id } = await f.start('fallback');
    await f.wait([job_id]);
    assert.match(f.runs[0]!.prompt, /Repository:\n2 tracked files:\npackage\.json\nsrc\/a\.ts\n\n/);
    assert.match(f.runs[0]!.prompt, /Hydra runs these gates after you call hydra_done:\n- package\.json's "test" script \(no command gate covers it\): node --test/);
  } finally { await f.close(); }
});

test('failed checks re-prompt the head, which fixes and passes; the third failure fails the job', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/wip.ts', 'wip\n');
    const first = await helper.call('hydra_done', { summary: 'First try' });
    assert.equal(first.result.accepted, false); assert.match(first.result.message, /These gates failed:\n- unit \(command, exit 1\)/); assert.equal(first.result.attempts_left, 2);
    await helper.commit('src/fixed.ts', 'fixed\n');
    const second = await helper.call('hydra_done', { summary: 'Fixed it' });
    assert.equal(second.result.accepted, true);
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('retry');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'done'); assert.equal(helper.attempts, 2);
  } finally { await f.close(); }
  const never = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/wip.ts', 'wip\n');
    for (let attempt = 1; attempt <= 3; attempt++) { const result = await helper.call('hydra_done', { summary: `try ${attempt}` }); if (attempt < 3) assert.equal(result.result.accepted, false); else assert.match(result.result.message, /last attempt/); }
  } });
  try {
    const { job_id } = await never.start('never');
    const [helper] = (await never.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /Gates failed 3 times/);
  } finally { await never.close(); }
});

test('Hydra commits leftover changes; no changes and changes outside the write scope are refused', async () => {
  const f = await fixture({ script: async helper => {
    const empty = await helper.call('hydra_done', { summary: 'nothing' });
    assert.match(empty.result.message, /not changed anything yet/);
    // Left uncommitted (a sandboxed Codex helper can't commit): Hydra commits it.
    await writeFile(path.join(helper.spec.worktree, 'src', 'dirty.ts'), 'x');
    await writeFile(path.join(helper.spec.worktree, 'README.md'), 'outside\n');
    const refused = await helper.call('hydra_done', { summary: 'outside' });
    assert.equal(refused.result.accepted, false); assert.match(refused.result.message, /outside your write scope[\s\S]*README\.md/);
    assert.match(await git(helper.spec.worktree, ['log', '-1', '--format=%s']), /Job scope \(Hydra head [a-f0-9]{12}\)/);
    await git(helper.spec.worktree, ['rm', '-q', 'README.md']); await git(helper.spec.worktree, ['commit', '-qm', 'undo']);
    assert.equal((await helper.call('hydra_done', { summary: 'clean' })).result.accepted, true);
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('scope');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'done'); assert.deepEqual(helper.changed_files, ['src/dirty.ts']);
  } finally { await f.close(); }
});

test('a head that stops without reporting is nudged once, then failed; one that exits is failed', async () => {
  const f = await fixture({ script: async helper => {
    helper.endTurn();
    const nudge = await helper.nextMessage();
    assert.match(nudge, /stopped without reporting/);
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('silent');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /without calling hydra_done/);
  } finally { await f.close(); }
  const crash = await fixture({ script: async helper => { helper.exit(3); } });
  try {
    const { job_id } = await crash.start('crash');
    const [helper] = (await crash.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /exited \(code 3\)/);
  } finally { await crash.close(); }
});

test('a head that hits a usage limit fails at once with the reason, uses no nudge, and is reported', async () => {
  let nudged = false;
  const f = await fixture({ script: async helper => {
    void helper.nextMessage().then(() => { nudged = true; });
    helper.limit({ message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString() });
    helper.endTurn();
  } });
  const events: LimitEvent[] = [];
  f.service.onLimit(event => events.push(event));
  try {
    const { job_id } = await f.start('limited');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /^Claude usage limit reached \(resets 2026-/);
    assert.equal(nudged, false, 'no nudge was spent on it');
    assert.equal(f.store.get(job_id)!.attempts, 0);
    assert.equal(events.length, 1);
    assert.deepEqual({ ...events[0], at: undefined }, { provider: 'claude', source: 'head', at: undefined, jobId: job_id, message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString(), cwd: f.store.get(job_id)!.worktree });
  } finally { await f.close(); }
  // A Codex exec that fails on its limit exits non-zero instead of ending a turn.
  const exits = await fixture({ script: async helper => { helper.limit({ message: "You've hit your usage limit." }); helper.exit(1); } });
  const codexEvents: LimitEvent[] = [];
  exits.service.onLimit(event => codexEvents.push(event));
  try {
    const { job_id } = await exits.start('limited-exit', { provider: 'codex' });
    const [helper] = (await exits.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /^Codex usage limit reached: You've hit your usage limit\.$/);
    assert.equal(codexEvents[0]?.provider, 'codex');
  } finally { await exits.close(); }
});

test('continueWith restarts a head that hit a usage limit with the other provider, in the same worktree and branch', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    if (helper.spec.provider === 'claude') {
      helper.limit({ message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString() });
      helper.endTurn();
    } else {
      await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
      const reported = await helper.call('hydra_done', { summary: 'Continued in Codex' });
      assert.equal(reported.result.accepted, true);
      helper.endTurn();
    }
  } });
  try {
    const { job_id } = await f.start('limited-continue');
    const failed = (await f.wait([job_id])).heads[0];
    assert.equal(failed.state, 'failed');
    const before = f.store.get(job_id)!;
    assert.equal(before.limitHit, true);
    assert.ok(before.worktree && before.branch);

    const updated = await f.service.continueWith(job_id, 'codex', '## Handoff\n\nPick up where Claude left off.');
    assert.equal(updated.state, 'queued');
    assert.equal(updated.provider, 'codex');
    assert.equal(updated.attempts, 0);
    assert.equal(updated.nudged, false);
    assert.equal(updated.limitHit, false);
    assert.match(updated.brief, /## Handoff\n\nPick up where Claude left off\./);
    assert.equal(updated.history.at(-1)!.reason, "Continued in Codex after Claude's usage limit.");

    const done = (await f.wait([job_id])).heads[0];
    assert.equal(done.state, 'done');
    const after = f.store.get(job_id)!;
    assert.equal(after.worktree, before.worktree, 'same worktree reused');
    assert.equal(after.branch, before.branch, 'same branch reused');
    assert.equal(f.runs.length, 2, 'one run per provider; no extra worktree created for the continuation');
    assert.equal(f.runs[1]!.provider, 'codex');
    assert.equal(f.runs[1]!.worktree, before.worktree);

    await assert.rejects(f.service.continueWith(job_id, 'claude', 'x'), /did not fail from a usage limit/);
    await assert.rejects(f.service.continueWith('ffffffffffff', 'codex', 'x'), /No head/);
  } finally { await f.close(); }
});

test('the time limit stops a head, and time spent waiting for an answer does not count', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock, script: async () => { /* works forever */ } });
  try {
    const { job_id } = await f.start('slow', { limits: { wall_clock_minutes: 1 } });
    await until(() => f.store.get(job_id)?.state === 'running' && f.runs.length === 1, 'head process started');
    clock += 61_000;
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /Time limit reached \(1 minutes/);
  } finally { await f.close(); }
});

test('a stuck head waits for the lead, gets the answer as its tool result and continues', async () => {
  const f = await fixture({ script: async helper => {
    const answer = await helper.call('hydra_stuck', { reason: 'Two APIs exist', question: 'Use v1 or v2?' });
    assert.deepEqual(answer.result, { answered: true, answer: 'v2' });
    await helper.commit('src/v2.ts', 'v2\n');
    await helper.call('hydra_done', { summary: 'Used v2' });
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('stuck');
    const blocked = (await f.wait([job_id])).heads[0];
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.question, 'Use v1 or v2?');
    assert.match((await f.call('hydra_reply_to_head', { job_id, message: '' })).error || '', /1–8000/);
    assert.deepEqual((await f.call('hydra_reply_to_head', { job_id, message: 'v2' })).result, { job_id, delivered: true });
    const done = (await f.wait([job_id])).heads[0];
    assert.equal(done.state, 'done'); assert.equal(done.summary, 'Used v2');
    assert.match((await f.call('hydra_reply_to_head', { job_id, message: 'late' })).error || '', /not waiting for an answer/);
  } finally { await f.close(); }
});

test('cancel and Stop all end heads; a dependency that fails fails its dependents; the queue respects the cap', async () => {
  const f = await fixture({ maxConcurrent: 1, script: async helper => { await helper.call('hydra_progress', { note: `working in ${path.basename(helper.spec.worktree)}` }); } });
  try {
    const first = await f.start('one');
    const second = await f.start('two', { depends_on: [first.job_id] });
    const third = await f.start('three');
    await until(() => f.store.get(first.job_id)?.state === 'running', 'first head running');
    assert.equal(f.store.get(third.job_id)?.state, 'queued', 'only one head runs at a time here');
    assert.deepEqual((await f.call('hydra_cancel_head', { job_id: first.job_id, reason: 'Not needed' })).result, { job_id: first.job_id, state: 'cancelled' });
    const settled = (await f.wait([second.job_id])).heads[0];
    assert.equal(settled.state, 'failed'); assert.match(settled.reason, /depends on did not finish/);
    await until(() => !['queued', 'starting'].includes(f.store.get(third.job_id)?.state || ''), 'the freed slot goes to the next queued head');
    assert.equal(f.store.get(third.job_id)?.state, 'running', JSON.stringify({ state: f.store.get(third.job_id)?.state, reason: f.store.get(third.job_id)?.reason }));
    assert.equal(await f.service.stopAll(), 1);
    assert.equal(f.store.get(third.job_id)?.state, 'cancelled');
    const listed = (await f.call('hydra_list_heads')).result.heads;
    assert.deepEqual(listed.map((item: { state: string }) => item.state).sort(), ['cancelled', 'cancelled', 'failed']);
    assert.match((await f.call('hydra_get_head', { job_id: 'ffffffffffff' })).error || '', /No head/);
  } finally { await f.close(); }
});

test('the lead is warned when the head cannot see uncommitted changes; checks come only from the lead folder', async () => {
  const f = await fixture({ script: async () => {} });
  try {
    await writeFile(path.join(f.repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const started = await f.start('dirty');
    assert.match(started.warning, /uncommitted changes/);
    await mkdir(path.join(f.repo, '.hydra'), { recursive: true });
    await writeFile(path.join(f.repo, '.hydra', 'checks.json'), JSON.stringify({ checks: [{ command: ['npm', 'test'], timeoutSeconds: 5000, required: false }] }));
    assert.deepEqual(await loadHelperChecks(f.repo), [{ id: 'check-1', command: ['npm', 'test'], timeoutSeconds: 900, required: false }]);
    await writeFile(path.join(f.repo, '.hydra', 'checks.json'), JSON.stringify({ checks: [{ command: 'npm test' }] }));
    await assert.rejects(loadHelperChecks(f.repo), /must be a list/);
  } finally { await f.close(); }
});

test('scope matching, head prompts, runner arguments and the supported CLI range', () => {
  assert.equal(inScope('src/a.ts', ['src/']), true); assert.equal(inScope('src', ['src']), true);
  assert.equal(inScope('srcx/a.ts', ['src']), false); assert.equal(inScope('README.md', ['']), true);
  assert.match(helperPrompt({ id: 'a'.repeat(12), title: 'T', brief: 'B', writeScope: [''], worktree: 'W', branch: 'b', baseCommit: 'c' }), /\(whole repository\)/);
  // The "Repository" section and the gate/test commands (headStartContext) are added only when given, right after the brief and any dependencies; nothing without them, so a loose head's prompt is unchanged.
  const job = { id: 'a'.repeat(12), title: 'T', brief: 'Add the thing.', writeScope: ['src/'], worktree: 'W', branch: 'b', baseCommit: 'c' };
  assert.doesNotMatch(helperPrompt(job), /Repository:/);
  const withContext = helperPrompt(job, undefined, 'heads', undefined, undefined, { repository: '2 tracked files:\nREADME.md\nsrc/a.ts', tests: 'Hydra runs these gates after you call hydra_done:\n- test: npm test' });
  assert.match(withContext, /Add the thing\.\n\nRepository:\n2 tracked files:\nREADME\.md\nsrc\/a\.ts\n\nHydra runs these gates after you call hydra_done:\n- test: npm test\n\nHow to work:/);
  assert.match(withContext, /- Shell commands start slowly here.*Read, Grep or Glob/);
  assert.match(withContext, /- Run only the tests your change touches\. Hydra runs the project's full gates after hydra_done\./);
  assert.match(withContext, /- Give a slow test command a generous timeout rather than retrying it after it times out\./);
  // Only the tests section, no repository listing (a job with no baseCommit-resolved listing yet):
  assert.doesNotMatch(helperPrompt(job, undefined, 'heads', undefined, undefined, { tests: 'Hydra runs these gates after you call hydra_done:\n- test: npm test' }), /Repository:/);
  const spec: HelperRunSpec = { provider: 'claude', executable: 'claude', worktree: 'W', prompt: 'P', maxTurns: 7, maxBudgetUsd: 2, bridge: { command: 'Hydra.exe', args: ['b.cjs'], env: { HYDRA_HELPER_TOKEN: 'secret', HYDRA_HELPER_PORT: '1' } }, logFile: 'l', confine: { settingsFile: 'S.settings.json', addDirs: [], shell: false, env: {} } };
  const claude = claudeHelperArguments(spec);
  for (const expected of ['dontAsk', '--strict-mcp-config', '--max-turns', '7', '--max-budget-usd', '2']) assert.ok(claude.includes(expected), expected);
  assert.ok(claude.some(arg => arg.startsWith('--mcp-config={') && arg.includes('secret')), 'the token travels inline, never in a file');
  assert.ok(!claude.join(' ').includes('WebFetch'), 'heads get no web tools');
  const codex = codexHelperArguments({ ...spec, provider: 'codex' }, 'thread-1');
  assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', '--json']); assert.ok(codex.includes("approval_policy='never'")); assert.ok(codex.includes('workspace-write'));
  // Only TOML literal strings: a .cmd launcher's PowerShell/cmd layer strips double quotes.
  assert.ok(codex.some(arg => arg === "mcp_servers.hydra.env={ HYDRA_HELPER_TOKEN = 'secret', HYDRA_HELPER_PORT = '1' }"), codex.join(' '));
  assert.ok(!codex.some(arg => arg.includes('"')), 'no double quotes in Codex arguments');
  assert.throws(() => codexHelperArguments({ ...spec, provider: 'codex', worktree: 'W', bridge: { ...spec.bridge, command: "C:/it's/Hydra.exe" } }), /quote/);
  for (const [version, ok] of [['2.1.270 (Claude Code)', true], ['2.1.281', true], ['2.1.269', false], ['2.2.0', true], ['3.0.0', false], ['2.1.300-beta.1', false], ['nonsense', false]] as const) assert.equal(supportedCliVersion('claude', version), ok, version);
  assert.equal(supportedCliVersion('codex', 'codex-cli 0.154.3'), true); assert.equal(supportedCliVersion('codex', 'codex-cli 0.147.0-alpha.1.2'), false);
  assert.equal(supportedCliVersion('codex', 'codex-cli 0.157.1'), true); assert.equal(supportedCliVersion('codex', 'codex-cli 0.153.9'), false); assert.equal(supportedCliVersion('codex', 'codex-cli 1.0.0'), false);
  assert.equal(supportedCliVersionIn('codex', 'codex_cli_rs/0.154.2 (Windows 10.0.26200; x86_64)'), '0.154.2');
});

test('a head records the chat that started it, and is seen as merged once its branch is in the lead folder', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    await helper.call('hydra_done', { summary: 'Added fixed.ts' });
    helper.endTurn();
  } });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345', provider: 'codex' });
    const started = (await callHelperEndpoint(f.endpoint.port, chat, 'hydra_start_head', { title: 'Merged later', brief: 'Do it.', write_scope: ['src/'], idempotency_key: 'merge', lead_label: 'Checkout refactor' })).result as { job_id: string };
    assert.deepEqual(f.store.get(started.job_id)!.lead, { sessionId: 'abcdef012345', provider: 'codex', label: 'Checkout refactor' });
    const plain = await f.start('no-session');
    assert.equal(f.store.get(plain.job_id)!.lead, undefined, 'a caller without a session records no lead');
    await until(() => f.store.get(started.job_id)?.state === 'done', 'head done');
    await f.service.refreshMerged();
    assert.equal(f.service.isMerged(started.job_id), false, 'done but not merged yet');
    await git(f.repo, ['merge', '-q', '--no-edit', f.store.get(started.job_id)!.branch!]);
    await f.service.refreshMerged();
    assert.equal(f.service.isMerged(started.job_id), true, 'the lead merged it');
  } finally { await f.close(); }
});

// ---- Gates (docs/Gates_Plan.md, section 1) ----

/** A stand-in reviewer: each review gets the next scripted reply, in the reviewing CLI's own output format. */
function scriptedReviewer(replies: (Record<string, unknown> | { timedOut: true })[]) {
  const specs: ReviewerSpec[] = [];
  const runReviewer = async (spec: ReviewerSpec) => {
    specs.push(spec);
    const reply = replies.shift() ?? { verdict: 'pass', summary: 'Fine.', findings: [] };
    if ('timedOut' in reply) return { args: spec.args, stdout: '', stderr: '', exitCode: null, error: 'Provider check timed out.', timedOut: true };
    const text = JSON.stringify(reply);
    const stdout = spec.provider === 'claude' ? JSON.stringify({ type: 'result', is_error: false, result: text }) : `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`;
    return { args: spec.args, stdout, stderr: '', exitCode: 0 };
  };
  return { specs, runReviewer };
}
const fixedExists = { id: 'unit', type: 'command', command: [process.execPath, '-e', "process.exit(require('fs').existsSync('src/fixed.ts') ? 0 : 1)"] };
/** A head's key, from the title the fixture gives it ("Job <key>"). */
function jobKey(prompt: string): string | undefined { return /\): Job (\S+)$/m.exec(prompt)?.[1]; }

test('a head\'s work goes through the gates in order; failures come back with the findings, and attempts are counted', async () => {
  const reviewer = scriptedReviewer([
    { verdict: 'fail', summary: 'The flag is wrong.', findings: [{ file: 'src/fixed.ts', line: 1, severity: 'major', note: 'Always true.' }, { severity: 'minor', note: 'Name it better.' }] },
    { verdict: 'fail', summary: 'Only a nit left.', findings: [{ severity: 'minor', note: 'Name it better.' }] },
  ]);
  const f = await fixture({ gates: { gates: [{ id: 'review', type: 'review', focus: 'The flag.' }, fixedExists] }, gateRuntime: { runReviewer: reviewer.runReviewer }, script: async helper => {
    await helper.commit('src/wip.ts', 'wip\n');
    const first = await helper.call('hydra_done', { summary: 'First try' });
    assert.equal(first.result.accepted, false); assert.equal(first.result.attempts_left, 2);
    assert.match(first.result.message, /^These gates failed:\n- unit \(command, exit 1\): Exited with code 1\./);
    assert.doesNotMatch(first.result.message, /review/, 'the review is skipped while the tests fail');
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    const second = await helper.call('hydra_done', { summary: 'Second try' });
    assert.equal(second.result.accepted, false); assert.equal(second.result.attempts_left, 1);
    assert.match(second.result.message, /^These gates failed:\n- review \(review by Codex\): Reviewed by Codex\. The flag is wrong\.\n  - major src\/fixed\.ts:1: Always true\.\n  - minor: Name it better\.\nFix them, commit, and call hydra_done again\.$/);
    await helper.commit('src/fixed.ts', 'export const fixed = process.env.FLAG === "1";\n');
    const third = await helper.call('hydra_done', { summary: 'Fixed the flag' });
    assert.equal(third.result.accepted, true, 'a fail with only minor findings passes');
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('gated');
    const [head] = (await f.wait([job_id])).heads;
    assert.equal(head.state, 'done'); assert.equal(head.attempts, 3); assert.equal(head.max_attempts, 3);
    assert.deepEqual(head.checks.map((check: { id: string; kind: string; state: string }) => [check.id, check.kind, check.state]), [['unit', 'command', 'passed'], ['review', 'review', 'passed']]);
    assert.equal(head.checks[1].summary, 'Reviewed by Codex. Only a nit left.');
    assert.deepEqual(head.checks[1].findings, [{ severity: 'minor', note: 'Name it better.' }]);
    assert.ok(head.checks[1].evidence.length >= 1 && head.checks[0].evidence.length === 1);
    // hydra_get_head returns the same gate results.
    assert.deepEqual((await f.call('hydra_get_head', { job_id })).result.checks, head.checks);
    // The other agent reviewed a Claude head, read-only, in the head's worktree, with the brief and scope.
    assert.equal(reviewer.specs.length, 2);
    const [spec] = reviewer.specs;
    assert.equal(spec!.provider, 'codex'); assert.equal(spec!.cwd, f.store.get(job_id)!.worktree);
    assert.deepEqual(spec!.args, ['exec', '--json', '-c', "web_search='disabled'", '--sandbox', 'read-only', '-']);
    assert.match(spec!.input, /## The task\nJob gated\n\nDo the thing\.\n\nIt may change only: src\//);
    assert.match(spec!.input, /- unit \(command\): passed/); assert.match(spec!.input, /## What to focus on\nThe flag\./);
    assert.match(spec!.input, /\+export const fixed = true;/);
  } finally { await f.close(); }
});

test('maxAttempts comes from gates.json; a review that can\'t run never fails the head; a broken gates file costs no attempt', async () => {
  const reviewer = scriptedReviewer([{ timedOut: true }]);
  const f = await fixture({ gates: { maxAttempts: 1, gates: [fixedExists, { id: 'review', type: 'review' }] }, gateRuntime: { runReviewer: reviewer.runReviewer }, script: async helper => {
    if (jobKey(helper.spec.prompt) === 'once') {
      await helper.commit('src/wip.ts', 'wip\n');
      const only = await helper.call('hydra_done', { summary: 'Only try' });
      assert.match(only.result.message, /last attempt \(1 of 1\)/);
    } else {
      await helper.commit('src/fixed.ts', 'fixed\n');
      assert.equal((await helper.call('hydra_done', { summary: 'Reviewer timed out' })).result.accepted, true);
      helper.endTurn();
    }
  } });
  try {
    const once = await f.start('once');
    const failed = (await f.wait([once.job_id])).heads[0];
    assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'Gates failed 1 time.'); assert.equal(failed.max_attempts, 1);
    assert.deepEqual(failed.checks.map((check: { id: string; state: string }) => [check.id, check.state]), [['unit', 'failed'], ['review', 'notRun']]);
    const notRun = await f.start('not-run');
    const accepted = (await f.wait([notRun.job_id])).heads[0];
    assert.equal(accepted.state, 'done');
    const review = accepted.checks.find((check: { id: string }) => check.id === 'review');
    assert.deepEqual({ state: review.state, passed: review.passed, required: review.required }, { state: 'notRun', passed: false, required: true });
    assert.equal(review.summary, 'Codex didn\'t finish its review in 5 minutes.');
  } finally { await f.close(); }

  const broken = await fixture({ gates: { gates: 'unit' }, script: async helper => {
    await helper.commit('src/fixed.ts', 'fixed\n');
    const refused = await helper.call('hydra_done', { summary: 'Done' });
    assert.equal(refused.result.accepted, false);
    assert.match(refused.result.message, /^Hydra can't check your work: \.hydra\/gates\.json: The gates file needs a "gates" list\. That isn't your fault\. Call hydra_stuck/);
    await helper.call('hydra_progress', { note: 'waiting on the lead' });
  } });
  try {
    const { job_id } = await broken.start('broken');
    await until(() => broken.store.get(job_id)?.progress === 'waiting on the lead', 'the head was told');
    assert.equal(broken.store.get(job_id)!.state, 'running'); assert.equal(broken.store.get(job_id)!.attempts, 0);
  } finally { await broken.close(); }
});

// ---- What a head starts from (docs/Gates_Plan.md, section 3) ----

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

test('a dependent starts from its dependency\'s result commit, sees its file, and is told what it did', async () => {
  const f = await fixture({ script: async helper => {
    if (jobKey(helper.spec.prompt) === 'first') {
      await helper.commit('src/first.ts', 'export const first = 1;\n');
      await helper.call('hydra_done', { summary: 'Added first.ts with the parser.' });
    } else {
      assert.match(await readFile(path.join(helper.spec.worktree, 'src', 'first.ts'), 'utf8'), /^export const first = 1;\r?\n$/);
      await helper.commit('src/second.ts', 'export const second = 2;\n');
      await helper.call('hydra_done', { summary: 'Added second.ts on top.' });
    }
    helper.endTurn();
  } });
  try {
    const first = await f.start('first');
    const second = await f.start('second', { depends_on: [first.job_id] });
    assert.equal(second.base_commit, undefined, 'its base is known only once it starts');
    assert.match(second.starts_from, /heads it depends on/);
    const [one, two] = (await f.wait([first.job_id, second.job_id])).heads;
    assert.equal(one.state, 'done'); assert.equal(two.state, 'done', two.reason);
    assert.equal(two.base_commit, one.commit, 'base_commit is where it really started');
    assert.deepEqual(two.changed_files, ['src/second.ts'], 'its own changes only');
    const prompt = f.runs.find(run => jobKey(run.prompt) === 'second')!.prompt;
    assert.match(prompt, new RegExp(`What the heads you depend on did \\(your worktree already has their work\\):\\n- Job first \\(branch ${escape(one.branch)}, commit ${one.commit.slice(0, 12)}\\): Added first\\.ts with the parser\\.\\n  Changed files: src/first\\.ts`));
    assert.match(prompt, new RegExp(`It starts from commit ${one.commit}, which already has the work of the heads it depends on\\.`));
    assert.doesNotMatch(f.runs.find(run => jobKey(run.prompt) === 'first')!.prompt, /What the heads you depend on did/);
  } finally { await f.close(); }
});

test('several dependencies are merged into one Hydra commit; ones that conflict fail the dependent before it starts, naming the files', async () => {
  const f = await fixture({ maxConcurrent: 3, script: async helper => {
    const key = jobKey(helper.spec.prompt)!;
    if (key === 'clashing') assert.fail('a dependent whose dependencies conflict never starts');
    if (key === 'both') {
      for (const file of ['one.ts', 'two.ts']) assert.ok((await readFile(path.join(helper.spec.worktree, 'src', file), 'utf8')).length > 0, file);
      await helper.commit('src/both.ts', 'both\n');
    } else if (key.startsWith('clash-')) await helper.commit('src/shared.ts', `${key}\n`);
    else await helper.commit(`src/${key}.ts`, `${key}\n`);
    await helper.call('hydra_done', { summary: `Did ${key}.` });
    helper.endTurn();
  } });
  try {
    const one = await f.start('one'), two = await f.start('two');
    const both = await f.start('both', { depends_on: [one.job_id, two.job_id] });
    const clashA = await f.start('clash-a'), clashB = await f.start('clash-b');
    const clashing = await f.start('clashing', { depends_on: [clashA.job_id, clashB.job_id] });
    const [a, b, merged, refused] = (await f.wait([one.job_id, two.job_id, both.job_id, clashing.job_id])).heads;
    assert.equal(merged.state, 'done', merged.reason);
    const [base, ...parents] = (await git(f.repo, ['rev-list', '--parents', '-n', '1', merged.base_commit])).trim().split(' ');
    assert.equal(base, merged.base_commit);
    assert.deepEqual(parents, [a.commit, b.commit], 'one commit, whose parents are both dependencies');
    assert.match(await git(f.repo, ['log', '-1', '--format=%an%n%s', merged.base_commit]), /^Hydra\nHydra: merge the heads "Job both" depends on/);
    assert.deepEqual(merged.changed_files, ['src/both.ts']);
    assert.equal(refused.state, 'failed');
    assert.equal(refused.reason, 'Could not start: The heads it depends on conflict in src/shared.ts; merge them first.');
    assert.equal(f.store.get(clashing.job_id)!.worktree, undefined, 'no worktree was made for it');
    assert.equal(f.runs.some(run => jobKey(run.prompt) === 'clashing'), false);
  } finally { await f.close(); }
});

test('a head started from a lane takes the lane\'s HEAD as its base, not the main checkout\'s', async () => {
  const laneId = 'abcabcabcabc';
  const f = await fixture({
    lanes: root => ({ describe: async () => ({}), name: id => id === laneId ? 'Lane one' : undefined, worktree: id => id === laneId ? path.join(root, 'lane') : undefined }),
    script: async helper => {
      if (jobKey(helper.spec.prompt) === 'from-lane') assert.match(await readFile(path.join(helper.spec.worktree, 'src', 'lane.ts'), 'utf8'), /^lane work\r?\n$/, 'the lane\'s committed work is there');
      await helper.commit('src/head.ts', 'head\n');
      await helper.call('hydra_done', { summary: 'Done.' });
      helper.endTurn();
    },
  });
  try {
    const lane = path.join(f.root, 'lane');
    await git(f.repo, ['worktree', 'add', '-q', '-b', `lane/one-${laneId}`, lane, 'HEAD']);
    await writeFile(path.join(lane, 'src', 'lane.ts'), 'lane work\n');
    await git(lane, ['add', '.']); await git(lane, ['commit', '-qm', 'lane work']);
    await writeFile(path.join(lane, 'src', 'lane.ts'), 'uncommitted lane work\n');
    const laneHead = (await git(lane, ['rev-parse', 'HEAD'])).trim(), mainHead = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    const token = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345', provider: 'claude', lane: laneId });
    const started = (await callHelperEndpoint(f.endpoint.port, token, 'hydra_start_head', { title: 'Job from-lane', brief: 'Build on the lane.', write_scope: ['src/'], idempotency_key: 'from-lane' })).result as { job_id: string; base_commit: string; warning?: string };
    assert.equal(started.base_commit, laneHead);
    assert.match(started.warning!, /^Your lane has uncommitted changes\. The head starts from the lane's last commit/);
    const plain = await f.start('plain');
    assert.equal(plain.base_commit, mainHead, 'the window\'s own lead still branches from the main checkout');
    const [fromLane] = (await f.wait([started.job_id, plain.job_id])).heads;
    assert.equal(fromLane.state, 'done', fromLane.reason); assert.equal(fromLane.base_commit, laneHead);
    assert.equal(f.store.get(started.job_id)!.lead?.lane, laneId);
    assert.deepEqual(fromLane.changed_files, ['src/head.ts']);
  } finally { await f.close(); }
});

test('the dependency summaries for a dependent\'s brief are capped at 4 KB', () => {
  const brief = dependencyBrief([
    { id: 'a'.repeat(12), kind: 'head', title: 'Parser', summary: 'Added the parser.', commit: 'c'.repeat(40), branch: 'agent/parser-aaaaaaaaaaaa', changedFiles: ['src/parser.ts', 'tests/parser.test.ts'] },
    { id: 'b'.repeat(12), kind: 'head', title: 'Huge', summary: 'x'.repeat(10_000), commit: 'd'.repeat(40), changedFiles: Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`) },
  ]);
  assert.ok(brief.length <= maxDependencyBrief, String(brief.length));
  assert.match(brief, /^What the heads you depend on did \(your worktree already has their work\):\n- Parser \(branch agent\/parser-aaaaaaaaaaaa, commit cccccccccccc\): Added the parser\.\n  Changed files: src\/parser\.ts, tests\/parser\.test\.ts\n- Huge \(commit dddddddddddd\): x+…$/);
});

// ---- Plan lanes (docs/Plan_Lanes_Plan.md, "Heads that depend on a lane job", decision 7) ----

test('a plan head starts from a lane job\'s result, sees its file, and is told what "the jobs it depends on" did', async () => {
  const f = await fixture({ script: async helper => {
    if (jobKey(helper.spec.prompt) === 'api') assert.match(await readFile(path.join(helper.spec.worktree, 'src', 'schema.ts'), 'utf8'), /^schema\r?\n$/, 'the lane\'s work is there');
    await helper.commit(`src/${jobKey(helper.spec.prompt)}.ts`, 'done\n');
    await helper.call('hydra_done', { summary: 'Done.' });
    helper.endTurn();
  } });
  try {
    // A lane's committed work on its own branch, not merged into main.
    await git(f.repo, ['switch', '-q', '-c', 'lane/schema-abcabcabcabc']);
    await writeFile(path.join(f.repo, 'src', 'schema.ts'), 'schema\n');
    await git(f.repo, ['add', '.']); await git(f.repo, ['commit', '-qm', 'Add the schema']);
    const laneCommit = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    await git(f.repo, ['switch', '-q', 'main']);
    const input = { id: 'abcabcabcabc', kind: 'lane' as const, title: 'Schema', summary: 'The schema is in src/schema.ts.', commit: laneCommit, branch: 'lane/schema-abcabcabcabc', changedFiles: ['src/schema.ts'] };
    const args = { title: 'Job api', brief: 'Build the API on the schema.', write_scope: ['src/'], idempotency_key: 'plan-abcdefabcdef-api', lead_label: 'Plan · Checkout' };
    const started = await f.service.startForPlan(args, 'plan-abcdefabcdef', [input]) as { job_id: string; base_commit?: string };
    assert.equal(started.base_commit, laneCommit, 'its base is the lane\'s result, known at once');
    assert.deepEqual(f.store.get(started.job_id)!.inputs, [input], 'kept with the job across a restart');
    assert.equal((await f.service.startForPlan(args, 'plan-abcdefabcdef', [input]) as { job_id: string }).job_id, started.job_id, 'the idempotency key covers a repeat');
    await assert.rejects(f.service.startForPlan({ ...args, idempotency_key: 'bad' }, 'plan-abcdefabcdef', [{ ...input, commit: 'nope' }]), /inputs are malformed/);
    // A plan head with a head dependency and a lane input starts from both, merged, once the head is done.
    const first = await f.start('first');
    const both = await f.service.startForPlan({ ...args, title: 'Job both', idempotency_key: 'plan-abcdefabcdef-both', depends_on: [first.job_id] }, 'plan-abcdefabcdef', [input]) as { job_id: string; base_commit?: string };
    assert.equal(both.base_commit, undefined, 'known only when it starts');
    const [api, , mixed] = (await f.wait([started.job_id, first.job_id, both.job_id])).heads;
    assert.equal(api.state, 'done', api.reason); assert.equal(api.base_commit, laneCommit);
    assert.deepEqual(api.changed_files, ['src/api.ts'], 'its own changes only');
    assert.equal(mixed.state, 'done', mixed.reason);
    const [, ...parents] = (await git(f.repo, ['rev-list', '--parents', '-n', '1', mixed.base_commit])).trim().split(' ');
    assert.deepEqual(parents.sort(), [f.store.get(first.job_id)!.result!.commit, laneCommit].sort());
    const prompt = f.runs.find(run => jobKey(run.prompt) === 'api')!.prompt;
    assert.match(prompt, /What the jobs you depend on did \(your worktree already has their work\):\n- Schema \(branch lane\/schema-abcabcabcabc, commit [a-f0-9]{12}\): The schema is in src\/schema\.ts\.\n  Changed files: src\/schema\.ts/);
    assert.match(prompt, /which already has the work of the jobs it depends on\./);
    // A lead can never pass inputs: hydra_start_head ignores them.
    const lead = await f.start('lead', { inputs: [input] });
    assert.equal(f.store.get(lead.job_id)!.inputs, undefined);
  } finally { await f.close(); }
});

test('lane inputs that conflict refuse the plan head before it exists, naming the files', async () => {
  const f = await fixture({ script: async () => {} });
  try {
    const commits: string[] = [];
    for (const side of ['a', 'b']) {
      await git(f.repo, ['switch', '-q', '-c', `lane/${side}-abcabcabcab${side}`]);
      await writeFile(path.join(f.repo, 'src', 'a.ts'), `export const a = "${side}";\n`);
      await git(f.repo, ['commit', '-qam', side]);
      commits.push((await git(f.repo, ['rev-parse', 'HEAD'])).trim());
      await git(f.repo, ['switch', '-q', 'main']);
    }
    const inputs = commits.map((commit, index) => ({ id: `abcabcabcab${'ab'[index]}`, kind: 'lane' as const, title: `Lane ${index}`, summary: 's', commit, changedFiles: ['src/a.ts'] }));
    await assert.rejects(f.service.startForPlan({ title: 'Job c', brief: 'b', write_scope: ['src/'], idempotency_key: 'plan-c' }, 'plan-abcdefabcdef', inputs), /^Error: The jobs it depends on conflict in src\/a\.ts; merge them first\.$/);
    assert.equal(f.store.list().length, 0, 'no head was created');
  } finally { await f.close(); }
});

test('heads queued behind a head that hit its usage limit wait for it (decision 7), go on after Continue in, and fail once it is given up on', async () => {
  const f = await fixture({ script: async helper => {
    const key = jobKey(helper.spec.prompt);
    if (helper.spec.provider === 'claude' && (key === 'limited' || key === 'abandoned')) { helper.limit({ message: 'Claude AI usage limit reached|1790000000' }); helper.endTurn(); return; }
    await helper.commit(`src/${key}.ts`, 'done\n');
    await helper.call('hydra_done', { summary: 'Done.' });
    helper.endTurn();
  } });
  try {
    const limited = await f.start('limited');
    const after = await f.start('after', { depends_on: [limited.job_id] });
    const abandoned = await f.start('abandoned');
    const orphan = await f.start('orphan', { depends_on: [abandoned.job_id] });
    await until(() => !!f.store.get(limited.job_id)?.limitHit && !!f.store.get(abandoned.job_id)?.limitHit, 'both heads hit their limit');
    // Let the queue run a few more passes: the dependents still wait instead of failing.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual([f.store.get(after.job_id)!.state, f.store.get(orphan.job_id)!.state], ['queued', 'queued']);
    // Continue in Codex brings the first back, and its dependent goes on.
    await f.service.continueWith(limited.job_id, 'codex', '## Handoff');
    const [one, two] = (await f.wait([limited.job_id, after.job_id])).heads;
    assert.deepEqual([one.state, two.state], ['done', 'done'], two.reason);
    // Cancelling the held second head gives up on it: its dependent fails, and it can't be continued any more.
    assert.equal(f.store.get(orphan.job_id)!.state, 'queued');
    await f.call('hydra_cancel_head', { job_id: abandoned.job_id, reason: 'Given up.' });
    const [gone] = (await f.wait([orphan.job_id])).heads;
    assert.equal(gone.state, 'failed'); assert.match(gone.reason, /depends on did not finish/);
    assert.equal(f.store.get(abandoned.job_id)!.limitHit, false);
    await assert.rejects(f.service.continueWith(abandoned.job_id, 'codex', 'x'), /did not fail from a usage limit/);
  } finally { await f.close(); }
});

test('O6: continueWith records priorProviders as soon as it hands off, before the other provider even starts', async () => {
  // A review after the handoff, reading priorProviders as priorAuthors, is covered as a pure
  // chooseReviewer test (tests/gates.test.ts); this only checks continueWith's own bookkeeping,
  // never waiting for the retried process (this suite's watchdog can otherwise re-detect the
  // first attempt's already-handled limit against the second attempt's now-different provider,
  // a pre-existing timing sensitivity of continueWith unrelated to priorProviders itself).
  const f = await fixture({ script: async helper => {
    helper.limit({ message: 'Claude AI usage limit reached|1790000000' }); helper.endTurn();
  } });
  try {
    const started = await f.start('handoff');
    await until(() => !!f.store.get(started.job_id)?.limitHit, 'hit its limit');
    assert.equal(f.store.get(started.job_id)!.priorProviders, undefined, 'nothing recorded until it actually continues');
    await f.service.continueWith(started.job_id, 'codex', '## Handoff');
    assert.deepEqual(f.store.get(started.job_id)!.priorProviders, ['claude']);
  } finally { await f.close(); }
});

test('O6: continueWith never lists the same provider twice in priorProviders (a job that bounces back and forth)', async () => {
  const store = new JobStore(await mkdtemp(path.join(tmpdir(), 'hydra-jobs-')));
  await store.load();
  const folder = path.dirname(store.file);
  // continueWith queues the job again, and the dispatcher would launch it: a launch that fails at the executable
  // stops before any worktree is made, and the lead folder is a temporary one, never the repository running the tests.
  const service = new HelperService({
    store, endpoint: { issue: () => '', revokeJob: () => {}, port: 0 }, leadFolder: folder, leadKey: 'window',
    startRun: () => { throw new Error('not exercised'); }, executable: async () => { throw new Error('no CLI in this test'); }, bridge: { command: 'x', args: [] }, logDirectory: path.join(folder, 'logs'),
    maxConcurrent: () => 1,
  });
  try {
    const { job } = await store.create('window', { title: 'X', brief: 'x', writeScope: ['src/'], idempotencyKey: 'k' });
    await store.transition(job.id, 'failed', 'limit', { limitHit: true });
    await service.continueWith(job.id, 'codex', '## Handoff');
    assert.deepEqual(store.get(job.id)!.priorProviders, ['claude']);
    await store.transition(job.id, 'failed', 'limit', { limitHit: true });
    await service.continueWith(job.id, 'claude', '## Handoff again');
    assert.deepEqual(store.get(job.id)!.priorProviders, ['claude', 'codex'], 'codex is added; claude, already there, is not duplicated');
  } finally { await service.dispose(); await rm(store.file.replace(/[^/\\]+$/, ''), { recursive: true, force: true }); }
});

// ---- O6: both providers as one pool (docs/Heads.md, "Rigor") ----

test('O6: strict adds a review the project doesn\'t already have; quick and standard add nothing to the job itself', async () => {
  const reviewer = scriptedReviewer([{ verdict: 'pass', summary: 'Looks fine.', findings: [] }]);
  const f = await fixture({ checks: passCheck, gateRuntime: { runReviewer: reviewer.runReviewer }, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    const done = await helper.call('hydra_done', { summary: 'Rigor' });
    assert.equal(done.ok, true, done.error);
    helper.endTurn();
  } });
  try {
    // No rigor at all: today's behaviour, unchanged -- the project's own gate only.
    const plain = await f.start('plain');
    const [plainHead] = (await f.wait([plain.job_id])).heads;
    assert.deepEqual(plainHead.checks.map((check: { id: string }) => check.id), ['unit']);

    // "quick": explicitly asked for, still adds nothing beyond the project's own gate.
    const quick = await f.start('quick', { rigor: 'quick' });
    const [quickHead] = (await f.wait([quick.job_id])).heads;
    assert.deepEqual(quickHead.checks.map((check: { id: string }) => check.id), ['unit']);

    // "standard": nothing on the job itself; its plan gets one review of the combined work instead.
    const standard = await f.start('standard', { rigor: 'standard' });
    const [standardHead] = (await f.wait([standard.job_id])).heads;
    assert.deepEqual(standardHead.checks.map((check: { id: string }) => check.id), ['unit']);
    assert.equal(reviewer.specs.length, 0);

    // "strict": adds a review, since the project (passCheck) has none.
    const strict = await f.start('strict', { rigor: 'strict' });
    const [strictHead] = (await f.wait([strict.job_id])).heads;
    assert.deepEqual(strictHead.checks.map((check: { id: string; kind: string }) => [check.id, check.kind]), [['unit', 'command'], ['rigor-review', 'review']]);
    assert.equal(strictHead.state, 'done');
  } finally { await f.close(); }
});

test('O6: rigor never duplicates a review the project already runs', async () => {
  const reviewer = scriptedReviewer([{ verdict: 'pass', summary: 'Fine.', findings: [] }]);
  const f = await fixture({ gates: { gates: [fixedExists, { id: 'review', type: 'review', reviewer: 'other', focus: 'x' }] }, gateRuntime: { runReviewer: reviewer.runReviewer }, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    const result = await helper.call('hydra_done', { summary: 'Done' });
    assert.equal(result.ok, true, result.error);
    helper.endTurn();
  } });
  try {
    const started = await f.start('strict', { rigor: 'strict' });
    const [head] = (await f.wait([started.job_id])).heads;
    assert.deepEqual(head.checks.map((check: { id: string }) => check.id), ['unit', 'review'], 'no second, rigor-added review');
    assert.equal(reviewer.specs.length, 1);
  } finally { await f.close(); }
});

// ---- O2: scope contracts (docs/Heads.md, "Coordination") ----

test('hydra_start_head: names a running head with an overlapping write_scope, unless one depends on the other; never refuses', async () => {
  const f = await fixture({ script: async () => {} });
  try {
    const a = await f.start('a', { write_scope: ['src/shared/'] });
    assert.equal(a.scope_overlap, undefined, 'nothing running yet to overlap with');
    const b = await f.start('b', { write_scope: ['src/shared/util.ts'] });
    assert.deepEqual(b.scope_overlap, [{ job_id: a.job_id, title: 'Job a', path: 'src/shared/' }]);
    // A dependency between them excuses it, in either direction.
    const c = await f.start('c', { write_scope: ['src/shared/other.ts'], depends_on: [a.job_id] });
    assert.equal(c.scope_overlap, undefined, 'c depends on a');
    // A disjoint scope never overlaps.
    const d = await f.start('d', { write_scope: ['src/unrelated/'] });
    assert.equal(d.scope_overlap, undefined);
  } finally { await f.close(); }
});

// ---- O1: plans from the chat (docs/Heads.md, "Plans from the chat") ----

test('hydra_plan_* tools are refused when the window has no plans bridge', async () => {
  const f = await fixture({ script: async () => {} });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    const result = await call('hydra_plan_create', { title: 'A plan', jobs: [{ key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] }], idempotency_key: 'k1' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /Plans are not available/);
  } finally { await f.close(); }
});

test('hydra_plan_* tools need a bridge session (a lead token minted without one is refused)', async () => {
  const f = await fixture({ script: async () => {}, plans: {
    create: async () => { throw new Error('should not be called'); }, get: () => undefined,
    wait: async () => { throw new Error('should not be called'); }, amend: async () => { throw new Error('should not be called'); }, cancel: async () => { throw new Error('should not be called'); },
    message: async () => { throw new Error('should not be called'); }, integrate: async () => { throw new Error('should not be called'); }, merge: async () => { throw new Error('should not be called'); },
    run: async () => { throw new Error('should not be called'); }, report: async () => { throw new Error('should not be called'); },
  } });
  try {
    // fixture()'s own default lead token has no leadSessionId.
    const result = await f.call('hydra_plan_create', { title: 'A plan', jobs: [{ key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] }], idempotency_key: 'k1' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /no lead session/);
  } finally { await f.close(); }
});

/** A fake PlanLeadBridge, in memory, that records every call it gets. */
function fakePlanBridge() {
  const calls: { method: string; args: unknown[] }[] = [];
  const plans = new Map<string, any>();
  const bridge = {
    create: async (input: any, leadSessionId: string) => {
      calls.push({ method: 'create', args: [input, leadSessionId] });
      const plan = { planId: 'aaaaaaaa0001', title: input.title, state: 'running', jobs: input.jobs.map((job: any) => ({ key: job.key, title: job.title, status: 'active' })), board: [] as any[], amendments: [] as any[] };
      plans.set(plan.planId, plan);
      return { plan, created: true };
    },
    get: (id: string, leadSessionId: string) => { calls.push({ method: 'get', args: [id, leadSessionId] }); return plans.get(id); },
    wait: async (id: string, leadSessionId: string, maxWaitS: number, signal: AbortSignal) => {
      calls.push({ method: 'wait', args: [id, leadSessionId, maxWaitS, signal.aborted] });
      const plan = plans.get(id); if (!plan) throw new Error(`No plan ${id} in this window.`); return plan;
    },
    amend: async (id: string, leadSessionId: string, input: any) => {
      calls.push({ method: 'amend', args: [id, leadSessionId, input] });
      const plan = plans.get(id); if (!plan) throw new Error(`No plan ${id} in this window.`);
      if (input.add?.length) plan.jobs.push(...input.add.map((job: any) => ({ key: job.key, title: job.title, status: 'active' })));
      if (input.skip?.length) for (const skip of input.skip) { const job = plan.jobs.find((item: any) => item.key === skip.key); if (job) { job.status = 'skipped'; job.reason = skip.reason; } }
      return plan;
    },
    cancel: async (id: string, leadSessionId: string, reason: string) => {
      calls.push({ method: 'cancel', args: [id, leadSessionId, reason] });
      const plan = plans.get(id); if (!plan) throw new Error(`No plan ${id} in this window.`);
      plan.state = 'incomplete'; for (const job of plan.jobs) if (job.status === 'active') job.status = 'cancelled';
      return plan;
    },
    message: async (id: string, leadSessionId: string, input: any) => {
      calls.push({ method: 'message', args: [id, leadSessionId, input] });
      const plan = plans.get(id); if (!plan) throw new Error(`No plan ${id} in this window.`);
      plan.board.push({ id: 'b'.repeat(12), at: new Date().toISOString(), from: { kind: 'lead' }, to: input.to, ...(input.topic ? { topic: input.topic } : {}), body: input.body, untrusted: false });
      return plan;
    },
  };
  return { bridge: bridge as unknown as HelperServiceOptions['plans'], calls, plans };
}

test('hydra_plan_create parses jobs, delegates to the bridge with the calling session, and shapes the result', async () => {
  const { bridge, calls } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    const result = await call('hydra_plan_create', {
      title: 'Checkout refactor', brief: 'Split it up.',
      jobs: [{ key: 'schema', title: 'Schema', brief: 'Do the schema.', write_scope: ['src/schema/'] }, { key: 'api', title: 'API', brief: 'Do the api.', write_scope: ['src/api/'], depends_on: ['schema'], provider: 'codex' }],
      idempotency_key: 'plan-1',
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0]!.method, 'create');
    assert.equal(calls[0]!.args[1], 'abcdef012345', 'the calling session, not a made-up one');
    const input = calls[0]!.args[0] as any;
    assert.equal(input.idempotencyKey, 'plan-1');
    assert.equal(input.jobs[1].depends_on[0], 'schema');
    assert.equal(input.jobs[1].provider, 'codex');
    assert.deepEqual(result.result, { plan_id: 'aaaaaaaa0001', title: 'Checkout refactor', state: 'running', jobs: [{ key: 'schema', title: 'Schema', status: 'active' }, { key: 'api', title: 'API', status: 'active' }], created: true });
  } finally { await f.close(); }
});

test('hydra_plan_create refuses a job with no write_scope, and a plan with no jobs, before ever reaching the bridge', async () => {
  const { bridge, calls } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    const noScope = await call('hydra_plan_create', { title: 'X', jobs: [{ key: 'a', title: 'A', brief: 'Do a.' }], idempotency_key: 'k' });
    assert.equal(noScope.ok, false); assert.match(noScope.error!, /write_scope/);
    const noJobs = await call('hydra_plan_create', { title: 'X', jobs: [], idempotency_key: 'k2' });
    assert.equal(noJobs.ok, false); assert.match(noJobs.error!, /at least one job/);
    assert.equal(calls.length, 0, 'the bridge is never called for input that fails parsing');
  } finally { await f.close(); }
});

test('hydra_plan_create (O7): run "unattended" needs a budget, refused before ever reaching the bridge; a valid one is passed through', async () => {
  const { bridge, calls } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    const job = { key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] };
    const noBudget = await call('hydra_plan_create', { title: 'X', jobs: [job], idempotency_key: 'k1', run: 'unattended' });
    assert.equal(noBudget.ok, false); assert.match(noBudget.error!, /needs a budget/);
    const badRun = await call('hydra_plan_create', { title: 'X', jobs: [job], idempotency_key: 'k2', run: 'sideways' });
    assert.equal(badRun.ok, false); assert.match(badRun.error!, /"attended" or "unattended"/);
    assert.equal(calls.length, 0, 'the bridge is never called for input that fails parsing');
    const ok = await call('hydra_plan_create', { title: 'X', jobs: [job], idempotency_key: 'k3', run: 'unattended', budget: { usd: 20, wall_clock_minutes: 60 } });
    assert.equal(ok.ok, true);
    const input = calls[0]!.args[0] as any;
    assert.equal(input.run, 'unattended');
    assert.deepEqual(input.budget, { usd: 20, wall_clock_minutes: 60 });
  } finally { await f.close(); }
});

test("hydra_plan_get returns a job enriched with its head's own detail when it has started as a head", async () => {
  const { bridge, plans } = fakePlanBridge();
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const x = 1;\n');
    await helper.call('hydra_done', { summary: 'Added fixed.ts' });
    helper.endTurn();
  }, plans: bridge });
  try {
    const started = await f.start('for-plan');
    plans.set('aaaaaaaa0002', { planId: 'aaaaaaaa0002', title: 'Has a head', state: 'running', jobs: [{ key: 'a', title: 'A', status: 'active', jobId: started.job_id }], board: [], amendments: [] });
    await until(() => f.store.get(started.job_id)?.state === 'done', 'head done');
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const result = await callHelperEndpoint(f.endpoint.port, chat, 'hydra_plan_get', { plan_id: 'aaaaaaaa0002' });
    assert.equal(result.ok, true);
    const job = (result.result as any).jobs[0];
    assert.equal(job.head.job_id, started.job_id);
    assert.equal(job.head.state, 'done');
    assert.equal(job.head.summary, 'Added fixed.ts');
  } finally { await f.close(); }
});

test('hydra_plan_get on an unknown plan is a clear error, not a bare undefined', async () => {
  const { bridge } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const result = await callHelperEndpoint(f.endpoint.port, chat, 'hydra_plan_get', { plan_id: 'ffffffffffff' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /No plan/);
  } finally { await f.close(); }
});

test("hydra_plan_wait forwards max_wait_s (clamped) and the abort signal, and returns the bridge's plan", async () => {
  const { bridge, calls } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    await callHelperEndpoint(f.endpoint.port, chat, 'hydra_plan_create', { title: 'X', jobs: [{ key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] }], idempotency_key: 'k' });
    const result = await callHelperEndpoint(f.endpoint.port, chat, 'hydra_plan_wait', { plan_id: 'aaaaaaaa0001', max_wait_s: 999999 });
    assert.equal(result.ok, true);
    const waitCall = calls.find(c => c.method === 'wait')!;
    assert.equal(waitCall.args[2], 3000, 'max_wait_s is clamped the same way hydra_wait_for_heads clamps it');
  } finally { await f.close(); }
});

test('hydra_plan_amend parses add/edit/skip and delegates each list, and hydra_plan_cancel delegates a default reason', async () => {
  const { bridge, calls } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    await call('hydra_plan_create', { title: 'X', jobs: [{ key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] }], idempotency_key: 'k' });
    const amended = await call('hydra_plan_amend', {
      plan_id: 'aaaaaaaa0001',
      add: [{ key: 'b', title: 'B', brief: 'Do b.', write_scope: ['src/b/'] }],
      skip: [{ key: 'a', reason: 'Not needed any more.' }],
    });
    assert.equal(amended.ok, true, amended.error);
    const amendCall = calls.find(c => c.method === 'amend')!;
    assert.equal((amendCall.args[2] as any).add[0].key, 'b');
    assert.equal((amendCall.args[2] as any).skip[0].reason, 'Not needed any more.');
    const result = amended.result as any;
    assert.ok(result.jobs.some((job: any) => job.key === 'b'));
    assert.equal(result.jobs.find((job: any) => job.key === 'a').status, 'skipped');

    const cancelled = await call('hydra_plan_cancel', { plan_id: 'aaaaaaaa0001' });
    assert.equal(cancelled.ok, true, cancelled.error);
    const cancelCall = calls.find(c => c.method === 'cancel')!;
    assert.equal(cancelCall.args[2], 'Cancelled by the lead.');
    assert.equal((cancelled.result as any).state, 'incomplete');
  } finally { await f.close(); }
});

// ---- O5: plans that adapt (docs/Heads.md, "Plans that adapt") ----

test('hydra_plan_amend parses retry and delegates it, and refuses a malformed retry list before ever reaching the bridge', async () => {
  const { bridge, calls } = fakePlanBridge();
  const f = await fixture({ script: async () => {}, plans: bridge });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    await call('hydra_plan_create', { title: 'X', jobs: [{ key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] }], idempotency_key: 'k' });
    const retried = await call('hydra_plan_amend', { plan_id: 'aaaaaaaa0001', retry: [{ key: 'a', write_scope: ['src/wider/'], provider: 'codex' }] });
    assert.equal(retried.ok, true, retried.error);
    const retryCall = calls.find(c => c.method === 'amend' && (c.args[2] as any).retry)!;
    assert.equal((retryCall.args[2] as any).retry[0].key, 'a');
    assert.equal((retryCall.args[2] as any).retry[0].write_scope[0], 'src/wider/');
    assert.equal((retryCall.args[2] as any).retry[0].provider, 'codex');

    const noKey = await call('hydra_plan_amend', { plan_id: 'aaaaaaaa0001', retry: [{ write_scope: ['src/'] }] });
    assert.equal(noKey.ok, false); assert.match(noKey.error!, /needs a job key/);
    const badProvider = await call('hydra_plan_amend', { plan_id: 'aaaaaaaa0001', retry: [{ key: 'a', provider: 'gpt' }] });
    assert.equal(badProvider.ok, false); assert.match(badProvider.error!, /unknown provider/);
  } finally { await f.close(); }
});

// ---- O4: the plan board (docs/Heads.md, "The plan board") ----

/**
 * A minimal PlanLeadBridge + PlanBoardBridge sharing one in-memory plan store, the same
 * way extension.ts's two bridges share one real PlanStore. attachJob simulates a plan
 * job actually starting as a head (extension.ts's jobPlanFor finds it the same way,
 * by which plan job carries the head's job id).
 */
function fakePlanWorld() {
  const plans = new Map<string, any>();
  const untrust = (post: any, key: string) => ({ ...post, untrusted: !(post.from.kind === 'job' && post.from.key === key) });
  const leadBridge = {
    create: async (input: any) => {
      const plan = { planId: 'aaaaaaaa0003', title: input.title, state: 'running', jobs: input.jobs.map((job: any) => ({ key: job.key, title: job.title, status: 'active' })), board: [] as any[], amendments: [] as any[] };
      plans.set(plan.planId, plan);
      return { plan, created: true };
    },
    get: (id: string) => plans.get(id),
    wait: async (id: string) => plans.get(id),
    amend: async (id: string) => plans.get(id),
    cancel: async (id: string) => plans.get(id),
    message: async (id: string, _leadSessionId: string, input: any) => {
      const plan = plans.get(id); if (!plan) throw new Error(`No plan ${id}.`);
      plan.board.push({ id: 'm'.repeat(12), at: new Date().toISOString(), from: { kind: 'lead' }, to: input.to, ...(input.topic ? { topic: input.topic } : {}), body: input.body });
      return { ...plan, board: plan.board.map((post: any) => untrust(post, '')) };
    },
  };
  const boardBridge = {
    jobPlan: (jobId: string) => {
      for (const plan of plans.values()) { const job = plan.jobs.find((item: any) => item.jobId === jobId); if (job) return { planId: plan.planId, jobKey: job.key }; }
      return undefined;
    },
    post: async (planId: string, input: any) => {
      const plan = plans.get(planId); if (!plan) throw new Error(`No plan ${planId}.`);
      plan.board.push({ id: 'p'.repeat(12), at: new Date().toISOString(), ...input });
    },
    boardFor: (planId: string, jobKey: string) => {
      const plan = plans.get(planId); if (!plan) return [];
      return plan.board.filter((post: any) => post.to === 'all' || (Array.isArray(post.to) && post.to.includes(jobKey)) || (post.from.kind === 'job' && post.from.key === jobKey)).map((post: any) => untrust(post, jobKey));
    },
  };
  const attachJob = (planId: string, key: string, jobId: string) => { plans.get(planId).jobs.find((job: any) => job.key === key).jobId = jobId; };
  return { plans, leadBridge: leadBridge as unknown as HelperServiceOptions['plans'], planBoard: boardBridge as unknown as HelperServiceOptions['planBoard'], attachJob };
}

test('hydra_share/hydra_board: a job reads the lead\'s message and its own share; a post from elsewhere is untrusted, its own isn\'t', async () => {
  const world = fakePlanWorld();
  let boardResult: any;
  const f = await fixture({ plans: world.leadBridge, planBoard: world.planBoard, script: async helper => {
    // Retries because the test attaches this head to its plan job right after hydra_start_head returns,
    // which can land after this script's first tick.
    let shared: any; for (let i = 0; i < 100 && !shared?.ok; i++) { shared = await helper.call('hydra_share', { topic: 'Schema', body: 'The schema is in db/schema.sql.' }); if (!shared.ok) await new Promise(resolve => setTimeout(resolve, 20)); }
    boardResult = await helper.call('hydra_board');
    helper.endTurn();
  } });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    await call('hydra_plan_create', { title: 'X', jobs: [{ key: 'a', title: 'A', brief: 'x', write_scope: ['src/'] }, { key: 'b', title: 'B', brief: 'x', write_scope: ['src/b/'] }], idempotency_key: 'k' });
    await call('hydra_plan_message', { plan_id: 'aaaaaaaa0003', to: 'all', body: 'Welcome to the plan.' });
    await call('hydra_plan_message', { plan_id: 'aaaaaaaa0003', to: ['b'], body: 'Only for b.' });
    const started = await f.start('for-board');
    world.attachJob('aaaaaaaa0003', 'a', started.job_id);
    await until(() => boardResult !== undefined, 'the head read its board');
    assert.equal(boardResult.ok, true, boardResult.error);
    const posts = boardResult.result.posts as any[];
    assert.deepEqual(posts.map(post => post.body), ['Welcome to the plan.', 'The schema is in db/schema.sql.'], '"Only for b." is addressed to job b, not a');
    assert.deepEqual(posts.map(post => post.untrusted), [true, false], 'the lead\'s message is untrusted; its own share isn\'t');
  } finally { await f.close(); }
});

test('hydra_plan_message validates its arguments before reaching the bridge; hydra_share/hydra_board refuse a loose head', async () => {
  const world = fakePlanWorld();
  const f = await fixture({ plans: world.leadBridge, planBoard: world.planBoard, script: async () => {} });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    const badTo = await call('hydra_plan_message', { plan_id: 'aaaaaaaa0003', to: 'nobody', body: 'x' });
    assert.equal(badTo.ok, false); assert.match(badTo.error!, /"all" or a list/);
    const noBody = await call('hydra_plan_message', { plan_id: 'aaaaaaaa0003', to: 'all' });
    assert.equal(noBody.ok, false); assert.match(noBody.error!, /body must be/);
    // A loose head (this window has no plan bridge at all) has no board.
    let sharedResult: any, boardResult: any;
    const g = await fixture({ script: async helper => {
      sharedResult = await helper.call('hydra_share', { body: 'x' });
      boardResult = await helper.call('hydra_board');
      helper.endTurn();
    } });
    try {
      await g.start('loose');
      await until(() => !!sharedResult && !!boardResult, 'the loose head tried both board tools');
      assert.equal(sharedResult.ok, false); assert.match(sharedResult.error!, /plan board is not available/);
      assert.equal(boardResult.ok, false); assert.match(boardResult.error!, /plan board is not available/);
    } finally { await g.close(); }
  } finally { await f.close(); }
});

test('hydra_progress/hydra_done: name how many board posts are waiting (excluding this job\'s own), only when there are any', async () => {
  const world = fakePlanWorld();
  let progressResult: any, doneResult: any;
  const f = await fixture({ checks: passCheck, plans: world.leadBridge, planBoard: world.planBoard, script: async helper => {
    let progressed: any; for (let i = 0; i < 100 && !progressed?.ok; i++) { progressed = await helper.call('hydra_progress', { note: 'Starting.' }); if (!progressed.ok) await new Promise(resolve => setTimeout(resolve, 20)); }
    progressResult = progressed;
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    doneResult = await helper.call('hydra_done', { summary: 'Added fixed.ts' });
    helper.endTurn();
  } });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(f.endpoint.port, chat, tool, args);
    await call('hydra_plan_create', { title: 'X', jobs: [{ key: 'a', title: 'A', brief: 'x', write_scope: ['src/'] }], idempotency_key: 'k' });
    await call('hydra_plan_message', { plan_id: 'aaaaaaaa0003', to: 'all', body: 'Read this.' });
    const started = await f.start('for-progress');
    world.attachJob('aaaaaaaa0003', 'a', started.job_id);
    await until(() => !!progressResult, 'progress reported');
    assert.equal(progressResult.result.board_posts, 1);
    await until(() => !!doneResult, 'done reported');
    assert.equal(doneResult.result.board_posts, 1);
  } finally { await f.close(); }
});

// ---- O3: landing a plan together (docs/Heads.md, "Landing a plan together") ----

test('O3: after a restart, a plan\'s head that was waiting for an answer goes back in the queue in its own worktree; a loose head still fails', async () => {
  let planHead = '';
  const prompts = new Map<string, string>();
  const f = await fixture({
    script: async helper => { prompts.set(helper.spec.worktree, helper.spec.prompt); },
    planBoard: { jobPlan: id => id === planHead ? { planId: 'aaaaaaaaaaaa', jobKey: 'api' } : undefined, post: async () => undefined, boardFor: () => [] },
  });
  try {
    const base = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    // Two heads that were blocked on a question when Hydra stopped (as jobs.json has them after a restart).
    const blocked = async (key: string) => {
      const { job } = await f.store.create('window', { title: `Job ${key}`, brief: 'Build the API.', writeScope: ['src/'], idempotencyKey: key, provider: 'codex' });
      await f.store.transition(job.id, 'starting');
      await f.store.transition(job.id, 'running', undefined, { worktree: path.join(f.root, `wt-${key}`), branch: `agent/${key}`, baseCommit: base });
      await f.store.transition(job.id, 'blocked', 'Needs a decision.', { question: 'REST or GraphQL?' });
      return job.id;
    };
    planHead = await blocked('api');
    const loose = await blocked('loose');
    await f.service.recover();
    assert.equal(f.store.get(loose)!.state, 'failed');
    assert.match(f.store.get(loose)!.reason!, /Hydra restarted while this head was waiting for an answer/);
    await until(() => prompts.has(path.join(f.root, 'wt-api')), 'the plan head restarted in its own worktree');
    const job = f.store.get(planHead)!;
    assert.notEqual(job.state, 'failed');
    assert.deepEqual(job.history.slice(-4).map(event => event.to), ['failed', 'queued', 'starting', 'running'], 'back through the queue, not left failed');
    assert.equal(job.question, undefined);
    const prompt = prompts.get(path.join(f.root, 'wt-api'))!;
    assert.match(prompt, /## Restarted/);
    assert.match(prompt, /REST or GraphQL\?/);
  } finally { await f.close(); }
});

test('O3: runIntegrationGate runs the project\'s command gates on the integrated tree, in a worktree it removes afterwards', async () => {
  const f = await fixture({ script: async () => {}, gates: { gates: [{ id: 'unit', type: 'command', command: [process.execPath, '-e', "process.exit(require('fs').existsSync('src/landed.ts') ? 0 : 1)"] }] } });
  try {
    const base = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    await git(f.repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(path.join(f.repo, 'src', 'landed.ts'), 'export const landed = true;\n');
    await git(f.repo, ['add', '.']); await git(f.repo, ['commit', '-qm', 'landed']);
    const tip = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    await git(f.repo, ['checkout', '-q', 'main']);
    const ran = await f.service.runIntegrationGate({ planId: 'aaaaaaaaaaaa', title: 'Checkout', base, tip, review: false, providers: ['claude', 'codex'] });
    assert.equal(ran.configured, 'file');
    assert.deepEqual(ran.checks.map(check => [check.id, check.state]), [['unit', 'passed']]);
    const onBase = await f.service.runIntegrationGate({ planId: 'aaaaaaaaaaaa', title: 'Checkout', base, tip: base, review: false, providers: ['claude'] });
    assert.deepEqual(onBase.checks.map(check => [check.id, check.state]), [['unit', 'failed']]);
    assert.doesNotMatch(await git(f.repo, ['worktree', 'list', '--porcelain']), /ig-aaaaaaaaaaaa/, 'its worktree is gone');
    assert.equal(await git(f.repo, ['status', '--porcelain=v1']), '', 'the main checkout is untouched');
  } finally { await f.close(); }
});

test('O3: a plan head re-queued after a conflict starts from the given commit, with its previous try merged in and the conflicting file marked', async () => {
  let content: string | undefined;
  const f = await fixture({ script: async helper => { content = await readFile(path.join(helper.spec.worktree, 'src', 'a.ts'), 'utf8'); } });
  try {
    const main = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    const side = async (branch: string, text: string) => {
      await git(f.repo, ['checkout', '-q', '-b', branch, main]);
      await writeFile(path.join(f.repo, 'src', 'a.ts'), text);
      await writeFile(path.join(f.repo, 'src', `${branch}.ts`), `${branch}\n`);
      await git(f.repo, ['add', '.']); await git(f.repo, ['commit', '-qm', branch]);
      const commit = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
      await git(f.repo, ['checkout', '-q', 'main']);
      return commit;
    };
    const tip = await side('landed', 'export const a = 2;\n');
    const previous = await side('previous', 'export const a = 3;\n');
    const started = await f.service.startForPlan({ title: 'Job right', brief: 'Do it.', write_scope: ['src/'], idempotency_key: 'plan-x-right-r1' }, 'plan-aaaaaaaaaaaa', [], 'claude', { baseCommit: tip, carry: previous }) as { job_id: string; base_commit: string };
    assert.equal(started.base_commit, tip);
    await until(() => content !== undefined, 'the head started');
    assert.match(content!, /<<<<<<<[\s\S]*export const a = 2;[\s\S]*=======[\s\S]*export const a = 3;[\s\S]*>>>>>>>/);
    const worktree = f.store.get(started.job_id)!.worktree!;
    assert.equal((await readFile(path.join(worktree, 'src', 'previous.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'previous\n', 'the clean part of its previous try carried over');
    assert.equal((await git(worktree, ['rev-parse', 'HEAD'])).trim(), tip, 'nothing is committed for it');
    await assert.rejects(f.service.startForPlan({ title: 'Bad', brief: 'x', write_scope: ['src/'], idempotency_key: 'bad' }, 'plan-aaaaaaaaaaaa', [], 'claude', { baseCommit: 'nope' }), /start commit is malformed/);
  } finally { await f.close(); }
});

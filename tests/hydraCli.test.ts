import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, userPlanSession, type HelperServiceOptions, type PlanLeadPlan } from '../src/core/helperService';
import { writeWindowRecord } from '../src/core/helperDiscovery';
import { JobStore } from '../src/core/jobs';
import { createUserVerifier } from '../src/core/leadVerification';
import { findUserHandshake, writeUserHandshake } from '../src/core/userHandshake';
import { exitCodes, helpersRootCandidates, parseArgs, planFileArguments, planFileSchema, runCli, type CliDeps } from '../src/core/hydraCli';
import { toolAllowed } from '../src/core/helperTools';

/**
 * O8b: the `hydra` command (docs/Heads.md, "Scripts and CI"; docs/THREAT_MODEL.md). Every command below runs against
 * a real endpoint, with a user token the endpoint really minted, read from a real handshake file (owner-only, checked
 * with the real icacls on Windows) that a real discovery record points at; the endpoint checks the calling process
 * with the same verifier a Hydra window uses. The bundle itself (dist/hydra-cli.cjs) runs once as its own process.
 */

const windows = process.platform === 'win32';
const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
const planId = 'aaaaaaaa0001';

interface World {
  root: string; repo: string; helpers: string; port: number; token: string;
  control: string[]; created: Record<string, unknown>[]; plan: PlanLeadPlan;
  cli(argv: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-cli-'));
  const repo = path.join(root, 'repo'), helpers = path.join(root, 'helpers');
  await mkdir(path.join(repo, '.hydra', 'plans'), { recursive: true });
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  const plan: PlanLeadPlan = { planId, title: 'Checkout', state: 'running', jobs: [{ key: 'api', title: 'API', status: 'active' }], board: [], amendments: [] };
  const created: Record<string, unknown>[] = [];
  const control: string[] = [];
  const own = (id: string, session: string) => { if (session !== userPlanSession || id !== planId) throw new Error(`No plan ${id} in this window.`); return plan; };
  const plans = {
    create: async (input: Record<string, unknown>, session: string) => { created.push({ ...input, session }); return { plan, created: true }; },
    get: (id: string, session: string) => (session === userPlanSession && id === planId ? plan : undefined),
    wait: async (id: string, session: string) => own(id, session),
    amend: async (id: string, session: string) => own(id, session),
    cancel: async (id: string, session: string) => { own(id, session); plan.state = 'incomplete'; return plan; },
    message: async (id: string, session: string) => own(id, session),
    integrate: async () => { throw new Error('not for scripts'); },
    merge: async () => { throw new Error('not for scripts'); },
    run: async (id: string, session: string) => { own(id, session); if (plan.state !== 'draft' && plan.state !== 'incomplete') throw new Error(`Plan "${plan.title}" is ${plan.state}; only a draft or an incomplete plan can be run.`); plan.state = 'running'; return plan; },
    report: async (id: string, session: string) => { own(id, session); return `# ${plan.title}\n\nUnattended plan, finished.`; },
  } as unknown as HelperServiceOptions['plans'];
  let service!: HelperService;
  // The same process check a Hydra window runs on a user token: refused from inside a head (none here).
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal), {
    leadKey: 'window', verifyUser: createUserVerifier(() => ({ deniedAncestors: new Set<number>() })),
  });
  const port = await endpoint.start();
  service = new HelperService({
    store, endpoint, leadFolder: repo, leadKey: 'window', executable: async provider => `fake-${provider}`, bridge: { command: 'x', args: [] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => 1, startRun: () => { throw new Error('no heads in this test'); }, plans,
    lanes: { describe: async () => ({ lanes: [{ id: 'l1' }] }), name: () => undefined },
    control: { stopAll: async reason => { control.push(`stop: ${reason}`); return { heads: 2, lanes: 1 }; }, resume: async () => { control.push('resume'); } },
  });
  // What a Hydra window does when its heads start: one user token, written only to its handshake file.
  const token = endpoint.issue({ role: 'user', leadKey: 'window', leadSessionId: userPlanSession });
  const record = await writeWindowRecord(helpers, { port, pid: process.pid, folders: [repo] });
  await writeUserHandshake(helpers, { pid: process.pid, port, token, repository: repo });
  const cli = async (argv: string[], cwd = repo) => {
    let stdout = '', stderr = '';
    const deps: CliDeps = {
      cwd, helpersRoots: [helpers], findHandshake: findUserHandshake, call: callHelperEndpoint,
      readFile: file => readFile(file, 'utf8').catch(() => undefined), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => Date.now(), randomKey: () => 'r4nd0m', version: '9.9.9', pollMs: 10,
      stdout: text => { stdout += `${text}\n`; }, stderr: text => { stderr += `${text}\n`; },
    };
    const code = await runCli(argv, deps);
    return { code, stdout, stderr };
  };
  return {
    root, repo, helpers, port, token, control, created, plan, cli,
    close: async () => { await endpoint.close(); await rm(record, { force: true }); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}

const planFile = { $schema: '../../schemas/hydra-plan.schema.json', title: 'Checkout', brief: 'Split it.', jobs: [{ key: 'api', title: 'API', brief: 'Build it.', write_scope: ['src/api/'] }, { key: 'ui', title: 'UI', brief: 'Show it.', write_scope: ['src/ui/'], depends_on: ['api'] }] };

test('hydra status, heads, stop and resume run against the window that owns this folder, with its real user token', async () => {
  const w = await world();
  try {
    const status = await w.cli(['status', '--json']);
    assert.equal(status.code, exitCodes.ok, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), { repository: w.repo, window: { pid: process.pid, port: w.port }, heads: {}, lanes: 1 });
    const deep = await w.cli(['status'], path.join(w.repo, 'src', 'deep'));
    assert.equal(deep.code, exitCodes.ok, 'any folder inside the repository finds its window');
    assert.match(deep.stdout, /owns .*repo/);
    const heads = await w.cli(['heads', '--json']);
    assert.deepEqual(JSON.parse(heads.stdout), { heads: [] });
    assert.equal((await w.cli(['stop', '--reason', 'nightly'])).code, exitCodes.ok);
    assert.equal((await w.cli(['resume'])).code, exitCodes.ok);
    assert.deepEqual(w.control, ['stop: Stopped from a script: nightly', 'resume']);
  } finally { await w.close(); }
});

test('hydra plan run takes a plan file, checks it with hydra_plan_create\'s own code first, and sends exactly that', async () => {
  const w = await world();
  try {
    await writeFile(path.join(w.repo, '.hydra', 'plans', 'checkout.json'), JSON.stringify(planFile));
    const run = await w.cli(['plan', 'run', 'checkout', '--unattended', '--usd', '40', '--minutes', '90', '--json']);
    assert.equal(run.code, exitCodes.ok, run.stderr);
    assert.equal(JSON.parse(run.stdout).plan_id, planId);
    const { session, ...sent } = w.created[0]!;
    assert.equal(session, userPlanSession, 'a script\'s plan belongs to the user role');
    assert.deepEqual(sent, {
      title: 'Checkout', brief: 'Split it.', idempotencyKey: 'hydra-cli-r4nd0m', run: 'unattended', budget: { usd: 40, wall_clock_minutes: 90 },
      jobs: [{ key: 'api', title: 'API', brief: 'Build it.', write_scope: ['src/api/'] }, { key: 'ui', title: 'UI', brief: 'Show it.', write_scope: ['src/ui/'], depends_on: ['api'] }],
    });
    // Refused before any Hydra is asked, by the same checks hydra_plan_create runs.
    await writeFile(path.join(w.repo, 'overlap.json'), JSON.stringify({ ...planFile, jobs: [planFile.jobs[0], { ...planFile.jobs[1], depends_on: [], write_scope: ['src/api/'] }] }));
    const overlap = await w.cli(['plan', 'run', 'overlap.json']);
    assert.equal(overlap.code, exitCodes.usage);
    assert.match(overlap.stderr, /both change src\/api/);
    await writeFile(path.join(w.repo, 'cycle.json'), JSON.stringify({ ...planFile, jobs: [{ ...planFile.jobs[0], depends_on: ['ui'] }, planFile.jobs[1]] }));
    assert.match((await w.cli(['plan', 'run', 'cycle.json'])).stderr, /cycle/);
    await writeFile(path.join(w.repo, 'extra.json'), JSON.stringify({ ...planFile, rogue: true }));
    assert.match((await w.cli(['plan', 'run', 'extra.json'])).stderr, /fields a plan doesn't: rogue/);
    await writeFile(path.join(w.repo, 'bad.json'), '{ not json');
    assert.equal((await w.cli(['plan', 'run', 'bad.json'])).code, exitCodes.usage);
    const unattendedNoBudget = await w.cli(['plan', 'run', 'checkout', '--unattended']);
    assert.equal(unattendedNoBudget.code, exitCodes.usage);
    assert.match(unattendedNoBudget.stderr, /budget needs at least one/);
    assert.equal(w.created.length, 1, 'nothing refused reached Hydra');
  } finally { await w.close(); }
});

test('hydra plan run <id>, show, cancel and report reach only the user role\'s own plans', async () => {
  const w = await world();
  try {
    const show = await w.cli(['plan', 'show', planId]);
    assert.equal(show.code, exitCodes.ok, show.stderr);
    assert.match(show.stdout, /Plan aaaaaaaa0001 "Checkout": running/);
    const running = await w.cli(['plan', 'run', planId]);
    assert.equal(running.code, exitCodes.refused, 'a running plan can\'t be run again');
    assert.match(running.stderr, /only a draft or an incomplete plan/);
    assert.equal((await w.cli(['plan', 'cancel', planId, '--reason', 'enough'])).code, exitCodes.ok);
    const again = await w.cli(['plan', 'run', planId, '--json']);
    assert.equal(again.code, exitCodes.ok, again.stderr);
    assert.equal(JSON.parse(again.stdout).state, 'running', 'an incomplete plan runs its failed jobs again');
    const report = await w.cli(['report', planId]);
    assert.equal(report.code, exitCodes.ok);
    assert.match(report.stdout, /^# Checkout/);
    const other = await w.cli(['plan', 'show', 'bbbbbbbbbbbb']);
    assert.equal(other.code, exitCodes.refused);
    assert.match(other.stderr, /No plan bbbbbbbbbbbb/);
  } finally { await w.close(); }
});

test('hydra plan wait exits 0 only when the integration gate passed on the finished plan', async () => {
  const w = await world();
  try {
    const gate = (passed: boolean, settled = true) => ({ branch: 'hydra/plan-aaaaaaaa0001', base_commit: 'a'.repeat(40), tip: 'b'.repeat(40), landed: ['api'], queue: [], gate: { label: passed ? 'Passed required gates' : 'Integration gate failed' }, can_merge: passed, passed, settled });
    w.plan.state = 'done'; w.plan.integration = gate(true);
    const passed = await w.cli(['plan', 'wait', planId, '--json']);
    assert.equal(passed.code, exitCodes.ok, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).passed, true);
    w.plan.integration = gate(false);
    const failed = await w.cli(['plan', 'wait', planId]);
    assert.equal(failed.code, exitCodes.refused);
    assert.match(failed.stdout, /didn't pass: Integration gate failed/);
    delete w.plan.integration;
    const none = await w.cli(['plan', 'wait', planId]);
    assert.equal(none.code, exitCodes.refused, 'no integration gate never counts as passed');
    w.plan.state = 'running';
    const timedOut = await w.cli(['plan', 'wait', planId, '--timeout', '1']);
    assert.equal(timedOut.code, exitCodes.refused);
    assert.match(timedOut.stdout, /Timed out after 1s/);
  } finally { await w.close(); }
});

test('hydra\'s exit codes: 2 for usage, 3 when no Hydra window owns the folder, 1 when Hydra refuses', async () => {
  const w = await world();
  try {
    assert.equal((await w.cli([])).code, exitCodes.usage);
    assert.equal((await w.cli(['--help'])).code, exitCodes.ok);
    assert.equal((await w.cli(['frobnicate'])).code, exitCodes.usage);
    assert.equal((await w.cli(['plan', 'show', 'not-an-id'])).code, exitCodes.usage);
    assert.equal((await w.cli(['status', '--bogus'])).code, exitCodes.usage);
    assert.equal((await w.cli(['plan', 'run', 'missing.json'])).code, exitCodes.usage);
    const elsewhere = await w.cli(['status', '--json'], w.root);
    assert.equal(elsewhere.code, exitCodes.noHydra);
    assert.deepEqual(JSON.parse(elsewhere.stdout), { ok: false, exit_code: 3, error: `No open Hydra window owns ${w.root}. Open this repository in Hydra first.` });
    assert.equal((await w.cli(['plan', 'show', 'cccccccccccc'])).code, exitCodes.refused);
  } finally { await w.close(); }
});

test('a handshake with the wrong access list is refused, and the user token can\'t call a head\'s or a lane\'s tools', { skip: !windows }, async () => {
  const w = await world();
  try {
    for (const tool of ['hydra_done', 'hydra_stuck', 'hydra_progress', 'hydra_share', 'hydra_board', 'hydra_job_ready', 'hydra_start_head', 'hydra_plan_merge', 'hydra_plan_integrate']) {
      assert.equal(toolAllowed('user', tool), false, tool);
      const response = await callHelperEndpoint(w.port, w.token, tool, {});
      assert.equal(response.ok, false, tool);
      assert.match(response.error!, /not available to a Hydra user/, tool);
    }
    const file = path.join(w.helpers, 'handshakes', `${process.pid}-${w.port}.json`);
    const widened = spawnSync(icacls, [file, '/grant', '*S-1-1-0:R'], { windowsHide: true });
    assert.equal(widened.status, 0, widened.stderr.toString());
    const refused = await w.cli(['status']);
    assert.equal(refused.code, exitCodes.refused);
    assert.match(refused.stderr, /Hydra refused the handshake file: someone other than you has access to it/);
  } finally { await w.close(); }
});

test('the built hydra-cli.cjs is the same command, run as its own process', async () => {
  const bundle = path.join(process.cwd(), 'dist', 'hydra-cli.cjs');
  const w = await world();
  try {
    // Asynchronously: this process is also the Hydra window the bundle calls.
    const run = (args: string[], cwd: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bundle, ...args], { cwd, windowsHide: true, env: { ...process.env, HYDRA_HELPERS_DIR: w.helpers } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('error', reject);
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    const status = await run(['status', '--json'], w.repo);
    assert.equal(status.status, exitCodes.ok, status.stderr);
    assert.equal(JSON.parse(status.stdout).repository, w.repo);
    assert.equal((await run(['status'], w.root)).status, exitCodes.noHydra);
    assert.equal((await run(['plan'], w.repo)).status, exitCodes.usage);
    assert.equal((await run(['plan', 'show', 'dddddddddddd'], w.repo)).status, exitCodes.refused);
  } finally { await w.close(); }
});

test('where the hydra command looks for Hydra: HYDRA_HELPERS_DIR alone, else a portable install, the app, then VS Code', () => {
  assert.deepEqual(helpersRootCandidates({ HYDRA_HELPERS_DIR: 'X:\\h', APPDATA: 'A:\\' }, 'win32', 'H:\\'), ['X:\\h']);
  const storage = (base: string) => path.join(base, 'User', 'globalStorage', 'nico-dunlap.hydra-agent-manager', 'helpers');
  assert.deepEqual(helpersRootCandidates({ APPDATA: 'A:\\roaming' }, 'win32', 'H:\\', 'C:\\Hydra', true), [
    storage(path.join('C:\\Hydra', 'data', 'user-data')), storage(path.join('A:\\roaming', 'Hydra')), storage(path.join('A:\\roaming', 'Code')), storage(path.join('A:\\roaming', 'Code - Insiders')),
  ]);
  assert.equal(helpersRootCandidates({ APPDATA: 'A:\\roaming' }, 'win32', 'H:\\', 'C:\\Hydra', false).length, 3, 'no data folder, not portable');
  assert.equal(helpersRootCandidates({}, 'linux', homedir())[0], storage(path.join(homedir(), '.config', 'Hydra')));
});

test('the hydra command\'s arguments: flags anywhere, values inline or after, and nothing unknown', () => {
  const parsed = parseArgs(['plan', '--json', 'wait', 'abcdefabcdef', '--timeout=30']);
  assert.deepEqual(parsed.command, ['plan', 'wait']);
  assert.deepEqual(parsed.positionals, ['abcdefabcdef']);
  assert.equal(parsed.flags.get('timeout'), '30');
  assert.equal(parsed.flags.get('json'), true);
  assert.throws(() => parseArgs(['stop', '--reason']), /--reason needs a value/);
  assert.throws(() => parseArgs(['stop', '--json=1']), /takes no value/);
  assert.throws(() => parseArgs(['status', '--nope']), /Unknown option --nope/);
});

test('a plan file\'s budget flags win over the file\'s, and a file\'s own idempotency key makes running it again return the same plan', () => {
  const file = JSON.stringify({ ...planFile, run: 'unattended', budget: { usd: 10, max_jobs: 4 }, idempotency_key: 'nightly-1' });
  const args = planFileArguments(file, 'p.json', { usd: 25 }, () => 'unused');
  assert.equal(args.idempotency_key, 'nightly-1');
  assert.deepEqual(args.budget, { usd: 25, max_jobs: 4 });
  assert.equal(args.run, 'unattended');
  assert.equal(planFileArguments(JSON.stringify(planFile), 'p.json', { key: 'mine' }, () => 'unused').idempotency_key, 'mine');
});

test('schemas/hydra-plan.schema.json is hydra_plan_create\'s own schema, as a plan file (regenerate it from planFileSchema() if this fails)', async () => {
  const published = JSON.parse(await readFile(path.join(process.cwd(), 'schemas', 'hydra-plan.schema.json'), 'utf8'));
  assert.deepEqual(published, planFileSchema(), JSON.stringify(planFileSchema(), null, 2));
  assert.deepEqual(published.required, ['title', 'jobs'], 'the idempotency key is optional in a file');
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.jsonValidation, [{ fileMatch: '.hydra/plans/*.json', url: './schemas/hydra-plan.schema.json' }]);
});

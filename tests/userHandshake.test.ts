import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HelperEndpoint, callHelperEndpoint, requestLeadSession, type HelperCaller } from '../src/core/helperEndpoint';
import { HelperService, userPlanSession, type HelperServiceOptions } from '../src/core/helperService';
import { toolAllowed, toolsFor } from '../src/core/helperTools';
import { writeWindowRecord } from '../src/core/helperDiscovery';
import { JobStore } from '../src/core/jobs';
import { createUserVerifier, evaluateUserChain, type ProcessLink } from '../src/core/leadVerification';
import {
  aclProblem, findUserHandshake, handshakeDirectory, handshakeFileName, handshakeProblem, parseHandshake, parseIcacls,
  readUserHandshake, sweepStaleHandshakes, writeUserHandshake, type UserHandshake,
} from '../src/core/userHandshake';

/**
 * O8a (docs/Heads.md, "Scripts and CI"; docs/THREAT_MODEL.md, HSEC-60 to HSEC-62): the user role,
 * its token and its handshake file. The access-list tests write a real file and run the real
 * icacls against it on Windows (a file mode elsewhere); the staleness tests use a real process
 * that has really exited.
 */

const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
const windows = process.platform === 'win32';
const token = 'T'.repeat(43);

async function temp(prefix: string): Promise<string> { return mkdtemp(path.join(tmpdir(), prefix)); }
/** The pid of a process that has really exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid!;
}
function postRaw(port: number, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers: { 'content-length': 0 } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on('error', reject); request.end();
  });
}

// ---- The role ----

test('the user role: the plan tools, reading heads and lanes, stop, resume and close; never a head\'s or a lane\'s tool', () => {
  assert.deepEqual(toolsFor('user').map(tool => tool.name).sort(), [
    'hydra_close', 'hydra_get_head', 'hydra_lanes', 'hydra_list_heads',
    'hydra_plan_amend', 'hydra_plan_cancel', 'hydra_plan_create', 'hydra_plan_get', 'hydra_plan_message', 'hydra_plan_report', 'hydra_plan_run', 'hydra_plan_wait',
    'hydra_resume', 'hydra_stop_all',
  ]);
  // Only a head does these; only a lane does hydra_job_ready; a lead's own-head actions stay the chat's; and
  // landing a plan on your branch (O3) stays with you on the canvas, or a chat.
  for (const name of ['hydra_done', 'hydra_stuck', 'hydra_progress', 'hydra_share', 'hydra_board', 'hydra_job_ready', 'hydra_start_head', 'hydra_reply_to_head', 'hydra_cancel_head', 'hydra_active_roles', 'hydra_wait_for_heads', 'hydra_plan_merge', 'hydra_plan_integrate']) {
    assert.equal(toolAllowed('user', name), false, name);
  }
  // Stop, resume and closing the window are the user's alone.
  for (const role of ['lead', 'helper'] as const) {
    assert.equal(toolAllowed(role, 'hydra_close'), false, role);
    assert.equal(toolAllowed(role, 'hydra_stop_all'), false, role);
    assert.equal(toolAllowed(role, 'hydra_resume'), false, role);
  }
});

test('a user token reaches the plan tools and stop/resume, and is refused hydra_done, hydra_stuck and hydra_job_ready', async () => {
  const root = await temp('hydra-user-role-');
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  const planCalls: { method: string; session: string }[] = [];
  const plan = { planId: 'aaaaaaaa0001', title: 'P', state: 'running', jobs: [], board: [], amendments: [] };
  const plans = {
    create: async (_input: unknown, session: string) => { planCalls.push({ method: 'create', session }); return { plan, created: true }; },
    get: (id: string, session: string) => { planCalls.push({ method: 'get', session }); return session === userPlanSession && id === plan.planId ? plan : undefined; },
    wait: async (_id: string, session: string) => { planCalls.push({ method: 'wait', session }); return plan; },
    amend: async (_id: string, session: string) => { planCalls.push({ method: 'amend', session }); return plan; },
    cancel: async (_id: string, session: string) => { planCalls.push({ method: 'cancel', session }); return plan; },
    message: async (_id: string, session: string) => { planCalls.push({ method: 'message', session }); return plan; },
  } as unknown as HelperServiceOptions['plans'];
  const control: string[] = [];
  const handled: { role: string; tool: string }[] = [];
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => { handled.push({ role: caller.role, tool }); return service.handle(caller, tool, args, signal); }, {
    leadKey: 'window', verifyUser: async () => ({ ok: true }), verifyLead: async () => ({ ok: true }),
  });
  const port = await endpoint.start();
  service = new HelperService({
    store, endpoint, leadFolder: root, leadKey: 'window', executable: async provider => `fake-${provider}`, bridge: { command: 'x', args: [] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => 1, startRun: () => { throw new Error('no heads in this test'); }, plans,
    lanes: { describe: async you => ({ lanes: [], you: you ?? null }), name: () => undefined },
    control: { stopAll: async reason => { control.push(`stop: ${reason}`); return { heads: 2, lanes: 1 }; }, resume: async () => { control.push('resume'); } },
  });
  try {
    const user = endpoint.issue({ role: 'user', leadKey: 'window', leadSessionId: userPlanSession });
    const call = (tool: string, args: Record<string, unknown> = {}) => callHelperEndpoint(port, user, tool, args);

    assert.deepEqual((await call('hydra_list_heads')).result, { heads: [] });
    assert.deepEqual((await call('hydra_lanes')).result, { lanes: [], you: null }, 'a script is in no lane');
    const created = await call('hydra_plan_create', { title: 'P', jobs: [{ key: 'a', title: 'A', brief: 'Do a.', write_scope: ['src/'] }], idempotency_key: 'k' });
    assert.equal(created.ok, true, created.error);
    assert.equal((await call('hydra_plan_get', { plan_id: 'aaaaaaaa0001' })).ok, true);
    await call('hydra_plan_wait', { plan_id: 'aaaaaaaa0001', max_wait_s: 1 });
    await call('hydra_plan_amend', { plan_id: 'aaaaaaaa0001' });
    await call('hydra_plan_message', { plan_id: 'aaaaaaaa0001', to: 'all', body: 'hi' });
    await call('hydra_plan_cancel', { plan_id: 'aaaaaaaa0001' });
    assert.deepEqual(planCalls.map(item => item.method), ['create', 'get', 'wait', 'amend', 'message', 'cancel']);
    assert.ok(planCalls.every(item => item.session === userPlanSession), 'every plan call runs under the user\'s own session, never a chat\'s');

    assert.deepEqual((await call('hydra_stop_all', { reason: 'nightly' })).result, { stopped: true, heads: 2, lanes: 1 });
    assert.deepEqual((await call('hydra_resume')).result, { stopped: false });
    assert.deepEqual(control, ['stop: Stopped from a script: nightly', 'resume']);

    // Only a head does these, only a lane does hydra_job_ready: refused at the endpoint, before Hydra's handler runs.
    const before = handled.length;
    for (const tool of ['hydra_done', 'hydra_stuck', 'hydra_job_ready', 'hydra_start_head']) {
      const refused = await call(tool, { summary: 'x', reason: 'x' });
      assert.equal(refused.ok, false, tool);
      assert.match(refused.error!, new RegExp(`${tool} is not available to a Hydra user`));
    }
    assert.equal(handled.length, before, 'none of them reached the handler');
    // And the handler itself knows none of them for a user caller, should a token ever get past the endpoint.
    const caller: HelperCaller = { role: 'user', leadKey: 'window', leadSessionId: userPlanSession };
    for (const tool of ['hydra_done', 'hydra_stuck', 'hydra_job_ready', 'hydra_progress', 'hydra_share']) {
      await assert.rejects(service.handle(caller, tool, { summary: 'x' }, new AbortController().signal), /Unknown Hydra action/, tool);
    }

    // No route hands out a user token: the lead route gives a lead, and there is no user route.
    const lead = await requestLeadSession(port);
    assert.equal(lead.ok, true);
    assert.equal((await callHelperEndpoint(port, (lead.result as { token: string }).token, 'hydra_stop_all', {})).ok, false, 'a lead can\'t stop everything');
    assert.equal(await postRaw(port, '/hydra/v1/user-session'), 404);
  } finally {
    await service.dispose(); await endpoint.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a user token is compared in constant time like every other token: a same-length wrong one is refused', async () => {
  const endpoint = new HelperEndpoint(async (_caller, tool) => ({ tool }), { leadKey: 'window', verifyUser: async () => ({ ok: true }) });
  const port = await endpoint.start();
  try {
    const user = endpoint.issue({ role: 'user', leadKey: 'window', leadSessionId: userPlanSession });
    assert.deepEqual(await callHelperEndpoint(port, user, 'hydra_list_heads', {}), { ok: true, result: { tool: 'hydra_list_heads' } });
    const wrong = `${user.slice(0, -1)}${user.endsWith('A') ? 'B' : 'A'}`;
    const refused = await callHelperEndpoint(port, wrong, 'hydra_list_heads', {});
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /Unknown Hydra token/);
    // The user token takes the one lookup every token takes (HSEC-04): no role has a comparison of its own.
    const source = await readFile(path.join(__dirname, '..', 'src', 'core', 'helperEndpoint.ts'), 'utf8');
    assert.equal(source.match(/digestsMatch\(key, caller\.digest\)/g)?.length, 1);
    assert.match(source, /timingSafeEqual\(Buffer\.from\(a, 'utf8'\), Buffer\.from\(b, 'utf8'\)\)/);
  } finally { await endpoint.close(); }
});

test('a user token is refused from inside a head, and by an endpoint with no user check at all', async () => {
  const link = (pid: number, ppid: number, created: number): ProcessLink => ({ pid, ppid, created });
  // A script in an outside terminal: accepted, though it never reaches the window.
  assert.deepEqual(evaluateUserChain([link(50, 40, 5), link(40, 1, 4)], { deniedAncestors: new Set([7]) }), { ok: true });
  // A head's descendant: refused.
  assert.deepEqual(evaluateUserChain([link(50, 40, 5), link(40, 7, 4), link(7, 1, 3)], { deniedAncestors: new Set([7]) }), { ok: false, reason: 'it runs inside a Hydra head, and heads cannot act as you.' });
  // A process the OS can't report: refused, never assumed clean.
  assert.equal(evaluateUserChain([], { deniedAncestors: new Set() }).ok, false);
  // On Windows the verifier asks the OS; elsewhere it accepts, like the lead check.
  assert.equal((await createUserVerifier(() => ({ deniedAncestors: new Set([7]) }), async () => [link(50, 7, 5), link(7, 1, 3)], 'win32')({} as never)).ok, false);
  assert.equal((await createUserVerifier(() => ({ deniedAncestors: new Set([7]) }), async () => [link(50, 7, 5), link(7, 1, 3)], 'linux')({} as never)).ok, true);

  let asked = 0;
  const refusals: string[] = [];
  const checked = new HelperEndpoint(async () => 'ran', { leadKey: 'window', verifyUser: async () => { asked++; return { ok: false, reason: 'it runs inside a Hydra head, and heads cannot act as you.' }; }, onRefuse: event => refusals.push(`${event.status} ${event.role}`) });
  const unchecked = new HelperEndpoint(async () => 'ran', { leadKey: 'window' });
  const [a, b] = [await checked.start(), await unchecked.start()];
  try {
    const refused = await callHelperEndpoint(a, checked.issue({ role: 'user', leadKey: 'window' }), 'hydra_list_heads', {});
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /inside a Hydra head/);
    assert.equal(asked, 1);
    assert.deepEqual(refusals, ['403 user'], 'the refusal is logged like any other');
    const closed = await callHelperEndpoint(b, unchecked.issue({ role: 'user', leadKey: 'window' }), 'hydra_list_heads', {});
    assert.equal(closed.ok, false);
    assert.match(closed.error!, /does not accept user connections/);
  } finally { await checked.close(); await unchecked.close(); }
});

// ---- The handshake file's shape ----

test('parseHandshake takes exactly the handshake\'s fields, and handshakeProblem refuses a stale or mismatched one', () => {
  const good: UserHandshake = { version: 1, kind: 'hydra-user-handshake', pid: 10, port: 5000, token, repository: 'C:\\repo', writtenAt: '2026-09-27T00:00:00.000Z' };
  assert.deepEqual(parseHandshake(JSON.stringify(good)), good);
  assert.throws(() => parseHandshake(JSON.stringify({ ...good, extra: 1 })), /unknown keys: extra/);
  assert.throws(() => parseHandshake(JSON.stringify({ ...good, version: 2 })), /version 1/);
  assert.throws(() => parseHandshake(JSON.stringify({ ...good, token: 'short' })), /valid token/);
  assert.throws(() => parseHandshake(JSON.stringify({ ...good, port: 70000 })), /valid port/);
  assert.throws(() => parseHandshake('not json'), /not JSON/);
  assert.equal(handshakeProblem(good, { pid: 10, port: 5000 }, () => true), undefined);
  assert.match(handshakeProblem(good, { pid: 10, port: 5000 }, () => false)!, /stale/);
  assert.match(handshakeProblem(good, { pid: 10, port: 5001 }, () => true)!, /different Hydra window/);
  assert.match(handshakeProblem(good, { pid: 11, port: 5000 }, () => true)!, /different Hydra window/);
});

test('parseIcacls reads every entry, and aclProblem accepts only the owner\'s own, uninherited access', () => {
  const file = 'C:\\Users\\me\\AppData\\Roaming\\Hydra\\x.json';
  const user = { name: 'box\\me', sid: 'S-1-5-21-1-2-3-1001' };
  const owner = `${file} BOX\\me:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  assert.deepEqual(parseIcacls(owner, file), [{ principal: 'BOX\\me', perms: ['F'], inherited: false, deny: false }]);
  assert.equal(aclProblem(parseIcacls(owner, file), user), undefined);
  const inherited = `${file} BOX\\me:(I)(F)\n${' '.repeat(file.length)} NT AUTHORITY\\SYSTEM:(I)(F)\n\nx`;
  assert.match(aclProblem(parseIcacls(inherited, file), user)!, /inherits access/);
  const widened = `${file} BOX\\me:(F)\n${' '.repeat(file.length)} Everyone:(R)\n\nx`;
  assert.match(aclProblem(parseIcacls(widened, file), user)!, /someone other than you has access to it \(Everyone\)/);
  const sandbox = `${file} BOX\\me:(F)\n${' '.repeat(file.length)} BOX\\CodexSandboxUsers:(RX,W)\n\nx`;
  assert.match(aclProblem(parseIcacls(sandbox, file), user)!, /CodexSandboxUsers/);
  const bySid = `${file} S-1-5-21-1-2-3-1001:(F)\n${' '.repeat(file.length)} Everyone:(DENY)(R)\n\nx`;
  assert.equal(aclProblem(parseIcacls(bySid, file), user), undefined, 'your SID is you; a deny entry grants nothing');
  assert.match(aclProblem(parseIcacls(`${file} Everyone:(DENY)(R)\n\nx`, file), user)!, /grants you no access/);
  assert.throws(() => parseIcacls('C:\\other.json BOX\\me:(F)\n', file), /different file/);
  assert.throws(() => parseIcacls(`${file} garbage\n`, file), /doesn't understand/);
});

// ---- The handshake file on disk ----

test('the handshake file is written owner-only (icacls on Windows), and a reader accepts it', async () => {
  const root = await temp('hydra-handshake-');
  try {
    const file = await writeUserHandshake(root, { pid: process.pid, port: 5000, token, repository: root });
    assert.equal(file, path.join(handshakeDirectory(root), handshakeFileName(process.pid, 5000)));
    assert.deepEqual((await readdir(handshakeDirectory(root))).sort(), [handshakeFileName(process.pid, 5000)], 'no temporary file left behind');
    if (windows) {
      const listing = spawnSync(icacls, [file], { encoding: 'utf8' });
      assert.equal(listing.status, 0);
      const entries = parseIcacls(listing.stdout, file);
      assert.equal(entries.length, 1, listing.stdout);
      assert.equal(entries[0]!.inherited, false);
      assert.deepEqual(entries[0]!.perms, ['F']);
      assert.doesNotMatch(listing.stdout.slice(file.length), /\(I\)|SYSTEM|Administrators|Everyone|BUILTIN|CodexSandbox/);
    } else {
      const { stat } = await import('node:fs/promises');
      assert.equal((await stat(file)).mode & 0o077, 0);
    }
    const read = await readUserHandshake(file, { pid: process.pid, port: 5000 });
    assert.equal(read.ok, true, read.ok ? '' : read.reason);
    assert.equal(read.ok && read.handshake.token, token);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a handshake file whose access list was widened or re-inherited is refused', async () => {
  const root = await temp('hydra-handshake-');
  try {
    const file = await writeUserHandshake(root, { pid: process.pid, port: 5001, token, repository: root });
    const window = { pid: process.pid, port: 5001 };
    if (windows) {
      // Everyone may read it: refused.
      assert.equal(spawnSync(icacls, [file, '/grant', '*S-1-1-0:R'], { encoding: 'utf8' }).status, 0);
      const widened = await readUserHandshake(file, window);
      assert.equal(widened.ok, false);
      assert.match(!widened.ok ? widened.reason : '', /Hydra refused the handshake file: someone other than you has access to it/);
      // Back to owner-only, then inheritance turned back on: refused.
      assert.equal(spawnSync(icacls, [file, '/remove:g', '*S-1-1-0'], { encoding: 'utf8' }).status, 0);
      assert.equal((await readUserHandshake(file, window)).ok, true, 'owner-only again');
      assert.equal(spawnSync(icacls, [file, '/inheritance:e'], { encoding: 'utf8' }).status, 0);
      const inherited = await readUserHandshake(file, window);
      assert.equal(inherited.ok, false);
      assert.match(!inherited.ok ? inherited.reason : '', /inherits access from its folder/);
    } else {
      await chmod(file, 0o644);
      const widened = await readUserHandshake(file, window);
      assert.equal(widened.ok, false);
      assert.match(!widened.ok ? widened.reason : '', /others can read or write it/);
    }
    // A handshake file whose access list can't be checked at all is refused too, never trusted.
    const unchecked = await readUserHandshake(file, window, { ownerOnly: async () => 'its access list couldn\'t be checked: icacls failed' });
    assert.equal(unchecked.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a stale handshake (its Hydra process gone) is refused and removed; one for another window is refused', async () => {
  const root = await temp('hydra-handshake-');
  try {
    const gone = await deadPid();
    const stale = await writeUserHandshake(root, { pid: gone, port: 5002, token, repository: root });
    const read = await readUserHandshake(stale, { pid: gone, port: 5002 });
    assert.equal(read.ok, false);
    assert.match(!read.ok ? read.reason : '', /stale: the Hydra window that wrote it has closed/);
    await assert.rejects(readFile(stale), /ENOENT/, 'a stale handshake is removed');

    const live = await writeUserHandshake(root, { pid: process.pid, port: 5003, token, repository: root });
    const other = await readUserHandshake(live, { pid: process.pid, port: 5004 });
    assert.equal(other.ok, false);
    assert.match(!other.ok ? other.reason : '', /different Hydra window/);

    // A window that crashed never removed its own: the next window's sweep does.
    const leftover = await writeUserHandshake(root, { pid: gone, port: 5005, token, repository: root });
    assert.equal(await sweepStaleHandshakes(root), 1);
    await assert.rejects(readFile(leftover), /ENOENT/);
    await readFile(live);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('findUserHandshake answers from the window that owns the caller\'s folder, through its discovery record', async () => {
  const root = await temp('hydra-handshake-');
  try {
    const helpers = path.join(root, 'helpers');
    const repo = path.join(root, 'repo'), elsewhere = path.join(root, 'elsewhere');
    await mkdir(path.join(repo, 'src', 'deep'), { recursive: true }); await mkdir(elsewhere);
    await writeWindowRecord(helpers, { port: 5006, pid: process.pid, folders: [repo] });
    await writeUserHandshake(helpers, { pid: process.pid, port: 5006, token, repository: repo });
    const found = await findUserHandshake(helpers, path.join(repo, 'src', 'deep'));
    assert.equal(found.ok, true, found.ok ? '' : found.reason);
    assert.equal(found.ok && found.handshake.port, 5006);
    const none = await findUserHandshake(helpers, elsewhere);
    assert.deepEqual(none, { ok: false, reason: 'No open Hydra window owns this folder.' });
    // A window with no handshake yet (it's still starting) says so.
    await writeWindowRecord(helpers, { port: 5007, pid: process.pid, folders: [elsewhere] });
    const starting = await findUserHandshake(helpers, elsewhere);
    assert.equal(starting.ok, false);
    assert.match(!starting.ok ? starting.reason : '', /no handshake file yet/);
    // A file put where a handshake goes, by hand, with the wrong content, is refused.
    await writeFile(path.join(handshakeDirectory(helpers), handshakeFileName(process.pid, 5007)), '{"version":1}');
    if (windows) spawnSync(icacls, [path.join(handshakeDirectory(helpers), handshakeFileName(process.pid, 5007)), '/inheritance:r', '/grant:r', `*${sid()}:F`]);
    else await chmod(path.join(handshakeDirectory(helpers), handshakeFileName(process.pid, 5007)), 0o600);
    const planted = await findUserHandshake(helpers, elsewhere);
    assert.equal(planted.ok, false);
    assert.match(!planted.ok ? planted.reason : '', /not a version 1 Hydra handshake/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function sid(): string {
  const output = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout;
  return /"(S-1-5-(?:\d+-)*\d+)"/.exec(output)![1]!;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint, requestLeadSession } from '../src/core/helperEndpoint';
import { HelperService, type HelperServiceOptions } from '../src/core/helperService';
import type { HelperRun, HelperRunSpec } from '../src/core/helperRunner';
import { AuditLog, laneOverrideEvent, type AuditEvent } from '../src/core/audit';
import { PackService } from '../src/core/packs/service';

/**
 * 5.2: the audit log. Events are written one JSON line each,
 * redacted, and rotated at a small size; a refused endpoint call, a refused lead connection,
 * a "Merge anyway" override, a pack turned on and a head cancelled each add exactly one line.
 */

async function fixtureDir(prefix: string): Promise<{ dir: string; file: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, file: path.join(dir, 'audit', 'audit.jsonl'), close: () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
async function lines(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// ---- Basics: written, one line each, "at" present ----

test('record() writes one redacted JSON line per event, with "at"', async () => {
  const f = await fixtureDir('hydra-audit-basic-');
  try {
    const log = new AuditLog({ file: f.file, now: () => new Date('2026-01-02T03:04:05.000Z') });
    log.record({ kind: 'denial', what: 'endpoint refused: 401', detail: 'an unknown token' });
    log.record({ kind: 'stop', what: 'head cancelled', jobId: 'a'.repeat(12) });
    await log.flush();
    const rows = await lines(f.file);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { at: '2026-01-02T03:04:05.000Z', kind: 'denial', what: 'endpoint refused: 401', detail: 'an unknown token' });
    assert.deepEqual(rows[1], { at: '2026-01-02T03:04:05.000Z', kind: 'stop', what: 'head cancelled', jobId: 'a'.repeat(12) });
  } finally { await f.close(); }
});

test('record() never throws to the caller, even when the file can\'t be written', async () => {
  const f = await fixtureDir('hydra-audit-safe-');
  try {
    // A file in place of the "audit" directory: mkdir(recursive) inside append() fails every time.
    await writeFile(f.dir + path.sep + 'blocker', ''); // sanity file, not used
    const blockedFile = path.join(f.dir, 'not-a-directory', 'nested', 'audit.jsonl');
    await writeFile(path.join(f.dir, 'not-a-directory'), 'a plain file, not a directory');
    const log = new AuditLog({ file: blockedFile });
    assert.doesNotThrow(() => log.record({ kind: 'denial', what: 'x' }));
    await assert.doesNotReject(() => log.flush());
  } finally { await f.close(); }
});

// ---- Redaction ----

test('a planted ghp_ token and an sk- key in detail are redacted', async () => {
  const f = await fixtureDir('hydra-audit-redact-');
  try {
    const log = new AuditLog({ file: f.file });
    log.record({ kind: 'denial', what: 'endpoint refused: 403', detail: 'saw ghp_abcdefghijklmnopqrstuvwxyz012345 and sk-abcdefghijklmnopqrstuvwx' });
    await log.flush();
    const [row] = await lines(f.file);
    assert.ok(!JSON.stringify(row).includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
    assert.ok(!JSON.stringify(row).includes('sk-abcdefghijklmnopqrstuvwx'));
    assert.match(row!.detail as string, /saw \[redacted\] and \[redacted\]/);
  } finally { await f.close(); }
});

// ---- Rotation ----

test('rotation at a tiny maxBytes keeps exactly one previous file', async () => {
  const f = await fixtureDir('hydra-audit-rotate-');
  try {
    // Each line is well over 40 bytes; a 100-byte cap rotates often.
    const log = new AuditLog({ file: f.file, maxBytes: 100 });
    for (let i = 0; i < 20; i++) log.record({ kind: 'stop', what: `event number ${i}`, detail: 'x'.repeat(20) });
    await log.flush();
    const previous = path.join(f.dir, 'audit', 'audit.1.jsonl');
    const currentSize = await stat(f.file).then(info => info.size);
    const previousSize = await stat(previous).then(info => info.size);
    assert.ok(currentSize > 0 && currentSize <= 100 + 200 /* one line's worth of slack over the cap */, `current file too big: ${currentSize}`);
    assert.ok(previousSize > 0, 'a previous file was kept');
    // No third file: only audit.jsonl and audit.1.jsonl exist.
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(path.join(f.dir, 'audit'))).sort();
    assert.deepEqual(files, ['audit.1.jsonl', 'audit.jsonl']);
    // Every event, across both files, is still valid JSON with "at".
    const all = [...await lines(previous), ...await lines(f.file)];
    assert.ok(all.length >= 2);
    for (const row of all) assert.ok(typeof row.at === 'string');
  } finally { await f.close(); }
});

// ---- laneOverrideEvent: the pure helper factored out of src/host/lanes.ts's dialogs ----

test('laneOverrideEvent: an approval naming the lane and, when given, a detail', () => {
  assert.deepEqual(laneOverrideEvent('Merge anyway', 'b'.repeat(12)), { kind: 'approval', what: 'Merge anyway', laneId: 'b'.repeat(12) });
  assert.deepEqual(
    laneOverrideEvent('Merge with these changes', 'c'.repeat(12), 'core.fsmonitor'),
    { kind: 'approval', what: 'Merge with these changes', laneId: 'c'.repeat(12), detail: 'core.fsmonitor' },
  );
});

// ---- A refused endpoint call, wired exactly as extension.ts wires HelperEndpoint's onRefuse ----

test('a refused endpoint call adds exactly one denial line', async () => {
  const f = await fixtureDir('hydra-audit-endpoint-');
  try {
    const log = new AuditLog({ file: f.file });
    const endpoint = new HelperEndpoint(async (_caller, tool) => ({ handled: tool }), {
      leadKey: 'window',
      onRefuse: event => log.record({ kind: 'denial', what: `endpoint refused: ${event.status}`, detail: event.reason, role: event.role, jobId: event.jobId }),
    });
    const port = await endpoint.start();
    try {
      const unknown = await callHelperEndpoint(port, 'x'.repeat(43), 'hydra_list_heads', {});
      assert.equal(unknown.ok, false);
    } finally { await endpoint.close(); }
    await log.flush();
    const rows = await lines(f.file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'denial');
    assert.match(rows[0]!.what as string, /endpoint refused: 401/);
  } finally { await f.close(); }
});

test('a refused lead connection adds exactly one denial line', async () => {
  const f = await fixtureDir('hydra-audit-lead-');
  try {
    const log = new AuditLog({ file: f.file });
    const endpoint = new HelperEndpoint(async (_caller, tool) => ({ handled: tool }), {
      leadKey: 'window',
      verifyLead: async () => {
        const verdict = { ok: false as const, reason: 'it runs inside a Hydra head.' };
        log.record({ kind: 'denial', what: 'lead connection refused', detail: verdict.reason });
        return verdict;
      },
    });
    const port = await endpoint.start();
    try {
      const refused = await requestLeadSession(port);
      assert.equal(refused.ok, false);
    } finally { await endpoint.close(); }
    await log.flush();
    const rows = await lines(f.file);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { at: rows[0]!.at, kind: 'denial', what: 'lead connection refused', detail: 'it runs inside a Hydra head.' });
  } finally { await f.close(); }
});

// ---- HelperService: a head cancelled, and hydra_done refused for changed git settings ----

type Script = (helper: { spec: HelperRunSpec; call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>; endTurn: () => void; exit: (code: number) => void; commit: (file: string, text: string) => Promise<void> }) => Promise<void>;

async function helperFixture(options: { script: Script; gates?: unknown; audit?: (event: AuditEvent) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-audit-helper-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  if (options.gates) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(options.gates)); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  service = new HelperService({
    store, endpoint, leadFolder: repo, leadKey: 'window', worktreeRoot: () => path.join(root, 'worktrees'),
    executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => 2, watchdogMs: 20,
    audit: options.audit,
    startRun: spec => {
      const listeners: (() => void)[] = [];
      let exit!: (code: number) => void; let stopped = false;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = {
        onTurnEnd: listener => { listeners.push(listener); }, exited,
        send: async () => { if (stopped) return false; return true; },
        stop: async () => exit(137),
        limitHit: () => undefined,
      };
      const token = spec.bridge.env.HYDRA_HELPER_TOKEN!;
      setTimeout(() => void options.script({
        spec, exit,
        call: (tool, args = {}) => callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), token, tool, args),
        endTurn: () => { for (const listener of listeners) listener(); },
        commit: async (file, text) => { await mkdir(path.dirname(path.join(spec.worktree, file)), { recursive: true }); await writeFile(path.join(spec.worktree, file), text); await git(spec.worktree, ['add', '.']); await git(spec.worktree, ['commit', '-qm', `head: ${file}`]); },
      }).catch(() => undefined), 0);
      return run;
    },
  });
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window' });
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> => callHelperEndpoint(port, lead, tool, args);
  const start = async (key: string, extra: Record<string, unknown> = {}): Promise<any> => (await call('hydra_start_head', { title: `Job ${key}`, brief: 'Do the thing.', write_scope: ['src/'], idempotency_key: key, ...extra })).result;
  const wait = async (ids: string[], max = 90): Promise<any> => (await call('hydra_wait_for_heads', { job_ids: ids, max_wait_s: max })).result;
  return { root, repo, store, service, endpoint, call, start, wait, close: async () => { await service.dispose(); await endpoint.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

const passGate = (id: string) => ({ id, type: 'command', command: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 60 });

test('a head cancelled (hydra_cancel_head) adds exactly one stop line', async () => {
  const f = await fixtureDir('hydra-audit-cancel-');
  const events: AuditEvent[] = [];
  const fx = await helperFixture({ audit: event => events.push(event), script: async () => { /* never calls hydra_done: stays running until cancelled */ } });
  try {
    const { job_id } = await fx.start('cancel-me');
    // Give the fake head a moment to reach "running" before cancelling it.
    await new Promise(resolve => setTimeout(resolve, 50));
    const cancelled = await fx.call('hydra_cancel_head', { job_id });
    assert.equal(cancelled.ok, true);
    const stops = events.filter(event => event.kind === 'stop' && event.what === 'head cancelled');
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.jobId, job_id);
  } finally { await fx.close(); await f.close(); }
});

test('hydra_done refused for changed git settings/hooks adds exactly one denial line', async () => {
  const events: AuditEvent[] = [];
  const fx = await helperFixture({ gates: { gates: [passGate('unit')] }, audit: event => events.push(event), script: async helper => {
    await helper.commit('src/x.ts', 'x\n');
    const common = (await git(helper.spec.worktree, ['rev-parse', '--git-common-dir'])).trim();
    const hooksDir = path.isAbsolute(common) ? path.join(common, 'hooks') : path.join(helper.spec.worktree, common, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho hi\n');
    const refused = await helper.call('hydra_done', { summary: 'planted a hook' });
    assert.equal(refused.result.accepted, false);
    await rm(path.join(hooksDir, 'pre-commit'));
    const accepted = await helper.call('hydra_done', { summary: 'undid it' });
    assert.equal(accepted.result.accepted, true);
    helper.endTurn();
  } });
  try {
    const { job_id } = await fx.start('hook');
    const [head] = (await fx.wait([job_id])).heads;
    assert.equal(head.state, 'done');
    const denials = events.filter(event => event.kind === 'denial' && event.what.startsWith('hydra_done refused'));
    assert.equal(denials.length, 1, 'exactly one line for the refused attempt, none for the accepted one');
    assert.match(denials[0]!.detail ?? '', /hooks\/pre-commit/);
  } finally { await fx.close(); }
});

// ---- PackService: a pack turned on, and a pack server refused by 5.4's integrity pin ----

const kit = (server: unknown) => ({
  version: 1, id: 'kit', title: 'Kit', description: 'A test pack.',
  roles: [{ id: 'pinner', title: 'Pinner', description: 'Uses a pinned server.', provider: 'claude', instructions: 'roles/builder.md', mcpServers: ['pinned'] }],
  mcpServers: { pinned: server },
});
async function writeFolder(folder: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(folder, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
async function packRepo(root: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  return repo;
}

test('a pack turned on adds exactly one approval line', async () => {
  const f = await fixtureDir('hydra-audit-packon-');
  const events: AuditEvent[] = [];
  try {
    const repo = await packRepo(f.dir);
    await writeFolder(path.join(f.dir, 'builtin', 'kit'), {
      'pack.json': JSON.stringify(kit({ type: 'stdio', command: 'node', args: ['server.mjs'] })),
      'roles/builder.md': 'Read the code first.\n',
      'server.mjs': 'process.exit(0);\n',
    });
    const packs = new PackService({
      builtin: path.join(f.dir, 'builtin'), userFolder: () => path.join(f.dir, 'user'), storage: path.join(f.dir, 'storage', 'packs'),
      version: '0.24.0', nodeExecutable: 'node', audit: event => events.push(event),
    });
    const state = (await packs.state(repo)).packs.find(pack => pack.id === 'kit')!;
    await packs.turnOn(repo, 'kit', state.pack!.hash!);
    const approvals = events.filter(event => event.kind === 'approval' && event.what === 'pack turned on');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.pack, 'kit');
    assert.equal(approvals[0]!.detail, state.pack!.hash);
  } finally { await f.close(); }
});

test('a pack server refused by the 5.4 integrity pin adds exactly one denial line', async () => {
  const f = await fixtureDir('hydra-audit-pinrefuse-');
  const events: AuditEvent[] = [];
  try {
    const repo = await packRepo(f.dir);
    const pinned = 'sha512-' + 'A'.repeat(86) + '==';
    await writeFolder(path.join(f.dir, 'builtin', 'kit'), {
      'pack.json': JSON.stringify(kit({ type: 'stdio', command: 'npx', args: ['-y', '@kit/pinned-mcp@2.0.1'], integrity: pinned })),
      'roles/builder.md': 'Read the code first.\n',
    });
    const packs = new PackService({
      builtin: path.join(f.dir, 'builtin'), userFolder: () => path.join(f.dir, 'user'), storage: path.join(f.dir, 'storage', 'packs'),
      version: '0.24.0', nodeExecutable: 'node', audit: event => events.push(event),
      npxRegistryFetch: async () => 'sha512-' + 'B'.repeat(86) + '==',
    });
    const state = (await packs.state(repo)).packs.find(pack => pack.id === 'kit')!;
    await packs.turnOn(repo, 'kit', state.pack!.hash!);
    events.length = 0; // only count the resolve() below, not turnOn's own approval line
    await packs.resolve(repo, 'kit/pinner');
    const denials = events.filter(event => event.kind === 'denial' && event.what === 'pack server refused');
    assert.equal(denials.length, 1);
    assert.equal(denials[0]!.pack, 'kit');
    assert.match(denials[0]!.detail ?? '', /^pinned: .*is pinned to/);
  } finally { await f.close(); }
});

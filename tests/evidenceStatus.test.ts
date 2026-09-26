import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { createWorktree } from '../src/core/worktrees';
import { laneBranch, laneFolder, newLaneId, type Lane } from '../src/core/lanes';
import { LaneSync } from '../src/core/laneSync';
import { checksSection, githubCompareUrl, maxCompareUrlChars } from '../src/core/laneFinish';
import { evidenceLabel, evidenceStatus, gatesConfigured, type JobCheckResult } from '../src/core/jobs';
import { detectTestScript, noGatesFile, starterTestGatesFile } from '../src/core/starterGates';

/**
 * Step A (docs/Hydra_Improvements_Pt_2.md): truthful gate status for every job. Covers the pure
 * status logic, the lane staleness check against a real git repository (like tests/laneGit.test.ts),
 * the PR compare URL's "Checks" section, and the starter-gates writers.
 */

const check = (over: Partial<JobCheckResult> = {}): JobCheckResult =>
  ({ id: over.id ?? 'unit', required: over.required ?? true, passed: over.passed ?? true, exitCode: 0, durationMs: 1, outputTail: '', ...over });

test('evidenceStatus: passed only when every required gate passed and nothing was skipped', () => {
  assert.equal(evidenceStatus({ checks: [check({ state: 'passed' })], configured: 'file' }), 'passed');
  assert.equal(evidenceStatus({ checks: [check({ state: 'passed' }), check({ id: 'review', required: false, state: 'notRun' })], configured: 'file' }), 'partial');
});

test('evidenceStatus: a notRun required gate is never passed, even with other gates passing', () => {
  const checks = [check({ id: 'unit', state: 'passed' }), check({ id: 'review', required: true, state: 'notRun', passed: false })];
  assert.equal(evidenceStatus({ checks, configured: 'file' }), 'partial');
});

test('evidenceStatus: none vs none-chosen come from how the project configured gates, not the checks', () => {
  assert.equal(evidenceStatus({ checks: [], configured: 'none' }), 'none');
  assert.equal(evidenceStatus({ checks: [], configured: 'empty-file' }), 'none-chosen');
  assert.equal(gatesConfigured('none', 0), 'none');
  assert.equal(gatesConfigured('gates', 0), 'empty-file');
  assert.equal(gatesConfigured('gates', 2), 'file');
  assert.equal(gatesConfigured('checks', 1), 'file');
  // A pack's gates count even when the project has no gates.json of its own.
  assert.equal(gatesConfigured('none', 1), 'file');
});

test('evidenceStatus: an accepted result with no checks at all (nothing changed) is left unlabelled, not "no gates configured"', () => {
  assert.equal(evidenceStatus({ checks: [], configured: 'file' }), undefined);
});

test('evidenceStatus: a failed required gate is override only when a human went ahead; otherwise there is no status at all', () => {
  const checks = [check({ id: 'unit', state: 'failed', passed: false })];
  assert.equal(evidenceStatus({ checks, configured: 'file' }), undefined, 'not accepted: nothing to label');
  assert.equal(evidenceStatus({ checks, configured: 'file', override: true }), 'override');
  // Even a project with no gates: an override on a failed gate that did run still reports override, not "none".
  assert.equal(evidenceStatus({ checks, configured: 'none', override: true }), 'override');
});

test('evidenceLabel: one plain-English label per status', () => {
  assert.equal(evidenceLabel('passed'), 'Passed required gates');
  assert.equal(evidenceLabel('partial'), 'Some gates not run');
  assert.equal(evidenceLabel('none'), 'No gates configured');
  assert.equal(evidenceLabel('none-chosen'), 'No gates (project choice)');
  assert.equal(evidenceLabel('override'), 'Human override');
});

// ---- Lane staleness against a real git repository (tests/laneGit.test.ts's fixture pattern) ----

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hydra-evidence-git-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  for (const [key, value] of [['user.email', 'test@example.invalid'], ['user.name', 'Test']]) await git(repo, ['config', key!, value!]);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const id = newLaneId();
  const created = await createWorktree(repo, 'Evidence', id, undefined, undefined, { branch: laneBranch('Evidence', id), folder: laneFolder(id) });
  const lane: Lane = { id, name: 'Evidence', provider: 'claude', repository: repo, worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit, target: created.integrationTarget, createdAt: new Date().toISOString(), state: 'running' };
  return { root, repo, lane, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

test('a lane\'s recorded evidence commit goes stale once its HEAD moves past it', async () => {
  const f = await fixture();
  try {
    const head = (await git(f.lane.worktree, ['rev-parse', 'HEAD'])).trim();
    const sync = new LaneSync();
    const before = await sync.run([f.lane]);
    assert.equal(before.get(f.lane.id)?.head, head, 'the sync pass reports the lane\'s current HEAD');
    // Status was recorded on this same commit: not stale.
    assert.equal(before.get(f.lane.id)?.head, head);

    await writeFile(path.join(f.lane.worktree, 'src', 'b.ts'), 'export const b = 1;\n');
    await git(f.lane.worktree, ['add', '-A']);
    await git(f.lane.worktree, ['commit', '-qm', 'a new commit']);
    const newHead = (await git(f.lane.worktree, ['rev-parse', 'HEAD'])).trim();
    assert.notEqual(newHead, head);

    const after = await sync.run([f.lane]);
    // The status recorded at `head` is now stale, because the lane's HEAD is `newHead`.
    const recordedCommit = head;
    const stale = after.get(f.lane.id)?.head !== recordedCommit;
    assert.equal(stale, true, 'laneService.views() computes gatesStale from exactly this comparison');
  } finally { await f.close(); }
});

// ---- PR body: the "Checks" section carried on the compare URL ----

test('checksSection lists the status, each gate\'s icon and kind, and the commit; undefined without a recorded status', () => {
  assert.equal(checksSection(undefined), undefined);
  assert.equal(checksSection({ source: 'gates', at: new Date().toISOString(), results: [] }), undefined, 'no status recorded: nothing to say');
  const record = {
    source: 'gates' as const, at: new Date().toISOString(), commit: 'a'.repeat(40), status: 'partial' as const,
    results: [check({ id: 'unit', state: 'passed' }), check({ id: 'review', required: false, state: 'notRun' }), check({ id: 'lint', state: 'failed', required: false, passed: false })],
  };
  const body = checksSection(record)!;
  assert.match(body, /^### Checks/);
  assert.match(body, /Some gates not run/);
  assert.match(body, /✓ unit \(command\)/);
  assert.match(body, /– review \(command\)/);
  assert.match(body, /✗ lint \(command\)/);
  assert.match(body, /Commit a{7}/);
});

test('checksSection clips the gate list, never the status or commit line, to stay under the URL budget', () => {
  const results = Array.from({ length: 400 }, (_, index) => check({ id: `gate-${index}`, state: 'passed' }));
  const record = { source: 'gates' as const, at: new Date().toISOString(), commit: 'b'.repeat(40), status: 'passed' as const, results };
  const body = checksSection(record)!;
  assert.ok(encodeURIComponent(body).length <= maxCompareUrlChars - 300);
  assert.match(body, /Passed required gates/);
  assert.match(body, /Commit b{7}/);
  assert.match(body, /… \d+ more/);
});

test('the compare URL carries the checks body under GitHub\'s body parameter, and stays under the size budget', () => {
  const record = { source: 'gates' as const, at: new Date().toISOString(), commit: 'c'.repeat(40), status: 'passed' as const, results: [check({ id: 'unit' })] };
  const body = checksSection(record)!;
  const url = githubCompareUrl('https://github.com/ndunl075/hydra.git', 'main', 'lane/x-abcdef012345', encodeURIComponent(body));
  assert.ok(url);
  assert.match(url!, /[?&]body=/);
  assert.ok(url!.length <= maxCompareUrlChars);
  assert.equal(decodeURIComponent(url!.split('&body=')[1]!), body);
  assert.equal(githubCompareUrl('https://github.com/ndunl075/hydra.git', 'main', 'lane/x'), 'https://github.com/ndunl075/hydra/compare/main...lane/x?expand=1', 'body stays optional');
});

// ---- Starter gates: the writers, and detecting a package.json test script ----

test('starterTestGatesFile writes one required npm test command gate', () => {
  const parsed = JSON.parse(starterTestGatesFile());
  assert.deepEqual(parsed.gates, [{ id: 'test', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 600 }]);
});

test('noGatesFile writes a deliberately empty gates list', () => {
  assert.deepEqual(JSON.parse(noGatesFile()), { gates: [] });
});

test('detectTestScript finds a non-empty package.json "test" script, and is false without one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-starter-gates-'));
  try {
    assert.equal(await detectTestScript(root), false, 'no package.json at all');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    assert.equal(await detectTestScript(root), false, 'no "test" script');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(await detectTestScript(root), true);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: '   ' } }));
    assert.equal(await detectTestScript(root), false, 'a blank script does not count');
  } finally { await rm(root, { recursive: true, force: true }); }
});

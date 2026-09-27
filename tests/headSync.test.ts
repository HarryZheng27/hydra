import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { createWorktree } from '../src/core/worktrees';
import { HeadSync } from '../src/core/headSync';

/** Two head-like worktrees of one real repository, the same shape headSync.ts checks. */
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hydra-head-sync-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const worktree = async (id: string) => (await createWorktree(repo, `head-${id}`, id, undefined, undefined, { branch: `agent/${id}`, folder: `head-${id}` })).worktree;
  const write = (folder: string, file: string, text: string) => mkdir(path.dirname(path.join(folder, file)), { recursive: true }).then(() => writeFile(path.join(folder, file), text));
  const commit = async (folder: string, file: string, text: string) => { await write(folder, file, text); await git(folder, ['add', '-A']); await git(folder, ['commit', '-qm', `change ${file}`]); };
  return { root, repo, worktree, write, commit, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

test('HeadSync: two heads that change the same file conflict; two that change different files don\'t', async () => {
  const f = await fixture();
  try {
    const [wtA, wtB, wtC] = await Promise.all([f.worktree('aaaaaaaaaaaa'), f.worktree('bbbbbbbbbbbb'), f.worktree('cccccccccccc')]);
    await f.commit(wtA!, 'src/a.ts', 'export const a = 2;\n');
    await f.commit(wtB!, 'src/a.ts', 'export const a = 3;\n');
    await f.commit(wtC!, 'src/b.ts', 'export const b = 2;\n');
    const sync = new HeadSync();
    const results = await sync.run(f.repo, [{ id: 'a', worktree: wtA! }, { id: 'b', worktree: wtB! }, { id: 'c', worktree: wtC! }]);
    assert.deepEqual(results.get('a'), [{ jobId: 'b', files: ['src/a.ts'] }]);
    assert.deepEqual(results.get('b'), [{ jobId: 'a', files: ['src/a.ts'] }]);
    assert.deepEqual(results.get('c'), [], 'a change to a different file conflicts with neither');
  } finally { await f.close(); }
});

test('HeadSync: uncommitted work is checked too, without touching the worktree\'s real index or files', async () => {
  const f = await fixture();
  try {
    const [wtA, wtB] = await Promise.all([f.worktree('dddddddddddd'), f.worktree('eeeeeeeeeeee')]);
    await f.write(wtA!, 'src/a.ts', 'export const a = 9;\n'); // uncommitted
    await f.commit(wtB!, 'src/a.ts', 'export const a = 8;\n');
    const statusBefore = await git(wtA!, ['status', '--porcelain=v1']);
    const sync = new HeadSync();
    const results = await sync.run(f.repo, [{ id: 'a', worktree: wtA! }, { id: 'b', worktree: wtB! }]);
    assert.deepEqual(results.get('a'), [{ jobId: 'b', files: ['src/a.ts'] }]);
    assert.equal(await git(wtA!, ['status', '--porcelain=v1']), statusBefore, 'uncommitted work is untouched');
  } finally { await f.close(); }
});

test('HeadSync: no conflict once two heads no longer overlap, and a removed head drops out cleanly', async () => {
  const f = await fixture();
  try {
    const [wtA, wtB] = await Promise.all([f.worktree('ffffffffffff'), f.worktree('111111111111')]);
    await f.commit(wtA!, 'src/a.ts', 'export const a = 2;\n');
    await f.commit(wtB!, 'src/a.ts', 'export const a = 3;\n');
    const sync = new HeadSync();
    const first = await sync.run(f.repo, [{ id: 'a', worktree: wtA! }, { id: 'b', worktree: wtB! }]);
    assert.ok(first.get('a')!.length, 'conflicting at first');
    // b's head finishes and its worktree goes away, as a real head's does; only a is checked next pass.
    const second = await sync.run(f.repo, [{ id: 'a', worktree: wtA! }]);
    assert.deepEqual(second.get('a'), []);
    assert.equal(second.has('b'), false);
  } finally { await f.close(); }
});

test('HeadSync: a worktree that no longer exists is skipped, not thrown', async () => {
  const f = await fixture();
  try {
    const wtA = await f.worktree('222222222222');
    const sync = new HeadSync();
    const results = await sync.run(f.repo, [{ id: 'a', worktree: wtA! }, { id: 'gone', worktree: path.join(f.root, 'no-such-worktree') }]);
    assert.deepEqual(results.get('a'), []);
    assert.deepEqual(results.get('gone'), []);
  } finally { await f.close(); }
});

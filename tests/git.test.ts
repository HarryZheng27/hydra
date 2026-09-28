import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bigRepoGitTimeoutMs, defaultGitTimeoutMs, git, gitBytes, gitRun } from '../src/core/git';

/**
 * `git credential fill` reads a credential description from stdin and blocks until it gets one;
 * Hydra's git calls never write or close stdin, so it never gets one. A real, portable way to make
 * git hang on command without faking the `git` binary or touching the network (docs/Heads.md,
 * Troubleshooting; the bug this covers: git() and gitBytes() had no timeout at all).
 */
const hang = ['credential', 'fill'];

test('defaultGitTimeoutMs and bigRepoGitTimeoutMs are set, and bigRepoGitTimeoutMs is the larger one', () => {
  assert.equal(defaultGitTimeoutMs, 180_000);
  assert.equal(bigRepoGitTimeoutMs, 300_000);
  assert.ok(bigRepoGitTimeoutMs > defaultGitTimeoutMs);
});

test('git() kills a hung git process at its timeout instead of hanging forever, and names the command', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-git-timeout-'));
  try {
    const start = Date.now();
    await assert.rejects(git(dir, hang, undefined, 500), /git credential took longer than \d+s and was stopped\./);
    assert.ok(Date.now() - start < 10_000, 'the call returns soon after its own timeout, not after the default 180s');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('gitBytes() times out the same way as git()', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-git-timeout-'));
  try {
    await assert.rejects(gitBytes(dir, hang, undefined, 500), /git credential took longer than \d+s and was stopped\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('gitRun() rejects on a timeout (never resolves with a fake exit code), and a fast call keeps its usual default', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-git-timeout-'));
  try {
    await assert.rejects(gitRun(dir, hang, undefined, 500), /git credential took longer than \d+s and was stopped\./);
    // An ordinary, fast call still works, unaffected by the new default timeout.
    const result = await gitRun(dir, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(result.code, 128, 'not a repository, but git ran and exited normally, well inside the default timeout');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

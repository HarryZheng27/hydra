import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitBytes, gitRun, readOnlyGitTimeoutMs } from '../src/core/git';

/**
 * `git credential fill` reads a credential description from stdin and blocks until it gets one;
 * Hydra's git calls never write or close stdin, so it never gets one. A real, portable way to make
 * git hang on a command without faking the `git` binary or touching the network — used here only
 * with an explicit, short timeout: `git()`/`gitBytes()`/`gitRun()` default to no timeout at all
 * (docs/Heads.md, Troubleshooting), so a test that left one hanging with no explicit timeout would
 * leak a real orphaned process. What "no timeout by default" means is verified separately, from the
 * functions' own default-parameter source (see below) rather than by actually waiting one out.
 */
const hang = ['credential', 'fill'];

test('readOnlyGitTimeoutMs is a generous, explicit-opt-in-only value', () => {
  assert.equal(readOnlyGitTimeoutMs, 300_000);
});

test('git(), gitBytes() and gitRun() default their timeout to 0 (none) unless a caller opts in', () => {
  // Killing a git call mid-write can leave index.lock, an unfinished merge, or an orphaned hook
  // process behind (see the comment beside readOnlyGitTimeoutMs in src/core/git.ts), so nothing
  // times out unless a caller explicitly asks — checked here from the functions' own default
  // parameter, not by actually leaving a hung git process running for this test to wait out.
  for (const fn of [git, gitBytes, gitRun]) assert.match(fn.toString(), /timeoutMs\s*=\s*0\b/, `${fn.name} must default timeoutMs to 0`);
});

test('an explicit timeout still kills a hung git process, naming the real subcommand (not a leading -c)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-git-timeout-'));
  try {
    const start = Date.now();
    // noHooks-style leading `-c core.hooksPath=…` pairs, exactly as commitAll and worktree-add
    // callers pass: the error must name "credential", not "-c".
    await assert.rejects(git(dir, ['-c', 'core.hooksPath=/nowhere', ...hang], undefined, 500), /git credential took longer than \d+s and was stopped\./);
    assert.ok(Date.now() - start < 10_000, 'the call returns soon after its own timeout, not after waiting indefinitely');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('gitBytes() times out the same way as git()', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-git-timeout-'));
  try {
    await assert.rejects(gitBytes(dir, hang, undefined, 500), /git credential took longer than \d+s and was stopped\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('gitRun() rejects on a timeout (never resolves with a fake exit code), and an ordinary fast call is unaffected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-git-timeout-'));
  try {
    await assert.rejects(gitRun(dir, hang, undefined, 500), /git credential took longer than \d+s and was stopped\./);
    const result = await gitRun(dir, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(result.code, 128, 'not a repository, but git ran and exited normally with no timeout at all');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

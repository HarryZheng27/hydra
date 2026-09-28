import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { run, killTree } from '../scripts/benchmark-run.mjs';

/**
 * O9 (docs/Benchmark.md): how the benchmark runs commands. A timeout has to stop the program a shell started, not
 * only the shell, and something a finished command left running must not hold the run open.
 */

const parent = path.join(process.cwd(), 'tests', 'fixtures', 'bench', 'tree-parent.cjs');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  return !alive(pid);
}

test('a timeout kills the whole tree, the program the shell started and what it started, and resolves promptly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-bench-run-'));
  let grandchild = 0;
  try {
    const pidFile = path.join(dir, 'pid');
    const started = Date.now();
    const result = await run(process.execPath, [parent, pidFile, 'hang'], { cwd: dir, timeoutMs: 1500 });
    const took = Date.now() - started;
    grandchild = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.timedOut, true);
    assert.ok(took < 8000, `resolved ${took} ms after starting`);
    assert.match(result.stdout, /started/);
    assert.ok(await gone(grandchild, 5000), 'the grandchild was killed too');
  } finally {
    if (grandchild && alive(grandchild)) await killTree(grandchild);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a command that exits while something it started keeps its output open resolves after a short grace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-bench-run-'));
  let grandchild = 0;
  try {
    const pidFile = path.join(dir, 'pid');
    const started = Date.now();
    const result = await run(process.execPath, [parent, pidFile, 'exit'], { cwd: dir, graceMs: 300 });
    const took = Date.now() - started;
    grandchild = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /started/);
    assert.ok(alive(grandchild), 'the grandchild really was still holding the output');
    assert.ok(took < 5000, `resolved ${took} ms after starting`);
  } finally {
    if (grandchild && alive(grandchild)) await killTree(grandchild);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an ordinary command resolves with its exit code, output and input', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(3))'], { input: 'hello', shell: false });
  assert.deepEqual([result.code, result.stdout, result.timedOut], [3, 'hello', false]);
});

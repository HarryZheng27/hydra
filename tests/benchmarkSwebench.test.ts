import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFromLeadInput } from '../src/core/plans';
import { planFileArguments } from '../src/core/hydraCli';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { sampleIds, seededRandom, swebenchPrompt, swebenchPlan, predictionLine, instanceFolder, submitArguments, listInstancesPython } from '../scripts/benchmark-swebench.mjs';

/**
 * O9 (docs/Benchmark.md, "SWE-bench Verified"): the scaffolding's pure parts and its local steps, without the
 * dataset, a clone or a submission.
 */

const root = process.cwd();
const script = path.join(root, 'scripts', 'benchmark.mjs');
const instance = { instance_id: 'owner__project-1234', repo: 'owner/project', base_commit: 'abc', problem_statement: '  Parsing "x" crashes.\n\nSteps: …  ', version: '1.0' };

function node(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const git = (cwd: string, ...args: string[]) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

test('the sample is the same for the same seed, whatever order the dataset lists the instances in', () => {
  const ids = Array.from({ length: 500 }, (_, index) => `repo__x-${index}`);
  const first = sampleIds(ids, 30, 7);
  assert.equal(first.length, 30);
  assert.equal(new Set(first).size, 30);
  assert.deepEqual(sampleIds([...ids].reverse(), 30, 7), first);
  assert.notDeepEqual(sampleIds(ids, 30, 8), first);
  assert.deepEqual(first, [...first].sort());
  assert.throws(() => sampleIds(ids, 501, 7), /only 500/);
  assert.throws(() => sampleIds(ids, 0, 7), /--n/);
  const random = seededRandom(1);
  const values = Array.from({ length: 1000 }, () => random());
  assert.ok(values.every(value => value >= 0 && value < 1));
});

test('both setups get the same issue text: the single prompt, and a one-job plan that hydra plan run accepts', () => {
  const prompt = swebenchPrompt(instance);
  assert.ok(prompt.startsWith('# Fix an issue in owner/project\n'));
  assert.ok(prompt.includes('Parsing "x" crashes.\n\nSteps: …\n'));
  const plan = swebenchPlan(instance);
  assert.equal(plan.brief, prompt);
  assert.equal(plan.jobs.length, 1);
  assert.deepEqual([plan.jobs[0].write_scope, plan.jobs[0].rigor], [['.'], 'standard']);
  const args = planFileArguments(JSON.stringify(plan), 'swebench.json', { unattended: true, minutes: 60, usd: 10 }, () => 'k');
  assert.equal(planFromLeadInput(args as never, { leadSessionId: 'user', idempotencyKey: 'k' }, 5).jobs.length, 1);
  const long = swebenchPlan({ ...instance, problem_statement: 'x'.repeat(6000) });
  assert.ok(long.jobs[0].brief.length <= 4000 && long.brief.length <= 8000, 'within a plan\'s limits');
});

test('predictions, folders, sb-cli\'s arguments, and the dataset listing', () => {
  assert.deepEqual(JSON.parse(predictionLine('a__b-1', 'hydra', 'diff')), { instance_id: 'a__b-1', model_name_or_path: 'hydra', model_patch: 'diff' });
  assert.equal(JSON.parse(predictionLine('a__b-1', 'hydra', undefined)).model_patch, '');
  assert.equal(instanceFolder('django__django-11099'), 'django__django-11099');
  assert.equal(instanceFolder('a/b:c'), 'a_b_c');
  assert.deepEqual(submitArguments('p.jsonl', 'run-1'), ['submit', 'swe-bench_verified', 'test', '--predictions_path', 'p.jsonl', '--run_id', 'run-1']);
  assert.match(listInstancesPython, /SWE-bench_Verified/);
});

test('swebench predictions diffs each prepared instance from its base commit, new files included; submit needs SWEBENCH_API_KEY', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-swebench-'));
  try {
    const repo = path.join(dir, 'instances', instance.instance_id, 'single');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'a.py'), 'x = 1\n');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@hydra.invalid');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'a.py'), 'x = 2\n');
    await writeFile(path.join(repo, 'b.py'), 'y = 1\n');
    await writeFile(path.join(dir, 'instances.json'), JSON.stringify({ seed: 1, instances: [{ ...instance, base_commit: base }] }));
    const ran = await node([script, 'swebench', 'predictions', '--dir', dir, '--setup', 'single', '--model', 'test-model']);
    assert.equal(ran.code, 0, ran.stderr);
    const [line, ...others] = (await readFile(path.join(dir, 'predictions-single.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(others.length, 0);
    const prediction = JSON.parse(line!);
    assert.deepEqual([prediction.instance_id, prediction.model_name_or_path], [instance.instance_id, 'test-model']);
    assert.match(prediction.model_patch, /-x = 1\n\+x = 2/);
    assert.match(prediction.model_patch, /b\.py/, 'a new file is part of the patch');
    const env = { ...process.env }; delete env.SWEBENCH_API_KEY;
    const submitted = await node([script, 'swebench', 'submit', '--dir', dir, '--setup', 'single'], env);
    assert.equal(submitted.code, 1);
    assert.match(submitted.stderr, /SWEBENCH_API_KEY/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs single --prompt runs the agent on a brief from elsewhere, with no gate or check unless asked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-swebench-'));
  try {
    const repo = path.join(dir, 'single');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(dir, 'prompt.md'), swebenchPrompt(instance));
    const fake = path.join(root, 'tests', 'fixtures', 'bench', 'fake-agent.cjs');
    const ran = await node([script, 'single', '--repo', repo, '--prompt', path.join(dir, 'prompt.md'), '--gate', 'none', '--command', `"${process.execPath}" "${fake}"`]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(await readFile(path.join(dir, 'fake-agent-task.md'), 'utf8'), swebenchPrompt(instance));
    const results = JSON.parse(await readFile(path.join(dir, 'single-results.json'), 'utf8'));
    assert.equal(results.fixture, undefined);
    assert.equal(results.check, undefined);
    assert.equal(results.gate.passed, false);
    assert.match(results.gate.outputTail, /No gate ran/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

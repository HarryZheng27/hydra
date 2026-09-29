import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFromLeadInput } from '../src/core/plans';
import { planFileArguments } from '../src/core/hydraCli';
import {
  sampleIds, seededRandom, selectInstances, datasetRowsUrl, instancesFromRowsPage, swebenchPrompt, swebenchPlan, predictionLine, predictionsJsonl,
  instanceFolder, mirrorFolder, pendingInstances, checkRunMatches, submitArguments, reportArguments, reportFile, parseReport, submitProblems,
  renderSwebenchSummary, defaultRunId, usageLimitText, limitStopped, listInstancesPython, swebench, swebenchSubmit,
// @ts-expect-error: a plain .mjs module with no type declarations.
} from '../scripts/benchmark-swebench.mjs';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { run } from '../scripts/benchmark-run.mjs';

/**
 * O9 (docs/Benchmark.md, "SWE-bench Verified"): the runner's pure parts, and the whole loop with fakes for the
 * dataset, the agent, Hydra and sb-cli: local git repositories stand in for GitHub, and nothing is downloaded.
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
const gitSync = (cwd: string, ...args: string[]) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
async function git(argv: string[], cwd: string): Promise<string> {
  const result = await run('git', argv, { cwd, shell: false });
  if (result.code !== 0) throw new Error(`git ${argv[0]} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout;
}
/** The flags the runner hands benchmark.mjs's single and hydra. */
interface RunFlags { repo: string; prompt: string; gate: string; fixture: string; task: string; [key: string]: string }
const quiet = async <T>(action: () => Promise<T>): Promise<T> => { const log = console.log; console.log = () => undefined; try { return await action(); } finally { console.log = log; } };

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
  const all = ids.map(id => ({ instance_id: id, repo: 'r/r' }));
  assert.deepEqual(selectInstances([...all].reverse(), 30, 7).map((item: { instance_id: string }) => item.instance_id), first);
  // Pinned: a change to the generator or the shuffle would silently draw another sample for a recorded seed.
  assert.deepEqual(sampleIds(ids, 3, 1), sampleIds(ids, 3, 1));
  assert.equal(JSON.stringify(sampleIds(Array.from({ length: 10 }, (_, index) => `i-${index}`), 3, 1)), JSON.stringify(sampleIds(Array.from({ length: 10 }, (_, index) => `i-${9 - index}`), 3, 1)));
});

test('the dataset comes from the datasets server a page of 100 rows at a time, keeping only the fields the runner needs', () => {
  const url = new URL(datasetRowsUrl(200));
  assert.equal(url.origin + url.pathname, 'https://datasets-server.huggingface.co/rows');
  assert.deepEqual(Object.fromEntries(url.searchParams), { dataset: 'princeton-nlp/SWE-bench_Verified', config: 'default', split: 'test', offset: '200', length: '100' });
  const page = instancesFromRowsPage({ num_rows_total: 500, rows: [{ row_idx: 0, row: { ...instance, patch: 'the gold patch', test_patch: 'tests', hints_text: 'hint' } }] });
  assert.equal(page.total, 500);
  assert.deepEqual(page.instances, [instance], 'the gold patch, its tests and the hints never reach the run folder');
  assert.throws(() => instancesFromRowsPage({ error: 'not ready' }), /not ready/);
  assert.match(listInstancesPython, /load_dataset\("princeton-nlp\/SWE-bench_Verified", split="test"\)/);
  assert.match(listInstancesPython, /\("instance_id", "repo", "base_commit", "problem_statement", "version"\)/);
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

test('predictions JSONL: one line per instance run, in the sample\'s order, in SWE-bench\'s three fields', () => {
  assert.deepEqual(JSON.parse(predictionLine('a__b-1', 'hydra', 'diff')), { instance_id: 'a__b-1', model_name_or_path: 'hydra', model_patch: 'diff' });
  assert.equal(JSON.parse(predictionLine('a__b-1', 'hydra', undefined)).model_patch, '');
  const instances = ['a-1', 'a-2', 'a-3'].map(id => ({ instance_id: id }));
  const text = predictionsJsonl(instances, { 'a-3': { status: 'done' }, 'a-1': { status: 'error' } }, { 'a-3': 'diff --git a/x b/x\n' }, 'm');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(text.trimEnd().split('\n').map((line: string) => JSON.parse(line)), [
    { instance_id: 'a-1', model_name_or_path: 'm', model_patch: '' },
    { instance_id: 'a-3', model_name_or_path: 'm', model_patch: 'diff --git a/x b/x\n' },
  ]);
  assert.equal(predictionsJsonl(instances, {}, {}, 'm'), '');
  assert.equal(instanceFolder('django__django-11099'), 'django__django-11099');
  assert.equal(instanceFolder('a/b:c'), 'a_b_c');
  assert.equal(mirrorFolder('django/django'), 'django__django.git');
});

test('resume: done instances are skipped, failed ones too unless retried, and a folder keeps its seed, n and setup', () => {
  const instances = ['a', 'b', 'c', 'd'].map(id => ({ instance_id: id }));
  const records = { a: { status: 'done' }, b: { status: 'error' }, c: { status: 'running' } };
  const plain = pendingInstances(instances, records);
  assert.deepEqual(plain.todo.map((item: { instance_id: string }) => item.instance_id), ['c', 'd']);
  assert.deepEqual(plain.skipped, ['a', 'b']);
  assert.deepEqual(pendingInstances(instances, records, { retryErrors: true }).todo.map((item: { instance_id: string }) => item.instance_id), ['b', 'c', 'd']);
  checkRunMatches({ seed: 1, n: 30, setup: 'single' }, { seed: 1, n: 30, setup: 'single' });
  assert.throws(() => checkRunMatches({ seed: 1, n: 30, setup: 'single' }, { seed: 1, n: 30, setup: 'hydra' }), /--setup single, not hydra/);
  assert.throws(() => checkRunMatches({ seed: 1, n: 30 }, { seed: 2, n: 30 }), /--seed 1/);
});

test('sb-cli: the command lines, where its report lands, what is missing, and the resolved report', () => {
  assert.deepEqual(submitArguments('p.jsonl', 'run-1', 'reports'), ['submit', 'swe-bench_verified', 'test', '--predictions_path', 'p.jsonl', '--run_id', 'run-1', '--output_dir', 'reports']);
  assert.deepEqual(submitArguments('p.jsonl', 'run-1'), ['submit', 'swe-bench_verified', 'test', '--predictions_path', 'p.jsonl', '--run_id', 'run-1']);
  assert.deepEqual(reportArguments('run-1', 'reports'), ['get-report', 'swe-bench_verified', 'test', 'run-1', '--output_dir', 'reports', '--overwrite', '1']);
  assert.equal(reportFile('reports', 'run-1'), path.join('reports', 'swe-bench_verified__test__run-1.json'));
  assert.equal(defaultRunId({ setup: 'hydra', seed: 1, n: 30 }, '/x/my slice'), 'hydra-hydra-seed1-n30-my-slice');
  assert.deepEqual(submitProblems({ apiKey: 'k', sbCliFound: true, predictionsCount: 3 }), []);
  const all = submitProblems({ predictionsCount: 0 });
  assert.equal(all.length, 3);
  assert.match(all.join('\n'), /no predictions[\s\S]*SWEBENCH_API_KEY[\s\S]*sb-cli isn't on PATH/);

  const report = { total_instances: 500, submitted_instances: 4, completed_instances: 4, resolved_instances: 2, unresolved_instances: 2, error_instances: 0, pending_instances: 0, failed_instances: 0, resolved_ids: ['b', 'a'], unresolved_ids: ['c', 'd'] };
  const parsed = parseReport(report, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual([parsed.resolved, parsed.selected, parsed.submitted, parsed.totalInSplit, parsed.rate, parsed.complete], [2, 5, 4, 500, 0.4, true]);
  assert.deepEqual(parsed.resolvedIds, ['a', 'b']);
  assert.deepEqual(parsed.unresolvedIds, ['c', 'd']);
  assert.equal(parseReport({ ...report, pending_instances: 2 }, ['a']).complete, false);
  assert.equal(parseReport({ resolved_ids: ['a'] }, ['a', 'b']).resolved, 1, 'ids alone are enough');
  assert.equal(parseReport({ resolved_instances: 1, submitted_instances: 2 }).rate, 0.5);
  assert.throws(() => parseReport({ total_instances: 500 }, []), /resolved/);
  assert.throws(() => parseReport(null, []), /JSON object/);

  const summary = renderSwebenchSummary([{ folder: 's1', setup: 'single', resolved: 12, selected: 30, rate: 0.4, runId: 'r1' }, { folder: 'h1', setup: 'hydra', resolved: 14, selected: 30, rate: 0.4667, runId: 'r2', complete: false }]);
  assert.match(summary, /\| h1 \| hydra \| 14\/30 \(grading not finished\) \| 46\.7% \| r2 \|/);
  assert.match(summary, /\| s1 \| single \| 12\/30 \| 40\.0% \| r1 \|/);
  assert.equal(renderSwebenchSummary([]), '');
  assert.ok(usageLimitText('Claude AI usage limit reached') && !usageLimitText('exit 1'));
});

/** An upstream repository with a base commit and the later fix, plus a fake datasets server serving one instance. */
async function upstream(dir: string) {
  const origin = path.join(dir, 'upstream', 'owner', 'project');
  await mkdir(origin, { recursive: true });
  gitSync(origin, 'init', '-q', '-b', 'main'); gitSync(origin, 'config', 'user.name', 'T'); gitSync(origin, 'config', 'user.email', 't@hydra.invalid');
  await writeFile(path.join(origin, 'a.py'), 'x = 1\n');
  gitSync(origin, 'add', '-A'); gitSync(origin, 'commit', '-qm', 'base');
  const base = gitSync(origin, 'rev-parse', 'HEAD');
  await writeFile(path.join(origin, 'a.py'), 'x = 42  # the fix\n');
  gitSync(origin, 'commit', '-qam', 'the upstream fix'); gitSync(origin, 'tag', 'v2');
  const fix = gitSync(origin, 'rev-parse', 'HEAD'), fixBlob = gitSync(origin, 'rev-parse', 'HEAD:a.py');
  const one = { ...instance, base_commit: base };
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return { ok: true, json: async () => ({ num_rows_total: 1, rows: [{ row_idx: 0, row: { ...one, patch: 'gold' } }] }) }; };
  return { base, fix, fixBlob, one, remote: (name: string) => path.join(dir, 'upstream', ...name.split('/')), fetchImpl, fetches: () => fetched };
}

test('swebench single: selects, clones at the base commit without the later history, runs the agent, and resumes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-swebench-'));
  try {
    const up = await upstream(dir);
    const out = path.join(dir, 'slice');
    const calls: Array<RunFlags> = [];
    const runSingle = async (flags: RunFlags) => {
      calls.push(flags);
      assert.equal(gitSync(flags.repo, 'log', '--all', '--format=%s'), 'base', 'the fix is out of reach');
      assert.equal(gitSync(flags.repo, 'tag'), '');
      assert.equal(gitSync(flags.repo, 'remote'), '');
      // Not only unreachable: the later commit and its file aren't in the repository at all, not even by hash.
      for (const object of [up.fix, up.fixBlob]) assert.notEqual(spawnSync('git', ['cat-file', '-e', object], { cwd: flags.repo, windowsHide: true }).status, 0, `${object} is present`);
      assert.equal(existsSync(path.join(flags.repo, '.git', 'objects', 'info', 'alternates')), false, 'no borrowed objects');
      assert.equal(gitSync(flags.repo, 'rev-parse', 'HEAD'), up.base);
      await writeFile(path.join(flags.repo, 'a.py'), 'x = 2\n');
      await writeFile(path.join(flags.repo, 'b.py'), 'y = 1\n');
      return { kind: 'single', cost: { usd: 1.25 }, agentResult: { isError: false } };
    };
    const deps = { root: dir, run, git, runSingle, runHydra: () => assert.fail('no Hydra'), openHydra: () => assert.fail('no window'), remote: up.remote, fetchImpl: up.fetchImpl };
    const flags = { n: '1', seed: '1', setup: 'single', out, mirrors: path.join(dir, 'mirrors') };
    await quiet(() => swebench(flags, [], deps));
    assert.equal(calls.length, 1, await readFile(path.join(out, instance.instance_id, 'instance.json'), 'utf8').catch(() => 'no record'));
    assert.equal(calls[0]!.gate, 'none');
    assert.equal(await readFile(calls[0]!.prompt, 'utf8'), swebenchPrompt(up.one));
    const [line, ...others] = (await readFile(path.join(out, 'predictions.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(others.length, 0);
    const prediction = JSON.parse(line!);
    assert.deepEqual([prediction.instance_id, prediction.model_name_or_path], [instance.instance_id, 'hydra-benchmark-single']);
    assert.match(prediction.model_patch, /-x = 1\n\+x = 2/);
    assert.match(prediction.model_patch, /b\.py/, 'a new file is part of the patch');
    const record = JSON.parse(await readFile(path.join(out, instance.instance_id, 'instance.json'), 'utf8'));
    assert.deepEqual([record.status, record.usd, typeof record.seconds], ['done', 1.25, 'number']);
    assert.equal(JSON.parse(await readFile(path.join(out, 'instances.json'), 'utf8')).instances[0].patch, undefined);

    await quiet(() => swebench(flags, [], deps));
    assert.equal(calls.length, 1, 'a done instance isn\'t run again');
    assert.equal(up.fetches(), 1, 'the cached sample needs no network');
    await assert.rejects(swebench({ ...flags, setup: 'hydra' }, [], deps), /--setup single, not hydra/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('a usage limit is found in an error, in Claude Code\'s result, or in an unfinished Hydra plan\'s report', () => {
  assert.match(limitStopped({ error: 'claude exited with 1: Claude AI usage limit reached' }), /usage limit/);
  assert.match(limitStopped({ results: { kind: 'single', agentResult: { isError: true, subtype: 'success', message: 'Claude AI usage limit reached|1760000000' } } }), /usage limit/);
  assert.equal(limitStopped({ results: { kind: 'single', agentResult: { isError: true, subtype: 'error_max_turns' } } }), undefined);
  assert.equal(limitStopped({ error: 'git clone failed' }), undefined);
  const unfinished = { kind: 'hydra', jobs: [{ key: 'fix', status: 'failed' }] };
  assert.match(limitStopped({ results: unfinished, report: 'The head stopped: usage limit reached.' }), /didn't finish/);
  assert.equal(limitStopped({ results: unfinished, report: 'The head failed its tests.' }), undefined);
  const finished = { kind: 'hydra', integrationTip: 'abc', jobs: [{ key: 'fix', status: 'done' }] };
  assert.equal(limitStopped({ results: finished, report: 'Waited 40s on a rate limit, then went on.' }), undefined, 'a plan that finished after waiting isn\'t stopped');
  assert.match(limitStopped({ results: { ...finished, review: { usageLimit: true } } }), /review/);
});

async function stopsThenResumes(setup: 'single' | 'hydra', stop: (repo: string) => Promise<unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-swebench-'));
  try {
    const up = await upstream(dir);
    const out = path.join(dir, 'slice');
    let limited = true, calls = 0;
    const fixed = async (flags: RunFlags) => {
      calls++;
      if (limited) return stop(flags.repo);
      await writeFile(path.join(flags.repo, 'a.py'), 'x = 2\n');
      if (setup === 'single') return { kind: 'single', agentResult: { isError: false } };
      gitSync(flags.repo, 'checkout', '-q', '-b', 'integration'); gitSync(flags.repo, 'commit', '-qam', 'fix');
      return { kind: 'hydra', integrationTip: gitSync(flags.repo, 'rev-parse', 'HEAD'), jobs: [{ key: 'fix', status: 'done' }] };
    };
    const deps = { root: dir, run, git, runSingle: fixed, runHydra: fixed, openHydra: async () => undefined, remote: up.remote, fetchImpl: up.fetchImpl };
    const flags = { n: '1', seed: '1', setup, out, mirrors: path.join(dir, 'mirrors') };
    const error = await quiet<(Error & { exitCode?: number }) | undefined>(() => swebench(flags, [], deps).then(() => undefined, (thrown: Error & { exitCode?: number }) => thrown));
    assert.equal(error?.exitCode, 3);
    assert.match(error!.message, /Run the same command again/);
    assert.equal(existsSync(path.join(out, instance.instance_id, 'instance.json')), false, 'a limit leaves no record');
    assert.equal((await readFile(path.join(out, 'predictions.jsonl'), 'utf8').catch(() => '')).trim(), '', 'nor a prediction');
    limited = false;
    await quiet(() => swebench(flags, [], deps));
    assert.equal(calls, 2, 'the same command runs it again, without --retry-errors');
    assert.equal(JSON.parse(await readFile(path.join(out, instance.instance_id, 'instance.json'), 'utf8')).status, 'done');
    assert.match(JSON.parse((await readFile(path.join(out, 'predictions.jsonl'), 'utf8')).trim()).model_patch, /\+x = 2/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('a usage limit thrown by the single agent stops with exit code 3, and the same command resumes that instance', () =>
  stopsThenResumes('single', async () => { throw new Error('claude exited with 1: Claude AI usage limit reached'); }));
test('a usage limit in Claude Code\'s own result stops and resumes too', () =>
  stopsThenResumes('single', async () => ({ kind: 'single', agentResult: { isError: true, subtype: 'success', message: 'Claude AI usage limit reached' } })));
test('a Hydra plan a usage limit stopped (its report says so) stops and resumes too', () =>
  stopsThenResumes('hydra', async repo => {
    await writeFile(path.join(path.dirname(repo), 'hydra-report.md'), '# Report\n\nJob fix: the head stopped, usage limit reached.\n');
    return { kind: 'hydra', jobs: [{ key: 'fix', status: 'failed' }] };
  }));

test('swebench hydra: opens the window, runs the one-job plan, and takes the patch from the integration tip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-swebench-'));
  try {
    const up = await upstream(dir);
    const out = path.join(dir, 'slice');
    const opened: string[] = [];
    const runHydra = async (flags: RunFlags) => {
      assert.deepEqual([flags.fixture, flags.task], ['none', 'swebench']);
      const plan = JSON.parse(await readFile(path.join(flags.repo, '.hydra', 'plans', 'swebench.json'), 'utf8'));
      assert.deepEqual(plan.jobs[0].write_scope, ['.']);
      gitSync(flags.repo, 'checkout', '-q', '-b', 'hydra/integration');
      await writeFile(path.join(flags.repo, 'a.py'), 'x = 3\n');
      gitSync(flags.repo, 'commit', '-qam', 'fix');
      const tip = gitSync(flags.repo, 'rev-parse', 'HEAD');
      gitSync(flags.repo, 'checkout', '-q', 'main');
      await writeFile(path.join(flags.repo, 'stray.py'), 'left in the lead folder\n');
      return { kind: 'hydra', integrationTip: tip, cost: { usd: 2, usdJobs: 1, jobs: 1 } };
    };
    const deps = { root: dir, run, git, runHydra, openHydra: async (repo: string) => { opened.push(repo); }, remote: up.remote, fetchImpl: up.fetchImpl };
    await quiet(() => swebench({ n: '1', seed: '1', setup: 'hydra', out, mirrors: path.join(dir, 'mirrors') }, [], deps));
    assert.deepEqual(opened, [path.join(out, instance.instance_id, 'repo')]);
    const prediction = JSON.parse((await readFile(path.join(out, 'predictions.jsonl'), 'utf8')).trim());
    assert.match(prediction.model_patch, /\+x = 3/);
    assert.doesNotMatch(prediction.model_patch, /stray|\.hydra/);
    assert.equal(JSON.parse(await readFile(path.join(out, instance.instance_id, 'instance.json'), 'utf8')).usd, 2);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('swebench-submit fails fast naming what is missing, and otherwise writes resolved.json from sb-cli\'s report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-swebench-'));
  try {
    await writeFile(path.join(dir, 'swebench.json'), JSON.stringify({ seed: 1, n: 2, setup: 'single', model: 'm' }));
    await writeFile(path.join(dir, 'instances.json'), JSON.stringify({ instances: [{ instance_id: 'a' }, { instance_id: 'b' }] }));
    const missing = await node([script, 'swebench-submit', '--out', dir, '--sb-cli', 'hydra-no-such-sb-cli'], { ...process.env, SWEBENCH_API_KEY: '' });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no predictions[\s\S]*SWEBENCH_API_KEY[\s\S]*sb-cli isn't on PATH/);

    await writeFile(path.join(dir, 'predictions.jsonl'), predictionLine('a', 'm', 'diff') + '\n' + predictionLine('b', 'm', '') + '\n');
    const commands: string[][] = [];
    const fakeRun = async (command: string, argv: string[]) => {
      commands.push([command, ...argv]);
      if (argv[0] === 'submit') {
        const outputDir = argv[argv.indexOf('--output_dir') + 1]!;
        await mkdir(outputDir, { recursive: true });
        await writeFile(reportFile(outputDir, argv[argv.indexOf('--run_id') + 1]), JSON.stringify({ total_instances: 500, submitted_instances: 2, resolved_instances: 1, pending_instances: 0, resolved_ids: ['a'] }));
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    await quiet(() => swebenchSubmit({ out: dir, 'run-id': 'r1' }, [], { run: fakeRun, env: { SWEBENCH_API_KEY: 'k' }, sleep: async () => undefined }));
    assert.deepEqual(commands.map(command => command.slice(0, 2)), [['sb-cli', '--help'], ['sb-cli', 'submit']]);
    assert.deepEqual(commands[1]!.slice(1), submitArguments(path.join(dir, 'predictions.jsonl'), 'r1', path.join(dir, 'sb-cli-reports')));
    const resolved = JSON.parse(await readFile(path.join(dir, 'resolved.json'), 'utf8'));
    assert.deepEqual([resolved.setup, resolved.resolved, resolved.selected, resolved.rate, resolved.runId], ['single', 1, 2, 0.5, 'r1']);
    assert.deepEqual(resolved.resolvedIds, ['a']);

    const summarized = await node([script, 'summarize', '--runs', dir, '--out', path.join(dir, 'summary.md')]);
    assert.equal(summarized.code, 0, summarized.stderr);
    assert.match(await readFile(path.join(dir, 'summary.md'), 'utf8'), /## SWE-bench Verified[\s\S]*\| single \| 1\/2 \| 50\.0% \| r1 \|/);
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

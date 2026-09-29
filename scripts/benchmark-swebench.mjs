// O9 (docs/Benchmark.md, "SWE-bench Verified"): a slice of SWE-bench Verified, run end to end by one command and
// graded in the cloud with sb-cli. The pure parts are exported for tests; `swebench` and `swebenchSubmit` are the
// effectful shells, given run, git and the single/hydra runners by benchmark.mjs.
//
//   node scripts/benchmark.mjs swebench --n 30 --seed 1 --setup single|hydra [--out <dir>] [options]
//   node scripts/benchmark.mjs swebench predictions --out <dir>          (rewrite predictions.jsonl from what's done)
//   node scripts/benchmark.mjs swebench-submit --out <dir> [--run-id <id>] [--wait <minutes>]
import fs from 'node:fs/promises';
import path from 'node:path';

export const dataset = 'princeton-nlp/SWE-bench_Verified';
export const swebenchSetups = Object.freeze(['single', 'hydra']);
/** sb-cli's names for the dataset and split (checked against sb-cli's README and source, 2026-09). */
export const sbSubset = 'swe-bench_verified';
export const sbSplit = 'test';
/** The fields of a dataset row the runner keeps: the prompt needs the issue, the clone the repo and commit. */
export const instanceFields = Object.freeze(['instance_id', 'repo', 'base_commit', 'problem_statement', 'version']);
/** The per-instance record's version, so a later format change can't be misread as this one. */
export const recordVersion = 1;

// ---- the dataset ----

/** The dataset host's page of rows (pure): at most 100 rows a request, which is the server's own limit. */
export function datasetRowsUrl(offset, length = 100, name = dataset) {
  const query = new URLSearchParams({ dataset: name, config: 'default', split: 'test', offset: String(offset), length: String(length) });
  return `https://datasets-server.huggingface.co/rows?${query}`;
}
/** A rows API response, as instances with only instanceFields, and the dataset's row count (pure). */
export function instancesFromRowsPage(page) {
  if (!page || !Array.isArray(page.rows)) throw new Error(`The datasets server answered without rows${page?.error ? `: ${page.error}` : ''}.`);
  return {
    total: typeof page.num_rows_total === 'number' ? page.num_rows_total : undefined,
    instances: page.rows.map(item => pickInstance(item.row ?? {})),
  };
}
const pickInstance = row => Object.fromEntries(instanceFields.map(key => [key, row[key]]));

/** Python that prints the dataset's instances as JSON lines (--source python: needs `pip install datasets`). */
export const listInstancesPython = [
  'import json',
  'from datasets import load_dataset',
  `for row in load_dataset(${JSON.stringify(dataset)}, split="test"):`,
  `    print(json.dumps({k: row[k] for k in (${instanceFields.map(field => JSON.stringify(field)).join(', ')})}))`,
].join('\n');

/** A small seeded generator (mulberry32), so a sample can be drawn again from its seed (pure). */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` instance ids drawn with `seed` (pure): the ids are sorted first, so the dataset's order doesn't matter. */
export function sampleIds(ids, n, seed) {
  if (!Number.isInteger(n) || n < 1) throw new Error('--n must be a whole number of at least 1.');
  if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number.');
  const pool = [...new Set(ids)].sort();
  if (n > pool.length) throw new Error(`--n is ${n}, but there are only ${pool.length} instances.`);
  const random = seededRandom(seed);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n).sort();
}
/** The sampled instances themselves, in id order (pure). */
export function selectInstances(all, n, seed) {
  const byId = new Map(all.map(instance => [instance.instance_id, instance]));
  return sampleIds([...byId.keys()], n, seed).map(id => byId.get(id));
}

// ---- what each setup is given ----

/** The issue as both setups get it (pure): the repository, the issue text, and what to do. Hints are left out. */
export function swebenchPrompt(instance) {
  return [
    `# Fix an issue in ${instance.repo}`, '',
    'The repository is checked out at the commit the issue was reported against. Change the code so the issue is fixed.',
    'Keep the change as small as the fix needs; don\'t change or add tests unless the fix needs it. Run the tests that cover your change if you can.', '',
    '## The issue', '',
    String(instance.problem_statement ?? '').trim(), '',
  ].join('\n');
}

/**
 * Hydra's side (pure): a one-job plan file whose brief is the same issue text, with the standard rigor (the plan's
 * integration gate then reviews it), and the whole repository as its write scope.
 */
export function swebenchPlan(instance) {
  const brief = swebenchPrompt(instance);
  return {
    title: `Fix ${instance.instance_id}`.slice(0, 200),
    brief: brief.slice(0, 8000),
    jobs: [{ key: 'fix', title: 'Fix the issue', brief: brief.length > 4000 ? `${brief.slice(0, 3900)}\n\n(The issue continues in the plan's brief.)` : brief, write_scope: ['.'], rigor: 'standard' }],
  };
}

// ---- folders, resume and predictions ----

/** A folder name for an instance id (pure): owner__repo-1234 is already safe; anything else is replaced. */
export const instanceFolder = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
/** The bare mirror's folder name for a repository (pure): owner/name is owner__name.git. */
export const mirrorFolder = repo => `${String(repo).replace(/[^A-Za-z0-9_.-]/g, '__')}.git`;
/** The paths the model patch covers: everything but Hydra's own folder (pure). */
export const patchScope = Object.freeze(['--', '.', ':(exclude).hydra']);

/**
 * Which instances still need a run (pure). An instance with a record is skipped: done, or failed with an error
 * (its patch, maybe empty, is still a prediction). `retryErrors` runs the failed ones again.
 */
export function pendingInstances(instances, records, { retryErrors = false } = {}) {
  const todo = [], skipped = [];
  for (const instance of instances) {
    const record = records[instance.instance_id];
    if (record && (record.status === 'done' || (record.status === 'error' && !retryErrors))) skipped.push(instance.instance_id);
    else todo.push(instance);
  }
  return { todo, skipped };
}

/** One line of predictions JSONL, as sb-cli reads it (pure). An empty patch is still recorded: it counts as unresolved. */
export function predictionLine(instanceId, modelName, patch) {
  return JSON.stringify({ instance_id: instanceId, model_name_or_path: modelName, model_patch: patch ?? '' });
}
/** The predictions file (pure): one line per instance that has a record, in the sample's order. */
export function predictionsJsonl(instances, records, patches, modelName) {
  const lines = instances.filter(instance => records[instance.instance_id]).map(instance => predictionLine(instance.instance_id, modelName, patches[instance.instance_id] ?? ''));
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** The run's settings must match what the folder was started with (pure): a folder holds one sample and one setup. */
export function checkRunMatches(saved, wanted) {
  for (const key of ['seed', 'n', 'setup']) {
    if (saved[key] !== undefined && wanted[key] !== undefined && saved[key] !== wanted[key]) throw new Error(`This folder was started with --${key} ${saved[key]}, not ${wanted[key]}: use another --out.`);
  }
}

// ---- sb-cli ----

/** sb-cli's run id for a folder (pure): letters, digits, dots, dashes and underscores. */
export const defaultRunId = (run, dir) => `hydra-${run.setup ?? 'run'}-seed${run.seed ?? 'x'}-n${run.n ?? 'x'}-${path.basename(dir)}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100);
/** `sb-cli submit`'s arguments (pure): it waits for grading and writes the report into outputDir by default. */
export function submitArguments(predictionsFile, runId, outputDir) {
  return ['submit', sbSubset, sbSplit, '--predictions_path', predictionsFile, '--run_id', runId, ...(outputDir ? ['--output_dir', outputDir] : [])];
}
/** `sb-cli get-report`'s arguments (pure), overwriting an earlier, still-pending report. */
export function reportArguments(runId, outputDir) {
  return ['get-report', sbSubset, sbSplit, runId, '--output_dir', outputDir, '--overwrite', '1'];
}
/** Where sb-cli writes a run's report (pure): `{subset}__{split}__{run_id}.json` in its output folder. */
export const reportFile = (outputDir, runId) => path.join(outputDir, `${sbSubset}__${sbSplit}__${runId}.json`);

/**
 * The resolved rate from sb-cli's report (pure). The counts (resolved_instances, submitted_instances,
 * pending_instances, …) are the keys sb-cli prints. total_instances is the whole split (500), so the rate here is
 * over the sample: resolved / the instances selected. Per-instance ids (resolved_ids, unresolved_ids, error_ids)
 * are kept when the report has them.
 */
export function parseReport(report, selectedIds) {
  if (!report || typeof report !== 'object') throw new Error('The report isn\'t a JSON object.');
  const number = key => typeof report[key] === 'number' ? report[key] : undefined;
  const ids = key => Array.isArray(report[key]) ? report[key].map(String).sort() : undefined;
  const resolvedIds = ids('resolved_ids');
  const resolved = number('resolved_instances') ?? resolvedIds?.length;
  if (resolved === undefined) throw new Error('The report has neither resolved_instances nor resolved_ids.');
  const selected = selectedIds?.length ?? number('submitted_instances');
  const pending = number('pending_instances') ?? 0;
  return {
    resolved, selected, submitted: number('submitted_instances'), totalInSplit: number('total_instances'),
    completed: number('completed_instances'), failed: number('failed_instances'), errors: number('error_instances'), pending,
    complete: pending === 0,
    rate: selected ? Math.round((resolved / selected) * 1e4) / 1e4 : undefined,
    ...(resolvedIds ? { resolvedIds } : {}),
    ...(ids('unresolved_ids') ? { unresolvedIds: ids('unresolved_ids') } : {}),
    ...(ids('error_ids') ? { errorIds: ids('error_ids') } : {}),
  };
}

/** What's missing before submitting (pure): each a sentence, so all of them are said at once. */
export function submitProblems({ apiKey, sbCliFound, predictionsCount }) {
  const problems = [];
  if (!predictionsCount) problems.push('There are no predictions yet (predictions.jsonl is missing or empty): run `benchmark.mjs swebench` first.');
  if (!apiKey) problems.push('SWEBENCH_API_KEY isn\'t set: create a key with `sb-cli gen-api-key <email>`, verify it, and set it.');
  if (!sbCliFound) problems.push('sb-cli isn\'t on PATH: `pip install sb-cli`.');
  return problems;
}

/** The SWE-bench section of a summary (pure): one row per resolved.json, grouped by setup. */
export function renderSwebenchSummary(rows) {
  if (!rows.length) return '';
  const lines = ['## SWE-bench Verified', '', '| Run | Setup | Resolved | Rate | Run id |', '| --- | --- | --- | --- | --- |'];
  for (const row of [...rows].sort((a, b) => a.setup.localeCompare(b.setup) || a.folder.localeCompare(b.folder))) {
    lines.push(`| ${row.folder} | ${row.setup} | ${row.resolved}/${row.selected ?? '?'}${row.complete === false ? ' (grading not finished)' : ''} | ${typeof row.rate === 'number' ? `${(row.rate * 100).toFixed(1)}%` : '–'} | ${row.runId ?? '–'} |`);
  }
  const bySetup = new Map();
  for (const row of rows) { const sum = bySetup.get(row.setup) ?? { resolved: 0, selected: 0 }; sum.resolved += row.resolved; sum.selected += row.selected ?? 0; bySetup.set(row.setup, sum); }
  if (rows.length > bySetup.size) {
    lines.push('', '| Setup | Resolved, all runs |', '| --- | --- |');
    for (const [setup, sum] of [...bySetup].sort()) lines.push(`| ${setup} | ${sum.resolved}/${sum.selected}${sum.selected ? ` (${((sum.resolved / sum.selected) * 100).toFixed(1)}%)` : ''} |`);
  }
  return lines.join('\n') + '\n';
}

/** Whether an error means a usage limit, so the run stops instead of burning through the rest (pure). */
export const usageLimitText = text => /usage limit|limit reached|rate limit|\b429\b/i.test(String(text ?? ''));

/**
 * Why a usage limit stopped this instance, or undefined (pure). `error` is what the setup threw; `results` what it
 * returned; `report` Hydra's plan report. A limit counts when the error says so, when Claude Code's result is an
 * error that says so, when Hydra's final review didn't run for one, or when Hydra's plan didn't finish and its
 * report mentions one (a plan that finished after waiting out a rate limit isn't stopped by it).
 */
export function limitStopped({ error, results, report }) {
  if (error && usageLimitText(error)) return String(error).split('\n')[0].slice(0, 300);
  const agent = results?.agentResult;
  if (agent?.isError && usageLimitText(`${agent.subtype ?? ''} ${agent.message ?? ''}`)) return `The agent stopped: ${agent.message ?? agent.subtype}`.slice(0, 300);
  if (results?.kind === 'hydra') {
    if (results.review?.usageLimit) return 'Hydra\'s final review didn\'t run: a usage limit.';
    const unfinished = !results.integrationTip || (results.jobs ?? []).some(job => job.status !== 'done');
    if (unfinished && usageLimitText(report)) return 'Hydra\'s plan didn\'t finish, and its report names a usage limit.';
  }
  return undefined;
}

// ---- the effectful shell ----

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.access(file).then(() => true, () => false);
const errorText = error => error instanceof Error ? error.message : String(error);

/** Every instance of the dataset, from the datasets server (default) or Python's `datasets` (--source python). */
async function loadDataset({ source, python, run, root, fetchImpl = globalThis.fetch }) {
  if (source === 'python') {
    const listed = await run(python, ['-c', listInstancesPython], { cwd: root, timeoutMs: 30 * 60_000, shell: false });
    if (listed.code !== 0) throw new Error(`Listing the dataset with Python failed (is \`pip install datasets\` done?):\n${listed.stderr.trim().slice(-1500)}`);
    return listed.stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
  }
  if (source !== 'api') throw new Error('--source is api or python.');
  const all = [];
  for (let offset = 0, total = Infinity; offset < total;) {
    let page, lastError;
    for (let attempt = 1; attempt <= 4 && !page; attempt++) {
      try {
        const response = await fetchImpl(datasetRowsUrl(offset));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        page = instancesFromRowsPage(await response.json());
      } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, attempt * 2000)); }
    }
    if (!page) throw new Error(`The datasets server failed at offset ${offset} (${errorText(lastError)}). Try again, or --source python.`);
    total = page.total ?? offset + page.instances.length;
    if (!page.instances.length) break;
    all.push(...page.instances);
    offset += page.instances.length;
  }
  return all;
}

/**
 * The instance's repository at its base commit, in `repo`, from one bare mirror per source repository (cloned once,
 * fetched only when the commit is missing). The repository gets only the base commit and its history: a new empty
 * repository fetches one temporary ref at the base commit from the mirror, so git sends only the objects reachable
 * from it. No alternates, no remote, no other refs: the later history (the fix among it) isn't there at all, not
 * even by hash. (A clone, shared or not, would bring every object of the mirror.)
 */
export async function checkoutInstance({ instance, repo, mirrors, git, run, remote = name => `https://github.com/${name}.git` }) {
  const mirror = path.join(mirrors, mirrorFolder(instance.repo));
  await fs.mkdir(mirrors, { recursive: true });
  if (!await exists(mirror)) await git(['clone', '-q', '--mirror', remote(instance.repo), mirror], mirrors);
  const has = () => git(['cat-file', '-e', `${instance.base_commit}^{commit}`], mirror).then(() => true, () => false);
  if (!await has()) { await git(['fetch', '-q', '--prune', 'origin'], mirror); if (!await has()) throw new Error(`${instance.repo} has no commit ${instance.base_commit}.`); }
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.mkdir(path.dirname(repo), { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  await git(['init', '-q', '-b', 'main'], repo);
  const temporary = `refs/swebench/${instanceFolder(instance.instance_id)}`;
  await git(['update-ref', temporary, instance.base_commit], mirror);
  try { await git(['fetch', '-q', '--no-tags', '--update-head-ok', mirror, `+${temporary}:refs/heads/main`], repo); }
  finally { await git(['update-ref', '-d', temporary], mirror).catch(() => ''); }
  await git(['reset', '-q', '--hard', 'main'], repo);
  for (const step of [['config', 'user.name', 'Hydra benchmark'], ['config', 'user.email', 'benchmark@hydra.invalid']]) await git(step, repo);
}

/** The model patch: the diff from the base commit to `ref` (Hydra's integration tip), else to the working tree, new files included. */
export async function capturePatch({ repo, baseCommit, ref, git }) {
  if (ref) return git(['diff', '--no-color', '--no-ext-diff', '--binary', baseCommit, ref, ...patchScope], repo);
  await git(['add', '-A', ...patchScope], repo);
  return git(['diff', '--cached', '--no-color', '--no-ext-diff', '--binary', baseCommit, ...patchScope], repo);
}

async function readRecords(dir, instances) {
  const records = {}, patches = {};
  for (const instance of instances) {
    const folder = path.join(dir, instanceFolder(instance.instance_id));
    try { records[instance.instance_id] = await readJson(path.join(folder, 'instance.json')); } catch { continue; }
    patches[instance.instance_id] = await fs.readFile(path.join(folder, 'model.patch'), 'utf8').catch(() => '');
  }
  return { records, patches };
}

async function writePredictions(dir, run, instances) {
  const { records, patches } = await readRecords(dir, instances);
  const text = predictionsJsonl(instances, records, patches, run.model);
  await fs.writeFile(path.join(dir, 'predictions.jsonl'), text);
  return { count: text ? text.trimEnd().split('\n').length : 0, records };
}

/** The sample for this folder: instances.json when it's there (a resumed run needs no network), else the dataset's. */
async function sampleFor(dir, wanted, deps) {
  const file = path.join(dir, 'instances.json');
  if (await exists(file)) {
    const saved = await readJson(file);
    checkRunMatches({ seed: saved.seed, n: saved.n }, wanted);
    return saved.instances;
  }
  const all = await loadDataset({ ...deps, source: wanted.source });
  const instances = selectInstances(all, wanted.n, wanted.seed);
  await fs.writeFile(file, JSON.stringify({ dataset, source: wanted.source, seed: wanted.seed, n: wanted.n, of: all.length, selectedAt: new Date().toISOString(), instances }, null, 2) + '\n');
  console.log(`Chose ${wanted.n} of ${all.length} instances with seed ${wanted.seed}: ${file}`);
  return instances;
}

/**
 * `benchmark.mjs swebench`: the whole slice, resumable. deps: root, run, git, and runSingle/runHydra (benchmark.mjs's
 * single and hydra, which write <instance>/single-results.json or hydra-results.json and return the results).
 */
export async function swebench(flags, rest, deps) {
  const { root, run, git } = deps;
  const step = rest[0];
  if (step && step !== 'predictions') throw new Error('swebench runs a slice (--n, --seed, --setup, --out), or takes `predictions` (see docs/Benchmark.md).');
  const dir = path.resolve(flags.out ?? flags.dir ?? '');
  if (step === 'predictions') {
    const run = await readJson(path.join(dir, 'swebench.json')).catch(() => { throw new Error(`No swebench.json in ${dir}: run \`benchmark.mjs swebench\` there first.`); });
    const { instances } = await readJson(path.join(dir, 'instances.json'));
    const { count } = await writePredictions(dir, run, instances);
    console.log(`Wrote ${count} predictions to ${path.join(dir, 'predictions.jsonl')}.`);
    return;
  }
  const setup = flags.setup;
  if (!swebenchSetups.includes(setup)) throw new Error('--setup is single or hydra.');
  if (flags.seed === undefined) throw new Error('--seed is needed, so the sample can be drawn again.');
  const wanted = { n: Number(flags.n ?? 30), seed: Number(flags.seed), setup, source: flags.source ?? 'api' };
  if (!Number.isInteger(wanted.seed)) throw new Error('--seed must be a whole number.');
  if (!Number.isInteger(wanted.n) || wanted.n < 1) throw new Error('--n must be a whole number of at least 1.');
  const out = path.resolve(flags.out ?? path.join(root, '.bench', `swebench-seed${wanted.seed}-n${wanted.n}-${setup}`));
  await fs.mkdir(out, { recursive: true });
  const runFile = path.join(out, 'swebench.json');
  const saved = await readJson(runFile).catch(() => undefined);
  if (saved) checkRunMatches(saved, wanted);
  const runInfo = saved ?? { dataset, seed: wanted.seed, n: wanted.n, setup, model: flags.model ?? `hydra-benchmark-${setup}`, startedAt: new Date().toISOString() };
  if (!saved) await fs.writeFile(runFile, JSON.stringify(runInfo, null, 2) + '\n');
  const instances = await sampleFor(out, wanted, { ...deps, python: flags.python ?? (process.platform === 'win32' ? 'python' : 'python3') });
  const only = flags.only ? new Set(flags.only.split(',').map(id => id.trim())) : undefined;
  const { records } = await readRecords(out, instances);
  const { todo: pending, skipped } = pendingInstances(instances.filter(instance => !only || only.has(instance.instance_id)), records, { retryErrors: flags['retry-errors'] === 'yes' });
  // --limit <k>: at most k instances this time. Hydra can't close a window from the command line, so each hydra
  // instance leaves one open: run a batch, close the windows, run the same command again.
  const limit = flags.limit === undefined ? Infinity : Number(flags.limit);
  if (!(limit >= 1)) throw new Error('--limit must be a number of at least 1.');
  const todo = pending.slice(0, limit);
  if (skipped.length) console.log(`Skipping ${skipped.length} instance(s) already run (--retry-errors yes runs the failed ones again).`);
  const mirrors = path.resolve(flags.mirrors ?? path.join(root, '.bench', 'swebench-mirrors'));
  const minutes = Number(flags.minutes ?? 60);
  let stopped;
  for (const [index, instance] of todo.entries()) {
    const id = instance.instance_id;
    const folder = path.join(out, instanceFolder(id)), repo = path.join(folder, 'repo');
    console.log(`\n[${index + 1}/${todo.length}] ${id} (${setup})`);
    // An instance without a record was never finished: it starts again from a fresh folder.
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await fs.mkdir(folder, { recursive: true });
    const started = Date.now();
    const record = { version: recordVersion, instance_id: id, setup, startedAt: new Date(started).toISOString() };
    let results, ref, caught;
    try {
      await checkoutInstance({ instance, repo, mirrors, git, run, remote: deps.remote });
      await fs.writeFile(path.join(folder, 'prompt.md'), swebenchPrompt(instance));
      const agentStarted = Date.now();
      if (setup === 'single') {
        results = await deps.runSingle({ repo, prompt: path.join(folder, 'prompt.md'), gate: flags.gate ?? 'none', minutes: String(minutes), ...pick(flags, ['agent', 'claude', 'command']) });
      } else {
        await fs.mkdir(path.join(repo, '.hydra', 'plans'), { recursive: true });
        await fs.writeFile(path.join(repo, '.hydra', 'plans', 'swebench.json'), JSON.stringify(swebenchPlan(instance), null, 2) + '\n');
        if (flags.open !== 'none') await deps.openHydra(repo);
        results = await deps.runHydra({ repo, fixture: 'none', task: 'swebench', minutes: String(minutes), usd: flags.usd ?? '10', ...pick(flags, ['hydra', 'plan-store', 'poll']) });
        ref = results?.integrationTip;
        if (!ref) record.error = 'The plan left no integration tip: the patch is empty.';
      }
      record.agentSeconds = Math.round((Date.now() - agentStarted) / 1000);
      record.status = record.error ? 'error' : 'done';
    } catch (error) {
      record.status = 'error';
      record.error = errorText(error).slice(0, 4000);
      caught = record.error;
    }
    let patch = '';
    if (setup === 'single' || ref) {
      try { patch = await capturePatch({ repo, baseCommit: instance.base_commit, ref, git }); }
      catch (error) { record.status = 'error'; record.error = [record.error, `Capturing the patch failed: ${errorText(error)}`].filter(Boolean).join('\n'); }
    }
    // A usage limit isn't the instance's result: no record, so the next run starts it again from a fresh folder.
    const report = setup === 'hydra' ? await fs.readFile(path.join(folder, 'hydra-report.md'), 'utf8').catch(() => '') : '';
    const limit = limitStopped({ error: caught, results, report });
    if (limit) {
      await fs.writeFile(path.join(folder, 'usage-limit.txt'), `${limit}\n`);
      console.log(`${id}: stopped by a usage limit (${limit}); not recorded, so it runs again next time.`);
      stopped = id;
      break;
    }
    record.seconds = Math.round((Date.now() - started) / 1000);
    if (typeof results?.cost?.usd === 'number' && (results.kind !== 'hydra' || results.cost.usdJobs)) record.usd = results.cost.usd;
    if (results?.agentResult?.isError) record.agentError = results.agentResult.subtype ?? true;
    if (results?.timedOut) record.timedOut = true;
    record.patchBytes = Buffer.byteLength(patch);
    record.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(folder, 'model.patch'), patch);
    await fs.writeFile(path.join(folder, 'instance.json'), JSON.stringify(record, null, 2) + '\n');
    await writePredictions(out, runInfo, instances);
    console.log(`${id}: ${record.status} in ${record.seconds}s, ${record.patchBytes} bytes of patch${record.usd !== undefined ? `, $${record.usd.toFixed(2)}` : ''}${record.error ? `\n  ${record.error.split('\n')[0]}` : ''}`);
  }
  const { count, records: after } = await writePredictions(out, runInfo, instances);
  const done = Object.values(after).filter(record => record.status === 'done').length;
  const errors = Object.values(after).filter(record => record.status === 'error').length;
  console.log(`\n${done} done, ${errors} with errors, ${instances.length - done - errors} not run, of ${instances.length}. ${count} predictions in ${path.join(out, 'predictions.jsonl')}.\nNext: node scripts/benchmark.mjs swebench-submit --out "${out}"`);
  if (stopped) { const error = new Error(`USAGE LIMIT at ${stopped}: stopped. Run the same command again later to go on.`); error.exitCode = 3; throw error; }
}
const pick = (flags, keys) => Object.fromEntries(keys.filter(key => flags[key] !== undefined).map(key => [key, flags[key]]));

/**
 * `benchmark.mjs swebench-submit --out <dir>`: submits predictions.jsonl with sb-cli, which waits for the cloud grading
 * and writes its report; fetches the report again (get-report) until nothing is pending or --wait minutes pass; then
 * writes resolved.json. Fails before doing anything when the key, sb-cli or the predictions are missing.
 */
export async function swebenchSubmit(flags, _rest, { run, env = process.env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const dir = path.resolve(flags.out ?? flags.dir ?? '');
  const runInfo = await readJson(path.join(dir, 'swebench.json')).catch(() => { throw new Error(`No swebench.json in ${dir}: run \`benchmark.mjs swebench --out <dir>\` first.`); });
  const { instances } = await readJson(path.join(dir, 'instances.json'));
  const predictions = path.join(dir, 'predictions.jsonl');
  const predictionsCount = (await fs.readFile(predictions, 'utf8').catch(() => '')).split('\n').filter(line => line.trim()).length;
  const sbCli = flags['sb-cli'] ?? 'sb-cli';
  const probe = await run(sbCli, ['--help'], { cwd: dir, timeoutMs: 60_000 }).catch(() => ({ code: 1 }));
  const problems = submitProblems({ apiKey: env.SWEBENCH_API_KEY, sbCliFound: probe.code === 0, predictionsCount });
  if (problems.length) throw new Error(problems.join('\n'));
  const runId = flags['run-id'] ?? runInfo.runId ?? defaultRunId(runInfo, dir);
  const reports = path.join(dir, 'sb-cli-reports');
  const file = reportFile(reports, runId);
  if (!runInfo.submittedAt) {
    console.log(`Submitting ${predictionsCount} predictions as run ${runId} (sb-cli waits for the grading)…`);
    const submitted = await run(sbCli, submitArguments(predictions, runId, reports), { cwd: dir, timeoutMs: Number(flags.wait ?? 120) * 60_000 });
    process.stdout.write(submitted.stdout);
    if (submitted.code !== 0 && !submitted.timedOut) throw new Error(`sb-cli submit failed (${submitted.code}): ${(submitted.stderr || submitted.stdout).trim().slice(-1500)}`);
    await fs.writeFile(path.join(dir, 'swebench.json'), JSON.stringify({ ...runInfo, runId, submittedAt: new Date().toISOString() }, null, 2) + '\n');
  } else console.log(`Run ${runId} was submitted at ${runInfo.submittedAt}; fetching its report.`);
  const deadline = Date.now() + Number(flags.wait ?? 120) * 60_000;
  let parsed;
  for (;;) {
    const report = await readJson(file).catch(() => undefined);
    if (report) { parsed = parseReport(report, instances.map(instance => instance.instance_id)); if (parsed.complete) break; }
    if (Date.now() > deadline) break;
    if (report || !runInfo.submittedAt) await sleep(60_000);
    const fetched = await run(sbCli, reportArguments(runId, reports), { cwd: dir, timeoutMs: 10 * 60_000 });
    if (fetched.code !== 0) console.error(`sb-cli get-report answered ${fetched.code}: ${(fetched.stderr || fetched.stdout).trim().slice(-500)}`);
  }
  if (!parsed) throw new Error(`No report at ${file} after waiting: try \`benchmark.mjs swebench-submit --out "${dir}"\` again later.`);
  const resolved = { version: recordVersion, kind: 'swebench', dataset, setup: runInfo.setup, seed: runInfo.seed, n: runInfo.n, model: runInfo.model, runId, reportFile: path.relative(dir, file), fetchedAt: new Date().toISOString(), ...parsed };
  await fs.writeFile(path.join(dir, 'resolved.json'), JSON.stringify(resolved, null, 2) + '\n');
  console.log(`${runInfo.setup}: ${parsed.resolved}/${parsed.selected} resolved${parsed.complete ? '' : ` (${parsed.pending} still pending)`}. Wrote ${path.join(dir, 'resolved.json')}.`);
}

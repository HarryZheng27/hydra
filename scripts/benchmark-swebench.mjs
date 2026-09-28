// O9 (docs/Benchmark.md, "SWE-bench Verified"): scaffolding for a slice of SWE-bench Verified, graded in the cloud
// with sb-cli. Needs Python 3 with `datasets` and `sb-cli` installed, and SWEBENCH_API_KEY for submitting. Not run yet.
//
//   node scripts/benchmark.mjs swebench select --n 30 --seed 7 [--out <dir>]      the sample, from the dataset
//   node scripts/benchmark.mjs swebench prepare --dir <dir> [--only <id,id>]       a clone per instance and setup
//   node scripts/benchmark.mjs swebench predictions --dir <dir> --setup single|hydra [--model <name>]
//   node scripts/benchmark.mjs swebench submit --dir <dir> --setup single|hydra [--run-id <id>]
import fs from 'node:fs/promises';
import path from 'node:path';

export const dataset = 'princeton-nlp/SWE-bench_Verified';
export const swebenchSetups = Object.freeze(['single', 'hydra']);

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

/** One line of predictions JSONL, as sb-cli reads it (pure). An empty patch is still recorded: it counts as unresolved. */
export function predictionLine(instanceId, modelName, patch) {
  return JSON.stringify({ instance_id: instanceId, model_name_or_path: modelName, model_patch: patch ?? '' });
}

/** A folder name for an instance id (pure): owner__repo-1234 is already safe; anything else is replaced. */
export const instanceFolder = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');

/** The sb-cli command line that submits predictions for grading (pure). */
export function submitArguments(predictionsFile, runId) {
  return ['submit', 'swe-bench_verified', 'test', '--predictions_path', predictionsFile, '--run_id', runId];
}

/** Python that prints the dataset's instances as JSON lines: the fields the prompt and the clone need. */
export const listInstancesPython = [
  'import json',
  'from datasets import load_dataset',
  `for row in load_dataset(${JSON.stringify(dataset)}, split="test"):`,
  '    print(json.dumps({k: row[k] for k in ("instance_id", "repo", "base_commit", "problem_statement", "version")}))',
].join('\n');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

/** `benchmark.mjs swebench <step>`: the effectful steps, with run and git from benchmark.mjs. */
export async function swebench(flags, rest, { root, run, git }) {
  const step = rest[0];
  if (step === 'select') {
    const n = Number(flags.n ?? 30), seed = Number(flags.seed ?? Date.now() % 100000);
    const out = path.resolve(flags.out ?? path.join(root, '.bench', `swebench-seed-${seed}`));
    const python = flags.python ?? (process.platform === 'win32' ? 'python' : 'python3');
    const listed = await run(python, ['-c', listInstancesPython], { cwd: root, timeoutMs: 30 * 60_000, shell: false });
    if (listed.code !== 0) throw new Error(`Listing the dataset failed (is \`pip install datasets\` done?):\n${listed.stderr.trim().slice(-1500)}`);
    const all = listed.stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
    const chosen = new Set(sampleIds(all.map(item => item.instance_id), n, seed));
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'instances.json'), JSON.stringify({ dataset, seed, n, selectedAt: new Date().toISOString(), instances: all.filter(item => chosen.has(item.instance_id)) }, null, 2) + '\n');
    console.log(`Chose ${n} of ${all.length} instances with seed ${seed}: ${path.join(out, 'instances.json')}`);
    return;
  }
  const dir = path.resolve(flags.dir ?? '');
  const { instances } = await readJson(path.join(dir, 'instances.json')).catch(() => { throw new Error(`No instances.json in ${dir}: run swebench select first.`); });
  const only = flags.only ? new Set(flags.only.split(',')) : undefined;
  const wanted = instances.filter(instance => !only || only.has(instance.instance_id));
  if (step === 'prepare') {
    for (const instance of wanted) {
      const folder = path.join(dir, 'instances', instanceFolder(instance.instance_id));
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'prompt.md'), swebenchPrompt(instance));
      for (const setup of swebenchSetups) {
        const repo = path.join(folder, setup);
        if (await fs.access(repo).then(() => true, () => false)) { console.log(`${instance.instance_id}/${setup}: already there`); continue; }
        await git(['clone', '-q', `https://github.com/${instance.repo}.git`, repo], folder);
        await git(['checkout', '-q', '--detach', instance.base_commit], repo);
        if (setup === 'hydra') {
          await fs.mkdir(path.join(repo, '.hydra', 'plans'), { recursive: true });
          await fs.writeFile(path.join(repo, '.hydra', 'plans', 'swebench.json'), JSON.stringify(swebenchPlan(instance), null, 2) + '\n');
        }
      }
      console.log(`${instance.instance_id}: prepared`);
    }
    return;
  }
  const setup = flags.setup;
  if (!swebenchSetups.includes(setup)) throw new Error('--setup is single or hydra.');
  const predictions = path.join(dir, `predictions-${setup}.jsonl`);
  if (step === 'predictions') {
    const model = flags.model ?? `hydra-benchmark-${setup}`;
    const lines = [];
    for (const instance of wanted) {
      const repo = path.join(dir, 'instances', instanceFolder(instance.instance_id), setup);
      // Hydra's work is on its plan's integration branch: --ref names it (or any commit). Otherwise the working tree,
      // new files included (staged first, so the diff sees them).
      const scope = ['--', '.', ':(exclude).hydra'];
      let patch;
      if (setup === 'hydra' && flags.ref) patch = await git(['diff', '--no-color', '--no-ext-diff', instance.base_commit, flags.ref, ...scope], repo).catch(() => '');
      else {
        await git(['add', '-A', ...scope], repo).catch(() => '');
        patch = await git(['diff', '--cached', '--no-color', '--no-ext-diff', instance.base_commit, ...scope], repo).catch(() => '');
      }
      lines.push(predictionLine(instance.instance_id, model, patch));
    }
    await fs.writeFile(predictions, lines.join('\n') + '\n');
    console.log(`Wrote ${lines.length} predictions to ${predictions}.`);
    return;
  }
  if (step === 'submit') {
    if (!process.env.SWEBENCH_API_KEY) throw new Error('SWEBENCH_API_KEY isn\'t set: sb-cli needs it to submit.');
    const runId = flags['run-id'] ?? `hydra-${setup}-${path.basename(dir)}`;
    const submitted = await run('sb-cli', submitArguments(predictions, runId), { cwd: dir, timeoutMs: 60 * 60_000 });
    process.stdout.write(submitted.stdout);
    if (submitted.code !== 0) throw new Error(`sb-cli submit failed (${submitted.code}): ${submitted.stderr.trim().slice(-1500)}`);
    return;
  }
  throw new Error('swebench takes select, prepare, predictions or submit (see docs/Benchmark.md).');
}

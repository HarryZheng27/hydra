#!/usr/bin/env node
// O9 (docs/Benchmark.md): Hydra's public benchmark. Nico runs it: it spends real subscription usage, and the Hydra run
// needs a Hydra window open on its repository (the recording is made there). Nothing here opens a window itself.
//
//   node scripts/benchmark.mjs prepare [--fixture <name>] [--out <dir>]
//   node scripts/benchmark.mjs hydra  --repo <dir>/hydra  [--fixture <name>] [--task <plan>] [--minutes 120] [--usd 80] [--hydra "<command>"] [--plan-store <plans.json>]
//   node scripts/benchmark.mjs single --repo <dir>/single [--fixture <name>] [--task <plan>] [--agent claude|codex] [--minutes 120] [--claude <path>] [--command "<agent command>"] [--prompt <file>] [--gate "<command>"|none]
//   node scripts/benchmark.mjs review --results <dir> [--codex <path>] [--claude <path>] [--base <commit>] [--reviewer-command "<command>"]
//     (exits 1 when the review didn't run, and 3 when a usage limit stopped it)
//   node scripts/benchmark.mjs summarize --runs <folders or globs, comma-separated> [--out <file>] [--plan-store <plans.json>]
//   node scripts/benchmark.mjs publish --results <dir> [--label <text>] [--notes <text>]
//   node scripts/benchmark.mjs swebench select|prepare|predictions|submit … (scripts/benchmark-swebench.mjs)
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultFixture, fixturePath, globSegment, harnessOnlyFiles, landingFromStore, observePlan, parseCheckOutput, pickTask, renderSummary, runRows,
  singleAllowedTools, singleClaudeArgs, singleSettings, summarizeHydra, summarizeReview, summarizeSingle, taskFromPlan, withResults, withReview,
} from './benchmark-lib.mjs';
import { swebench } from './benchmark-swebench.mjs';
import { run } from './benchmark-run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function args(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const name = argv[i].slice(2); const value = argv[i + 1]; if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`); flags[name] = value; i++; }
    else rest.push(argv[i]);
  }
  return { command: rest[0], flags, rest: rest.slice(1) };
}
const commandLine = text => text.match(/"[^"]*"|\S+/g).map(part => part.replace(/^"|"$/g, ''));

async function git(argv, cwd) {
  const result = await run('git', argv, { cwd, shell: false });
  if (result.code !== 0) throw new Error(`git ${argv[0]} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.access(file).then(() => true, () => false);

/**
 * The fixture a command works on: --fixture, else the one `prepare` wrote into the run folder (benchmark.json),
 * else the default (bench/fixture). Its tasks are its plan files.
 */
async function fixtureOf(flags, runFolder) {
  // --fixture none: a repository that isn't a fixture (a SWE-bench instance), whose plan --task names; no hidden check.
  if (flags.fixture === 'none') { if (!flags.task) throw new Error('--fixture none needs --task.'); return { name: undefined, dir: undefined, plans: [flags.task], task: flags.task }; }
  let info = {};
  if (runFolder) { try { info = await readJson(path.join(runFolder, 'benchmark.json')); } catch { /* prepared before benchmark.json */ } }
  const name = flags.fixture ?? info.fixture ?? defaultFixture;
  const dir = path.resolve(fixturePath(root, name));
  let plans;
  try { plans = (await fs.readdir(path.join(dir, '.hydra', 'plans'))).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort(); }
  catch { throw new Error(`There's no fixture ${name} (${dir}).`); }
  return { name, dir, plans, task: pickTask(name, plans, flags.task ?? info.task) };
}

async function prepare(flags) {
  const out = path.resolve(flags.out ?? path.join(root, '.bench', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const fixture = await fixtureOf(flags);
  if (!fixture.dir) throw new Error('prepare needs a fixture (SWE-bench instances are prepared with swebench prepare).');
  for (const name of ['hydra', 'single']) {
    const repo = path.join(out, name);
    await fs.mkdir(repo, { recursive: true });
    if ((await fs.readdir(repo)).length) throw new Error(`${repo} isn't empty.`);
    // The single agent's prompt and the hidden check stay out: only the harness reads them.
    await fs.cp(fixture.dir, repo, { recursive: true, filter: source => !(path.dirname(source) === fixture.dir && harnessOnlyFiles.includes(path.basename(source))) });
    for (const step of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Hydra benchmark'], ['config', 'user.email', 'benchmark@hydra.invalid'], ['add', '-A'], ['commit', '-qm', 'The benchmark fixture']]) await git(step, repo);
  }
  await fs.writeFile(path.join(out, 'benchmark.json'), JSON.stringify({ fixture: fixture.name, task: fixture.task, preparedAt: new Date().toISOString() }, null, 2) + '\n');
  const task = fixture.name === defaultFixture && !flags.task ? '' : ` --task ${fixture.task}`;
  console.log(`Prepared ${out} (fixture ${fixture.name}, task ${fixture.task})\n\nNext:\n  1. Open ${path.join(out, 'hydra')} in Hydra (scripts/bench-open.ps1 -Folder <it>), trust it, and start recording.\n  2. node scripts/benchmark.mjs hydra --repo "${path.join(out, 'hydra')}"${task}\n  3. node scripts/benchmark.mjs single --repo "${path.join(out, 'single')}"${task}\n  4. node scripts/benchmark.mjs review --results "${out}"\n  5. node scripts/benchmark.mjs summarize --runs "${out}"`);
}

/** A fixture's hidden check (check.mjs, never copied into the repositories) run on `repo`; undefined when the fixture has none. */
async function runCheck(fixture, repo) {
  if (!fixture.dir) return undefined;
  const script = path.join(fixture.dir, 'check.mjs');
  if (!await exists(script)) return undefined;
  const started = now();
  const result = await run(process.execPath, [script, repo], { cwd: repo, timeoutMs: 5 * 60_000, shell: false });
  return parseCheckOutput(result.stdout + (result.stderr ? `\n${result.stderr}` : ''), result.timedOut ? null : result.code, Math.round((now() - started) / 1000));
}
/** A folder under `parent` named `name`, or name-2, name-3… when taken. */
async function freshPath(parent, name) {
  for (let index = 1; ; index++) { const candidate = path.join(parent, index === 1 ? name : `${name}-${index}`); if (!await exists(candidate)) return candidate; }
}

/** Hydra's plan stores (plans.json in every workspace of the installed Hydra's storage), or the one --plan-store names. */
async function planStoreFiles(flag) {
  if (flag) return [path.resolve(flag)];
  if (!process.env.APPDATA) return [];
  return (await expandGlob(path.join(process.env.APPDATA, 'Hydra', 'User', 'globalStorage', '*', 'workspaces', '*', 'plans'))).map(dir => path.join(dir, 'plans.json'));
}
/** The plan with this id from Hydra's plan store, or undefined when no store has it. */
async function storedPlan(planId, flag) {
  for (const file of await planStoreFiles(flag)) {
    try { const found = (await readJson(file)).plans?.find(plan => plan.id === planId); if (found) return found; } catch { /* not there, or unreadable */ }
  }
  return undefined;
}

async function hydra(flags) {
  const repo = path.resolve(flags.repo ?? '');
  const out = path.dirname(repo);
  const fixture = await fixtureOf(flags, out);
  const [command, ...prefix] = commandLine(flags.hydra ?? 'hydra');
  const cli = (...argv) => run(command, [...prefix, ...argv], { cwd: repo });
  const status = await cli('status', '--json');
  if (status.code !== 0) throw new Error(`hydra status answered ${status.code}: ${status.stderr.trim() || status.stdout.trim()}\nOpen ${repo} in Hydra (and trust it) first.`);
  const minutes = Number(flags.minutes ?? 120), usd = Number(flags.usd ?? 80), poll = Number(flags.poll ?? 10) * 1000;
  const started = now();
  const created = await cli('plan', 'run', fixture.task, '--unattended', '--minutes', String(minutes), '--usd', String(usd), '--json');
  if (created.code !== 0) throw new Error(`hydra plan run failed (${created.code}): ${created.stderr.trim()}`);
  const planId = JSON.parse(created.stdout).plan_id;
  console.log(`Plan ${planId} started; watching it every ${poll / 1000}s.`);
  let observed, view;
  const deadline = started + (minutes + 30) * 60_000;
  while (now() < deadline) {
    const shown = await cli('plan', 'show', planId, '--json');
    if (shown.code === 0) {
      view = JSON.parse(shown.stdout);
      observed = observePlan(observed, view, (now() - started) / 1000);
      const done = view.jobs.filter(job => job.status === 'done').length;
      process.stdout.write(`\r${Math.round((now() - started) / 1000)}s: ${view.state}, ${done} of ${view.jobs.length} done${view.integration ? `, gate: ${view.integration.gate.label}` : ''}        `);
      if (view.state !== 'running' && view.integration?.settled !== false) break;
    }
    await sleep(poll);
  }
  const wallClockSeconds = Math.round((now() - started) / 1000);
  const waited = await cli('plan', 'wait', planId, '--timeout', '60', '--json');
  const final = JSON.parse(waited.stdout || '{}');
  const report = await cli('report', planId);
  const finalView = final.plan_id ? final : view;
  // Exact landing times from Hydra's own plan store, when it can be read; otherwise as watching saw them.
  const stored = await storedPlan(planId, flags['plan-store']);
  const results = summarizeHydra({
    view: finalView, observed, wallClockSeconds, passed: waited.code === 0, timedOut: final.timed_out, task: fixture.task, fixture: fixture.name,
    startedAt: new Date(started).toISOString(), ...(stored ? { landing: landingFromStore(stored, started) } : {}),
  });
  // The hidden check runs on every job's work together: the integration branch's tip, in a clone beside the repository.
  const tip = finalView?.integration?.tip;
  if (tip && fixture.dir && await exists(path.join(fixture.dir, 'check.mjs'))) {
    const tree = await freshPath(out, 'hydra-final');
    try {
      await git(['clone', '-q', '--no-checkout', repo, tree], out);
      await git(['checkout', '-q', '--detach', tip], tree);
      results.check = { ...await runCheck(fixture, tree), tree: path.basename(tree), tip };
    } catch (error) { results.check = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  await fs.writeFile(path.join(out, 'hydra-results.json'), JSON.stringify(results, null, 2) + '\n');
  await fs.writeFile(path.join(out, 'hydra-report.md'), report.stdout);
  console.log(`\n\n${JSON.stringify(results, null, 2)}\n\nWrote ${path.join(out, 'hydra-results.json')} and hydra-report.md.`);
}

const agents = {
  claude: { command: 'claude' },
  codex: { command: 'codex', args: ['exec', '--json', '-s', 'workspace-write', '-c', "approval_policy='never'", '-'] },
};

/** The single agent's brief: the fixture's prompt.md, else generated from the plan file (taskFromPlan). */
async function briefFor(fixture) {
  const prompt = path.join(fixture.dir, 'prompt.md');
  if (fixture.plans.length === 1 && await exists(prompt)) return fs.readFile(prompt, 'utf8');
  return taskFromPlan(await readJson(path.join(fixture.dir, '.hydra', 'plans', `${fixture.task}.json`)));
}

/**
 * The single Claude Code agent's isolation, like a head's: a settings file turning off every user plugin (the list
 * heads turn off, #260, from Hydra's own code), an empty MCP config with --strict-mcp-config, and the allowed tools.
 * Both files go in the run folder, beside the repository, so the agent never commits them.
 */
async function claudeIsolation(out) {
  const { userClaudePlugins } = await hydraModule();
  const settings = singleSettings(await userClaudePlugins(process.env));
  const settingsFile = path.join(out, 'single-settings.json'), mcpConfigFile = path.join(out, 'single-mcp.json');
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  await fs.writeFile(mcpConfigFile, JSON.stringify({ mcpServers: {} }) + '\n');
  return { args: singleClaudeArgs({ settingsFile, mcpConfigFile }), pluginsOff: Object.keys(settings.enabledPlugins ?? {}).length };
}

async function single(flags) {
  const repo = path.resolve(flags.repo ?? '');
  const out = path.dirname(repo);
  const agent = flags.agent ?? 'claude';
  if (!agents[agent]) throw new Error('--agent is claude or codex.');
  const minutes = Number(flags.minutes ?? 120);
  // --prompt: a brief from elsewhere (a SWE-bench instance's prompt.md) and no fixture, so no check, and no gate unless --gate names one.
  const fixture = flags.prompt ? undefined : await fixtureOf(flags, out);
  const brief = flags.prompt ? await fs.readFile(path.resolve(flags.prompt), 'utf8') : await briefFor(fixture);
  const gateCommand = flags.gate ? (flags.gate === 'none' ? undefined : commandLine(flags.gate)) : fixture ? ['npm', 'test'] : undefined;
  // --command replaces the agent's whole command line, isolation included (a CLI installed elsewhere, or a stand-in in
  // tests); the task still goes to stdin.
  const custom = flags.command ? commandLine(flags.command) : undefined;
  let spec, isolation;
  if (custom) spec = { command: custom[0], args: custom.slice(1) };
  else if (agent === 'claude') {
    // --claude: where Claude Code is (a path, or a command line), when it isn't `claude` on PATH; the isolation still applies.
    const [command, ...prefix] = flags.claude ? commandLine(flags.claude) : [agents.claude.command];
    const isolated = await claudeIsolation(out);
    spec = { command, args: [...prefix, ...isolated.args] };
    isolation = { pluginsOff: isolated.pluginsOff, strictMcp: true, allowedTools: [...singleAllowedTools] };
  }
  else spec = agents[agent];
  console.log(`Running ${agent} alone on ${repo} (up to ${minutes} minutes)…`);
  const started = now();
  const result = await run(spec.command, spec.args, { cwd: repo, input: brief, timeoutMs: minutes * 60_000 });
  const wallClockSeconds = Math.round((now() - started) / 1000);
  // An agent that never ran (not found, not signed in) leaves the fixture untouched, which still passes its own gate:
  // that must never be recorded as a result.
  if (result.code !== 0 && !result.timedOut) throw new Error(`${spec.command} exited with ${result.code} after ${wallClockSeconds}s, so there's no result to record.\n${(result.stderr || result.stdout).trim().slice(-2000)}\nIf the agent isn't on cmd.exe's PATH, pass its full path with --command.`);
  let agentOutput, codexUsage;
  if (agent === 'claude') { try { agentOutput = JSON.parse(result.stdout); } catch { /* not JSON: an error before it started */ } }
  else for (const line of result.stdout.split('\n')) {
    try {
      const message = JSON.parse(line);
      if (message.type === 'turn.completed' && message.usage) codexUsage = { inputTokens: (codexUsage?.inputTokens ?? 0) + (message.usage.input_tokens ?? 0), outputTokens: (codexUsage?.outputTokens ?? 0) + (message.usage.output_tokens ?? 0) };
    } catch { /* not a JSON line */ }
  }
  const gate = gateCommand ? await run(gateCommand[0], gateCommand.slice(1), { cwd: repo, timeoutMs: 10 * 60_000 }) : { code: null, stdout: 'No gate ran.', stderr: '' };
  const results = summarizeSingle({ agent, wallClockSeconds: result.timedOut ? minutes * 60 : wallClockSeconds, exitCode: result.code, gatePassed: gate.code === 0, gateOutput: gate.stdout + gate.stderr, agentOutput, codexUsage, task: fixture?.task, fixture: fixture?.name, startedAt: new Date(started).toISOString() });
  if (result.timedOut) results.timedOut = true;
  if (isolation) results.isolation = isolation;
  const check = fixture ? await runCheck(fixture, repo) : undefined;
  if (check) results.check = check;
  await fs.writeFile(path.join(out, 'single-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`${JSON.stringify(results, null, 2)}\n\nWrote ${path.join(out, 'single-results.json')}.`);
  if (results.agentResult?.isError) console.error(`The agent reported an error (${results.agentResult.subtype ?? 'no subtype'}): the run is recorded, with no time to working code.`);
}

/**
 * Hydra's own code the harness uses (scripts/benchmark-review.ts: the integration gate's review, and the user plugin
 * list heads turn off), bundled from its source with esbuild, a devDependency, into .bench/.build, then loaded.
 */
let hydraBundle;
async function hydraModule() {
  if (hydraBundle) return hydraBundle;
  const { build } = await import('esbuild');
  const outfile = path.join(root, '.bench', '.build', 'benchmark-review.cjs');
  await build({ entryPoints: [path.join(root, 'scripts', 'benchmark-review.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile, external: ['vscode'], logLevel: 'error' });
  return (hydraBundle = createRequire(import.meta.url)(outfile));
}

async function review(flags) {
  const out = path.resolve(flags.results ?? '');
  const resultsFile = path.join(out, 'single-results.json');
  if (!await exists(resultsFile)) throw new Error(`There's no single-results.json in ${out}: run benchmark.mjs single first.`);
  const single = await readJson(resultsFile);
  const repo = path.resolve(flags.repo ?? path.join(out, 'single'));
  const fixture = await fixtureOf({ ...flags, fixture: flags.fixture ?? single.fixture, task: flags.task ?? single.task }, out);
  // The plan gives the reviewer its task, and the gates come from the fixture, as Hydra reads them from the lead
  // folder: never from the repository under review. With --fixture none, both come from the repository.
  const plan = await readJson(path.join(fixture.dir ?? repo, '.hydra', 'plans', `${fixture.task}.json`));
  // The review sees base..HEAD, as a plan's does; work the agent left uncommitted is committed first, and that's recorded.
  let committedLeftovers = false;
  if ((await git(['status', '--porcelain'], repo)).trim()) {
    await git(['add', '-A'], repo);
    await git(['-c', 'user.name=Hydra benchmark', '-c', 'user.email=benchmark@hydra.invalid', 'commit', '-qm', 'The single agent\'s work, left uncommitted'], repo);
    committedLeftovers = true;
  }
  const base = flags.base ?? (await git(['rev-list', '--max-parents=0', 'HEAD'], repo)).trim().split('\n').pop();
  const head = (await git(['rev-parse', 'HEAD'], repo)).trim();
  const { reviewRepository } = await hydraModule();
  const logDirectory = await freshPath(out, 'single-review');
  console.log(`Reviewing ${repo} (${base.slice(0, 12)}..${head.slice(0, 12)}) with the gates a plan's integration gate runs…`);
  const reviewed = await reviewRepository({
    repo, gatesFolder: fixture.dir ?? repo, base, planTitle: plan.title, planBrief: plan.brief, logDirectory,
    paths: { ...(flags.codex ? { codex: path.resolve(flags.codex) } : {}), ...(flags.claude ? { claude: path.resolve(flags.claude) } : {}) },
    ...(flags['reviewer-command'] ? { reviewerCommand: commandLine(flags['reviewer-command']) } : {}),
    log: line => console.log(line),
  });
  const summary = summarizeReview({ ...reviewed, base, head, committedLeftovers, fixture: fixture.name, task: fixture.task });
  await fs.writeFile(path.join(out, 'single-review.json'), JSON.stringify({ ...summary, logs: path.basename(logDirectory) }, null, 2) + '\n');
  await fs.writeFile(resultsFile, JSON.stringify(withReview(single, summary), null, 2) + '\n');
  console.log(`\n${JSON.stringify(summary, null, 2)}\n\nWrote ${path.join(out, 'single-review.json')} and added the review to single-results.json.`);
  // A review that didn't run is recorded as not run, and the command fails so a run of many notices; a usage limit
  // gets its own exit code (3), since it means stopping, not retrying.
  if (!summary.ran) {
    const error = new Error(`${summary.usageLimit ? 'USAGE LIMIT: ' : ''}The review didn't run: ${summary.notRunReason}`);
    error.exitCode = summary.usageLimit ? 3 : 1;
    throw error;
  }
}

/** Folders matching a path with `*` or `?` in any segment (directories only). */
async function expandGlob(pattern) {
  const absolute = path.resolve(pattern);
  if (!/[*?]/.test(absolute)) return [absolute];
  const { root: fsRoot } = path.parse(absolute);
  let current = [fsRoot];
  for (const part of absolute.slice(fsRoot.length).split(/[\\/]+/).filter(Boolean)) {
    if (!/[*?]/.test(part)) { current = current.map(dir => path.join(dir, part)); continue; }
    const match = globSegment(part), next = [];
    for (const dir of current) for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && match.test(entry.name)) next.push(path.join(dir, entry.name));
    current = next;
  }
  return current;
}

async function summarize(flags, rest) {
  const patterns = [...String(flags.runs ?? '').split(','), ...rest].map(item => item.trim()).filter(Boolean);
  if (!patterns.length) throw new Error('--runs needs run folders or globs, comma-separated.');
  const folders = [...new Set((await Promise.all(patterns.map(expandGlob))).flat())].sort();
  const parent = folders.length === 1 ? path.dirname(folders[0]) : folders.reduce((common, folder) => { while (!(folder + path.sep).toLowerCase().startsWith(common.toLowerCase() + path.sep) && common !== path.dirname(common)) common = path.dirname(common); return common; }, folders[0]);
  const rows = [], skipped = [];
  for (const folder of folders) {
    const files = (await fs.readdir(folder).catch(() => [])).filter(name => name.endsWith('-results.json')).sort();
    if (!files.length) { skipped.push(folder); continue; }
    for (const name of files) {
      const result = await readJson(path.join(folder, name));
      const stored = result.kind === 'hydra' && result.timeToWorkingCodeSeconds === undefined && result.planId ? await storedPlan(result.planId, flags['plan-store']) : undefined;
      rows.push(...runRows(result, path.relative(parent, folder) || path.basename(folder), stored ? landingFromStore(stored) : undefined));
    }
  }
  if (!rows.length) throw new Error(`No *-results.json in ${patterns.join(', ')}.`);
  const markdown = `# Benchmark summary\n\n${folders.length - skipped.length} run folder(s) under ${parent}, summarized ${new Date().toISOString()}.${skipped.length ? ` No results in: ${skipped.map(folder => path.relative(parent, folder)).join(', ')}.` : ''}\n\n${renderSummary(rows)}`;
  const file = path.resolve(flags.out ?? path.join(parent, 'summary.md'));
  await fs.writeFile(file, markdown);
  console.log(`${markdown}\nWrote ${file}.`);
}

async function publish(flags) {
  const out = path.resolve(flags.results ?? '');
  const read = async name => { try { return await readJson(path.join(out, name)); } catch { return undefined; } };
  const hydraResults = await read('hydra-results.json'), singleResults = await read('single-results.json');
  if (!hydraResults && !singleResults) throw new Error(`No results in ${out}.`);
  const historyFile = path.join(root, 'bench', 'results.json');
  const history = await readJson(historyFile);
  history.runs.push({ at: new Date().toISOString(), ...(flags.label ? { label: flags.label } : {}), ...(flags.notes ? { notes: flags.notes } : {}), ...(hydraResults ? { hydra: hydraResults } : {}), ...(singleResults ? { single: singleResults } : {}) });
  await fs.writeFile(historyFile, JSON.stringify(history, null, 2) + '\n');
  const docFile = path.join(root, 'docs', 'Benchmark.md');
  await fs.writeFile(docFile, withResults(await fs.readFile(docFile, 'utf8'), history.runs));
  console.log(`Added the run to bench/results.json and docs/Benchmark.md. Review and commit them.`);
}

const { command, flags, rest } = args(process.argv.slice(2));
const commands = { prepare, hydra, single, review, summarize, publish, swebench: (options, extra) => swebench(options, extra, { root, run, git }) };
if (!commands[command]) { console.error('Usage: node scripts/benchmark.mjs prepare|hydra|single|review|summarize|publish|swebench [options] (see docs/Benchmark.md)'); process.exitCode = 2; }
else commands[command](flags, rest).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = error?.exitCode ?? 1; });

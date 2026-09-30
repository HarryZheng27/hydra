#!/usr/bin/env node
// O9 (docs/Benchmark.md): Hydra's public benchmark. Nico runs it: it spends real subscription usage, and the Hydra run
// needs a Hydra window open on its repository (the recording is made there). Nothing here opens a window itself.
//
//   node scripts/benchmark.mjs prepare [--fixture <name>] [--out <dir>] [--replace-void]
//     (single, hydra, review and swebench exit 4 when the machine slept during the run: it is marked void, run it again)
//   node scripts/benchmark.mjs hydra  --repo <dir>/hydra  [--fixture <name>] [--task <plan>] [--minutes 120] [--usd 80] [--hydra "<command>"] [--plan-store <plans.json>]
//   node scripts/benchmark.mjs single --repo <dir>/single [--fixture <name>] [--task <plan>] [--agent claude|codex] [--minutes 120] [--claude <path>] [--command "<agent command>"] [--prompt <file>] [--gate "<command>"|none]
//   node scripts/benchmark.mjs review --results <dir> [--fix-rounds 2] [--codex <path>] [--claude <path>] [--base <commit>] [--reviewer-command "<command>"] [--fix-command "<agent command>"]
//     (a failed review resumes the single agent with the findings, up to --fix-rounds times, and reviews again, as Hydra's integration gate does)
//     (exits 1 when the review didn't run, and 3 when a usage limit stopped it)
//   node scripts/benchmark.mjs summarize --runs <folders or globs, comma-separated> [--out <file>] [--plan-store <plans.json>]
//   node scripts/benchmark.mjs publish --results <dir> [--label <text>] [--notes <text>]
//   node scripts/benchmark.mjs swebench --n 30 --seed 1 --setup single|hydra [--out <dir>] … (scripts/benchmark-swebench.mjs)
//   node scripts/benchmark.mjs swebench-submit --out <dir> [--run-id <id>] [--wait <minutes>]
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultFixRounds, defaultFixture, defaultPollSeconds, defaultUsd, fixturePath, globSegment, harnessOnlyFiles, landingFromStore, observePlan, parseCheckOutput, pickTask, planSignature, pollDelayMs,
  renderSummary, resolveTool, runRows, singleAllowedTools, singleClaudeArgs, singleFixBrief, singleSettings, summarizeHydra, summarizeReview, summarizeSingle, taskFromPlan, withResults, withReviewLoop,
} from './benchmark-lib.mjs';
import { renderSwebenchSummary, swebench, swebenchSubmit } from './benchmark-swebench.mjs';
import { run } from './benchmark-run.mjs';
import { guardSuspend, renderVoidRuns, replaceVoidFolder } from './benchmark-suspend.mjs';
import { closeCli, closeLeftovers, closeOwnWindow, markerFile, readMarker, readWindowRecords } from './benchmark-windows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const booleanFlags = new Set(['--replace-void']);
function args(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (booleanFlags.has(argv[i])) flags[argv[i].slice(2)] = 'yes';
    else if (argv[i].startsWith('--')) { const name = argv[i].slice(2); const value = argv[i + 1]; if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`); flags[name] = value; i++; }
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
 * Where a tool (claude, hydra, codex) is: the flag, else on PATH, else its usual install location (resolveTool), and
 * which of those it was is logged, so a run says what it used.
 */
function toolFor(name, flag) {
  const tool = resolveTool(name, { flag, exists: existsSync });
  console.log(`Using ${name}: ${tool.command} (${tool.source})`);
  return tool;
}

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
  // --replace-void: a run whose results say void (the machine slept) moves aside, and this one is prepared fresh.
  if (flags['replace-void']) { const aside = await replaceVoidFolder(out); if (aside) console.log(`Moved the void run ${out} to ${aside}.`); }
  if (!fixture.dir) throw new Error('prepare needs a fixture (SWE-bench instances are run with benchmark.mjs swebench).');
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
  // --hydra is a command line; a found tool is one command (its path may hold spaces).
  const hydraTool = toolFor('hydra', flags.hydra);
  const [command, ...prefix] = flags.hydra ? commandLine(flags.hydra) : [hydraTool.command];
  const cliIn = (cwd, ...argv) => run(command, [...prefix, ...argv], { cwd, timeoutMs: 5 * 60_000 });
  const cli = (...argv) => run(command, [...prefix, ...argv], { cwd: repo });
  const windows = await windowDeps(flags.hydra ? undefined : hydraTool, cliIn);
  const status = await cli('status', '--json');
  if (status.code !== 0) throw new Error(`hydra status answered ${status.code}: ${status.stderr.trim() || status.stdout.trim()}\nOpen ${repo} in Hydra (and trust it) first.`);
  // Leftover benchmark windows from earlier runs: closed when the harness opened them, else named loudly.
  await closeLeftovers(repo, windows);
  // This run's own window is closed once its results are written (or the run failed), if the harness opened it.
  try { return await hydraRun({ flags, repo, out, fixture, cli }); }
  finally { await closeOwnWindow(repo, windows).catch(error => console.error(`WARNING: closing the Hydra window for ${repo} failed: ${error instanceof Error ? error.message : String(error)}`)); }
}

/** What closing the harness's windows needs (scripts/benchmark-windows.mjs), wired to this machine. */
async function windowDeps(tool, cliIn) {
  // A launcher built before `hydra close` would open a window on a folder named "close": check it lists the command.
  const file = tool?.path ?? (tool && !tool.missing && path.isAbsolute(tool.command) ? tool.command : undefined);
  const text = file ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined;
  // With an old launcher, Hydra.exe runs the installed hydra-cli.cjs directly, as the launcher would, if it has close.
  const { cli, canClose, via } = await closeCli({ launcherFile: file, launcherText: text, cliIn, run, exists: existsSync, log: line => console.log(line) });
  return {
    cli, readMarker, records: () => readWindowRecords(process.env), canClose, via,
    removeMarker: folder => fs.rm(markerFile(folder), { force: true }), log: line => console.log(line), warn: line => console.error(line),
  };
}

async function hydraRun({ flags, repo, out, fixture, cli }) {
  const minutes = Number(flags.minutes ?? 120), usd = Number(flags.usd ?? defaultUsd), poll = Number(flags.poll ?? defaultPollSeconds) * 1000;
  // Every plan show makes Hydra check its process table (2 to 6 seconds of PowerShell on Windows): 10 seconds is the floor for a real run.
  if (poll < defaultPollSeconds * 1000) console.log(`Polling every ${poll / 1000}s: under ${defaultPollSeconds}s makes Hydra check its process table on every look, which slows it.`);
  const started = now();
  const created = await cli('plan', 'run', fixture.task, '--unattended', '--minutes', String(minutes), '--usd', String(usd), '--json');
  if (created.code !== 0) throw new Error(`hydra plan run failed (${created.code}): ${created.stderr.trim()}`);
  const planId = JSON.parse(created.stdout).plan_id;
  console.log(`Plan ${planId} started; watching it every ${poll / 1000}s, less often while nothing changes.`);
  let observed, view, lastSignature, steady = 0;
  const deadline = started + (minutes + 30) * 60_000;
  while (now() < deadline) {
    const shown = await cli('plan', 'show', planId, '--json');
    if (shown.code === 0) {
      view = JSON.parse(shown.stdout);
      observed = observePlan(observed, view, (now() - started) / 1000);
      const done = view.jobs.filter(job => job.status === 'done').length;
      process.stdout.write(`\r${Math.round((now() - started) / 1000)}s: ${view.state}, ${done} of ${view.jobs.length} done${view.integration ? `, gate: ${view.integration.gate.label}` : ''}        `);
      if (view.state !== 'running' && view.integration?.settled !== false) break;
      const signature = planSignature(view);
      steady = signature === lastSignature ? steady + 1 : 0;
      lastSignature = signature;
    }
    await sleep(pollDelayMs(poll, steady));
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
    startedAt: new Date(started).toISOString(), ...(stored ? { landing: landingFromStore(stored, started), storedPlan: stored } : {}),
  });
  // The hidden check runs on every job's work together: the integration branch's tip, in a clone beside the repository.
  const tip = finalView?.integration?.tip;
  // The combined work's commit and branch: a SWE-bench run diffs its model patch from here.
  if (tip) results.integrationTip = tip;
  if (finalView?.integration?.branch) results.integrationBranch = finalView.integration.branch;
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
  return results;
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
    const claudeTool = toolFor('claude', flags.claude);
    const [command, ...prefix] = flags.claude ? commandLine(flags.claude) : [claudeTool.command];
    const isolated = await claudeIsolation(out);
    spec = { command, args: [...prefix, ...isolated.args] };
    isolation = { pluginsOff: isolated.pluginsOff, strictMcp: true, allowedTools: [...singleAllowedTools] };
  }
  else { const codexTool = toolFor('codex', undefined); spec = { ...agents[agent], command: codexTool.command }; }
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
  return results;
}

/** Opens a SWE-bench instance's repository in Hydra the way every benchmark folder is opened: scripts/bench-open.ps1. */
async function openHydra(repo) {
  if (process.platform !== 'win32') throw new Error('Opening a Hydra window uses scripts/bench-open.ps1 (Windows). Elsewhere, open the folder in Hydra yourself and pass --open none.');
  const opened = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'bench-open.ps1'), '-Folder', repo, '-WaitSeconds', '180'], { cwd: root, timeoutMs: 5 * 60_000, shell: false });
  if (opened.code !== 0) throw new Error(`bench-open.ps1 couldn't open ${repo} in Hydra (${opened.code}): ${(opened.stderr || opened.stdout).trim().slice(-1000)}`);
}

/**
 * Hydra's own code the harness uses (scripts/benchmark-review.ts: the integration gate's review, and the user plugin
 * list heads turn off), bundled from its source with esbuild, a devDependency, into .bench/.build, then loaded.
 */
let hydraBundle;
async function hydraModule() {
  if (hydraBundle) return hydraBundle;
  const { build } = await import('esbuild');
  // One file per process: two harness processes at once (the tests run several) would otherwise load each other's
  // half-written bundle ("reviewRepository is not a function"). Removed again once loaded.
  const outfile = path.join(root, '.bench', '.build', `benchmark-review-${process.pid}-${Date.now().toString(36)}.cjs`);
  await build({ entryPoints: [path.join(root, 'scripts', 'benchmark-review.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile, external: ['vscode'], logLevel: 'error' });
  try { return (hydraBundle = createRequire(import.meta.url)(outfile)); }
  finally { await fs.rm(outfile, { force: true }).catch(() => undefined); }
}

/**
 * The reviewer's CLI paths (like hydra.claudePath and hydra.codexPath): the flag, else the tool's usual install
 * location when it isn't on PATH (Hydra's own lookup is PATH only); a tool on PATH is left for Hydra to find.
 */
function reviewerPaths(flags) {
  const paths = {};
  for (const name of ['codex', 'claude']) {
    if (flags[name]) { paths[name] = path.resolve(flags[name]); continue; }
    const tool = resolveTool(name, { exists: existsSync });
    if (!tool.onPath && !tool.missing) { paths[name] = tool.command; console.log(`Using ${name}: ${tool.command} (${tool.source})`); }
  }
  return paths;
}

/** The gate the single agent's run is judged by: npm test for a fixture (--gate to change it, "none" for no gate), else none. */
function gateCommandOf(flags, fixture) {
  return flags.gate ? (flags.gate === 'none' ? undefined : commandLine(flags.gate)) : fixture?.dir ? ['npm', 'test'] : undefined;
}

/**
 * Resumes the single agent with a review's findings (the fix brief, formatted like Hydra's): Claude Code with the same
 * isolation as its first run and --resume <session>; --fix-command replaces the whole command line (a stand-in in
 * tests, or another agent). Resolves with what the run cost, and undefined with the reason when it can't resume.
 */
async function fixWithAgent({ flags, single, out, repo, brief }) {
  let spec;
  if (flags['fix-command']) { const custom = commandLine(flags['fix-command']); spec = { command: custom[0], args: custom.slice(1) }; }
  else if ((single.agent ?? 'claude') !== 'claude') return { skipped: 'a fix round resumes Claude Code; for another agent pass --fix-command' };
  else if (!single.sessionId) return { skipped: 'single-results.json has no session id (from before it was kept), so the agent can\'t be resumed; pass --fix-command, or --fix-rounds 0' };
  else {
    const settingsFile = path.join(out, 'single-settings.json'), mcpConfigFile = path.join(out, 'single-mcp.json');
    if (!await exists(settingsFile) || !await exists(mcpConfigFile)) return { skipped: 'the run\'s isolation files (single-settings.json, single-mcp.json) are gone, so the agent can\'t be resumed the way it ran; pass --fix-command' };
    const claudeTool = toolFor('claude', flags.claude);
    // In review, --claude is a path (the reviewer's lookup); a command line (a stand-in) also works here.
    const [command, ...prefix] = flags.claude ? (existsSync(flags.claude) ? [path.resolve(flags.claude)] : commandLine(flags.claude)) : [claudeTool.command];
    spec = { command, args: [...prefix, ...singleClaudeArgs({ settingsFile, mcpConfigFile, resume: single.sessionId })] };
  }
  const started = now();
  const minutes = Number(flags.minutes ?? 60);
  const result = await run(spec.command, spec.args, { cwd: repo, input: brief, timeoutMs: minutes * 60_000 });
  const seconds = Math.round((now() - started) / 1000);
  let output;
  try { output = JSON.parse(result.stdout); } catch { /* not JSON */ }
  const failed = (result.code !== 0 && !result.timedOut) || output?.is_error === true;
  return {
    fix: { seconds: result.timedOut ? minutes * 60 : seconds, exitCode: result.code, ...(typeof output?.total_cost_usd === 'number' ? { usd: output.total_cost_usd } : {}) },
    ...(failed ? { failed: (output?.result ? String(output.result) : (result.stderr || result.stdout).trim()).slice(-500) || ('exited with ' + result.code) } : {}),
  };
}

async function review(flags) {
  const out = path.resolve(flags.results ?? '');
  const resultsFile = path.join(out, 'single-results.json');
  if (!await exists(resultsFile)) throw new Error(`There's no single-results.json in ${out}: run benchmark.mjs single first.`);
  const single = await readJson(resultsFile);
  const repo = path.resolve(flags.repo ?? path.join(out, 'single'));
  const fixture = await fixtureOf({ ...flags, fixture: flags.fixture ?? single.fixture, task: flags.task ?? single.task }, out);
  // Hydra's integration gate has up to hydra.plans.integrationFixRounds (2) automatic fix rounds before its final review; the single agent gets as many.
  const allowed = flags['fix-rounds'] === undefined ? defaultFixRounds : Number(flags['fix-rounds']);
  if (!Number.isInteger(allowed) || allowed < 0) throw new Error('--fix-rounds is a whole number, 0 or more.');
  // The plan gives the reviewer its task, and the gates come from the fixture, as Hydra reads them from the lead
  // folder: never from the repository under review. With --fixture none, both come from the repository.
  const plan = await readJson(path.join(fixture.dir ?? repo, '.hydra', 'plans', `${fixture.task}.json`));
  const { reviewRepository } = await hydraModule();
  let committedLeftovers = false;
  // The review sees base..HEAD, as a plan's does; work the agent left uncommitted is committed first, and that's recorded.
  const commitLeftovers = async message => {
    if (!(await git(['status', '--porcelain'], repo)).trim()) return;
    await git(['add', '-A'], repo);
    await git(['-c', 'user.name=Hydra benchmark', '-c', 'user.email=benchmark@hydra.invalid', 'commit', '-qm', message], repo);
    committedLeftovers = true;
  };
  await commitLeftovers('The single agent\'s work, left uncommitted');
  const base = flags.base ?? (await git(['rev-list', '--max-parents=0', 'HEAD'], repo)).trim().split('\n').pop();
  // One review: the gates a plan's integration gate runs, on base..HEAD. Its summary, the checks it ran (for the fix brief) and where its logs are.
  const reviewOnce = async () => {
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim();
    const logDirectory = await freshPath(out, 'single-review');
    console.log(`Reviewing ${repo} (${base.slice(0, 12)}..${head.slice(0, 12)}) with the gates a plan's integration gate runs…`);
    const reviewed = await reviewRepository({
      repo, gatesFolder: fixture.dir ?? repo, base, planTitle: plan.title, planBrief: plan.brief, logDirectory,
      paths: reviewerPaths(flags),
      ...(flags['reviewer-command'] ? { reviewerCommand: commandLine(flags['reviewer-command']) } : {}),
      log: line => console.log(line),
    });
    return { summary: summarizeReview({ ...reviewed, base, head, committedLeftovers, fixture: fixture.name, task: fixture.task }), checks: reviewed.checks, logs: path.basename(logDirectory) };
  };

  // The loop: review; while it failed and fix rounds are left, resume the agent with the findings and review again.
  const rounds = [];
  let skipped, after, current = await reviewOnce();
  rounds.push({ review: current.summary, logs: current.logs });
  while (current.summary.verdict === 'fail' && rounds.filter(round => round.fix).length < allowed) {
    const brief = singleFixBrief(plan.title, current.checks);
    if (!brief) break;
    const number = rounds.length;
    console.log(`The review failed: fix round ${number} of ${allowed}, resuming the agent with the findings…`);
    const fixed = await fixWithAgent({ flags, single, out, repo, brief });
    if (fixed.skipped) { skipped = fixed.skipped; console.log(`No fix round: ${skipped}`); break; }
    rounds[rounds.length - 1].fix = fixed.fix;
    if (fixed.failed) { skipped = `fix round ${number}: the agent failed: ${fixed.failed}`; console.log(skipped); break; }
    await commitLeftovers(`The single agent's fix round ${number}`);
    current = await reviewOnce();
    rounds.push({ review: current.summary, logs: current.logs });
  }
  // After a fix, the fixed repository's own gate and the hidden check say whether it still works.
  if (rounds.some(round => round.fix)) {
    const gateCommand = gateCommandOf(flags, fixture);
    const gate = gateCommand ? await run(gateCommand[0], gateCommand.slice(1), { cwd: repo, timeoutMs: 10 * 60_000 }) : undefined;
    const check = fixture.dir ? await runCheck(fixture, repo) : undefined;
    after = { gatePassed: gate ? gate.code === 0 : true, ...(check ? { checkPassed: !!check.passed, check } : {}) };
  }
  const summary = current.summary;
  const fixRounds = rounds.filter(round => round.fix).length;
  await fs.writeFile(path.join(out, 'single-review.json'), JSON.stringify({
    ...summary, logs: current.logs, fixRoundsAllowed: allowed, fixRounds, ...(skipped ? { fixSkipped: skipped } : {}), ...(after ? { afterFix: after } : {}),
    rounds: rounds.map(round => ({ review: round.review, logs: round.logs, ...(round.fix ? { fix: round.fix } : {}) })),
  }, null, 2) + '\n');
  await fs.writeFile(resultsFile, JSON.stringify(withReviewLoop(single, { rounds: rounds.map(({ review, fix }) => ({ review, fix })), allowed, skipped, after }), null, 2) + '\n');
  console.log(`\n${JSON.stringify(summary, null, 2)}\n\nWrote ${path.join(out, 'single-review.json')} and added the review (first pass, ${fixRounds} fix round(s), final) to single-results.json.`);
  // A review that didn't run is recorded as not run, and the command fails so a run of many notices; a usage
  // limit gets its own exit code (3), since it means stopping, not retrying.
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
  const rows = [], skipped = [], swebenchRows = [], voids = [];
  for (const folder of folders) {
    const entries = await fs.readdir(folder).catch(() => []);
    // A SWE-bench slice's folder: its resolved rate, once swebench-submit has written resolved.json.
    if (entries.includes('resolved.json')) {
      try { const resolved = await readJson(path.join(folder, 'resolved.json')); swebenchRows.push({ ...resolved, folder: path.relative(parent, folder) || path.basename(folder) }); } catch { /* unreadable */ }
    }
    const files = entries.filter(name => name.endsWith('-results.json')).sort();
    if (!files.length) { if (!entries.includes('resolved.json')) skipped.push(folder); continue; }
    for (const name of files) {
      const result = await readJson(path.join(folder, name));
      // A run the machine slept through is listed on its own, never in a median.
      if (result.void) { voids.push({ folder: path.relative(parent, folder) || path.basename(folder), task: result.task ?? result.fixture ?? '–', setup: result.kind === 'hydra' ? 'hydra' : 'single', suspended: result.suspended }); continue; }
      const stored = result.kind === 'hydra' && (result.timeToWorkingCodeSeconds === undefined || !result.wallClockFrom || result.wallClockFrom === 'polling' || (result.firstReview === undefined && result.fixRounds > 0)) && result.planId ? await storedPlan(result.planId, flags['plan-store']) : undefined;
      rows.push(...runRows(result, path.relative(parent, folder) || path.basename(folder), stored ? { ...landingFromStore(stored, Date.parse(result.startedAt) || undefined), fixBrief: stored.jobs?.find(job => job.key === 'integration-fix-1')?.brief } : undefined));
    }
  }
  if (!rows.length && !swebenchRows.length && !voids.length) throw new Error(`No *-results.json or resolved.json in ${patterns.join(', ')}.`);
  const sections = [rows.length ? renderSummary(rows) : '', renderSwebenchSummary(swebenchRows), renderVoidRuns(voids)].filter(Boolean).join('\n');
  const markdown = `# Benchmark summary\n\n${folders.length - skipped.length} run folder(s) under ${parent}, summarized ${new Date().toISOString()}.${skipped.length ? ` No results in: ${skipped.map(folder => path.relative(parent, folder)).join(', ')}.` : ''}\n\n${sections}`;
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
// Every command that runs an agent or waits on Hydra is watched for a machine sleep (benchmark-suspend.mjs): a run
// that slept is marked void in its results and the command exits 4.
const resultsOf = (flags, ...names) => () => { const dir = path.resolve(flags.results ?? path.dirname(path.resolve(flags.repo ?? ''))); return names.map(name => path.join(dir, name)); };
const guardedSingle = flags => guardSuspend(() => single(flags), { files: resultsOf(flags, 'single-results.json') });
const guardedHydra = flags => guardSuspend(() => hydra(flags), { files: resultsOf(flags, 'hydra-results.json') });
const commands = {
  prepare, summarize, publish,
  hydra: guardedHydra, single: guardedSingle,
  review: flags => guardSuspend(() => review(flags), { files: resultsOf(flags, 'single-results.json', 'single-review.json') }),
  swebench: (options, extra) => swebench(options, extra, { root, run, git, runSingle: guardedSingle, runHydra: guardedHydra, openHydra }),
  'swebench-submit': (options, extra) => swebenchSubmit(options, extra, { run }),
};
if (!commands[command]) { console.error('Usage: node scripts/benchmark.mjs prepare|hydra|single|review|summarize|publish|swebench|swebench-submit [options] (see docs/Benchmark.md)'); process.exitCode = 2; }
else commands[command](flags, rest).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = error?.exitCode ?? 1; });

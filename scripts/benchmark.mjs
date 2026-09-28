#!/usr/bin/env node
// O9 (docs/Benchmark.md): Hydra's public benchmark. Nico runs it: it spends real subscription usage, and the Hydra run
// needs a Hydra window open on its repository (the recording is made there). Nothing here opens a window itself.
//
//   node scripts/benchmark.mjs prepare [--out <dir>]
//   node scripts/benchmark.mjs hydra  --repo <dir>/hydra  [--task discounts|shop-features] [--minutes 120] [--usd 60] [--hydra "<command>"]
//   node scripts/benchmark.mjs single --repo <dir>/single [--task discounts|shop-features] [--agent claude|codex] [--minutes 120] [--command "<agent command>"]
//   node scripts/benchmark.mjs publish --results <dir> [--label <text>] [--notes <text>]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observePlan, summarizeHydra, summarizeSingle, taskFromPlan, tasks, withResults } from './benchmark-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'bench', 'fixture');
/** --task: which plan file (bench/fixture/.hydra/plans/<task>.json); discounts, the first published, by default. */
const taskOf = flags => { const task = flags.task ?? 'discounts'; if (!tasks.includes(task)) throw new Error(`--task is one of ${tasks.join(', ')}.`); return task; };

function args(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const name = argv[i].slice(2); const value = argv[i + 1]; if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`); flags[name] = value; i++; }
    else rest.push(argv[i]);
  }
  return { command: rest[0], flags };
}
const quote = value => /[\s()"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;

/** Runs a command without a window, optionally feeding stdin; resolves with its exit code and output. */
function run(command, argv, { cwd, input, timeoutMs, shell = process.platform === 'win32' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell ? [command, ...argv].map(quote).join(' ') : command, shell ? [] : argv, { cwd, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : undefined;
    child.on('error', reject);
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    // A command that exits without reading its input (git, say) closes the pipe first: that's not an error here.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input ?? '');
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();

async function prepare(flags) {
  const out = path.resolve(flags.out ?? path.join(root, '.bench', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  for (const name of ['hydra', 'single']) {
    const repo = path.join(out, name);
    await fs.mkdir(repo, { recursive: true });
    if ((await fs.readdir(repo)).length) throw new Error(`${repo} isn't empty.`);
    await fs.cp(fixture, repo, { recursive: true });
    for (const step of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Hydra benchmark'], ['config', 'user.email', 'benchmark@hydra.invalid'], ['add', '-A'], ['commit', '-qm', 'The benchmark fixture']]) {
      const result = await run('git', step, { cwd: repo, shell: false });
      if (result.code !== 0) throw new Error(`git ${step[0]} failed in ${repo}: ${result.stderr}`);
    }
  }
  console.log(`Prepared ${out}\n\nNext:\n  1. Open ${path.join(out, 'hydra')} in Hydra, trust it, and start recording.\n  2. node scripts/benchmark.mjs hydra --repo "${path.join(out, 'hydra')}"\n  3. node scripts/benchmark.mjs single --repo "${path.join(out, 'single')}"\n  4. node scripts/benchmark.mjs publish --results "${out}"`);
}

async function hydra(flags) {
  const repo = path.resolve(flags.repo ?? '');
  const [command, ...prefix] = (flags.hydra ?? 'hydra').match(/"[^"]*"|\S+/g).map(part => part.replace(/^"|"$/g, ''));
  const cli = (...argv) => run(command, [...prefix, ...argv], { cwd: repo });
  const status = await cli('status', '--json');
  if (status.code !== 0) throw new Error(`hydra status answered ${status.code}: ${status.stderr.trim() || status.stdout.trim()}\nOpen ${repo} in Hydra (and trust it) first.`);
  const minutes = Number(flags.minutes ?? 120), usd = Number(flags.usd ?? 60), poll = Number(flags.poll ?? 10) * 1000;
  const started = now();
  const task = taskOf(flags);
  const created = await cli('plan', 'run', task, '--unattended', '--minutes', String(minutes), '--usd', String(usd), '--json');
  if (created.code !== 0) throw new Error(`hydra plan run failed (${created.code}): ${created.stderr.trim()}`);
  const planId = JSON.parse(created.stdout).plan_id;
  console.log(`Plan ${planId} started; watching it every ${poll / 1000}s.`);
  let observed, view;
  const deadline = started + (minutes + 30) * 60_000;
  while (now() < deadline) {
    const shown = await cli('plan', 'show', planId, '--json');
    if (shown.code === 0) {
      view = JSON.parse(shown.stdout);
      observed = observePlan(observed, view);
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
  const results = summarizeHydra({ view: final.plan_id ? final : view, observed, wallClockSeconds, passed: waited.code === 0, timedOut: final.timed_out, task });
  const out = path.dirname(repo);
  await fs.writeFile(path.join(out, 'hydra-results.json'), JSON.stringify(results, null, 2) + '\n');
  await fs.writeFile(path.join(out, 'hydra-report.md'), report.stdout);
  console.log(`\n\n${JSON.stringify(results, null, 2)}\n\nWrote ${path.join(out, 'hydra-results.json')} and hydra-report.md.`);
}

const agents = {
  claude: { command: 'claude', args: ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm test)', 'Bash(node --test)'] },
  codex: { command: 'codex', args: ['exec', '--json', '-s', 'workspace-write', '-c', "approval_policy='never'", '-'] },
};

async function single(flags) {
  const repo = path.resolve(flags.repo ?? '');
  const agent = flags.agent ?? 'claude';
  if (!agents[agent]) throw new Error('--agent is claude or codex.');
  const minutes = Number(flags.minutes ?? 120);
  const task = taskOf(flags);
  const brief = taskFromPlan(JSON.parse(await fs.readFile(path.join(fixture, '.hydra', 'plans', `${task}.json`), 'utf8')));
  console.log(`Running ${agent} alone on ${repo} (up to ${minutes} minutes)…`);
  const started = now();
  // --command replaces the agent's command line (a CLI installed elsewhere, or a stand-in in tests); the task still goes to stdin.
  const custom = flags.command?.match(/"[^"]*"|\S+/g).map(part => part.replace(/^"|"$/g, ''));
  const spec = custom ? { command: custom[0], args: custom.slice(1) } : agents[agent];
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
  const gate = await run('npm', ['test'], { cwd: repo, timeoutMs: 10 * 60_000 });
  const results = summarizeSingle({ agent, wallClockSeconds: result.timedOut ? minutes * 60 : wallClockSeconds, exitCode: result.code, gatePassed: gate.code === 0, gateOutput: gate.stdout + gate.stderr, agentOutput, codexUsage, task });
  const out = path.dirname(repo);
  await fs.writeFile(path.join(out, 'single-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`${JSON.stringify(results, null, 2)}\n\nWrote ${path.join(out, 'single-results.json')}.`);
}

async function publish(flags) {
  const out = path.resolve(flags.results ?? '');
  const read = async name => { try { return JSON.parse(await fs.readFile(path.join(out, name), 'utf8')); } catch { return undefined; } };
  const hydraResults = await read('hydra-results.json'), singleResults = await read('single-results.json');
  if (!hydraResults && !singleResults) throw new Error(`No results in ${out}.`);
  const historyFile = path.join(root, 'bench', 'results.json');
  const history = JSON.parse(await fs.readFile(historyFile, 'utf8'));
  history.runs.push({ at: new Date().toISOString(), ...(flags.label ? { label: flags.label } : {}), ...(flags.notes ? { notes: flags.notes } : {}), ...(hydraResults ? { hydra: hydraResults } : {}), ...(singleResults ? { single: singleResults } : {}) });
  await fs.writeFile(historyFile, JSON.stringify(history, null, 2) + '\n');
  const docFile = path.join(root, 'docs', 'Benchmark.md');
  await fs.writeFile(docFile, withResults(await fs.readFile(docFile, 'utf8'), history.runs));
  console.log(`Added the run to bench/results.json and docs/Benchmark.md. Review and commit them.`);
}

const { command, flags } = args(process.argv.slice(2));
const commands = { prepare, hydra, single, publish };
if (!commands[command]) { console.error('Usage: node scripts/benchmark.mjs prepare|hydra|single|publish [options] (see docs/Benchmark.md)'); process.exitCode = 2; }
else commands[command](flags).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

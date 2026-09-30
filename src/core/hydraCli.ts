import path from 'node:path';
import { planFromLeadInput, planIdPattern, type PlanCreateInput } from './plans';
import type { HelperCallResponse } from './helperEndpoint';
import { leadTools } from './helperTools';
import type { HandshakeResult } from './userHandshake';

/**
 * O8b: the `hydra` command (docs/Heads.md, "Scripts and CI"). It acts as you against the Hydra window that owns the
 * current folder, through that window's handshake file and its `user` token (O8a), so everything it can do is the
 * user role's tool list and nothing more. Scripts get `--json` and fixed exit codes.
 *
 * Everything outside this file is passed in (CliDeps), so tests drive it against a real endpoint and a real
 * handshake file, and the entry point (src/hydraCli.ts) only wires Node in.
 */
export const exitCodes = { ok: 0, refused: 1, usage: 2, noHydra: 3 } as const;
export type ExitCode = typeof exitCodes[keyof typeof exitCodes];

/** The extension's id, whose global storage holds `helpers/` (discovery records and handshakes). */
export const extensionStorageId = 'nico-dunlap.hydra-agent-manager';
/** How long `hydra plan wait` waits by default, and at most. */
export const defaultWaitSeconds = 6 * 60 * 60;
export const maxWaitSeconds = 7 * 24 * 60 * 60;

export interface CliDeps {
  cwd: string;
  /** Hydra's helpers folders to look in, most specific first (helpersRootCandidates). */
  helpersRoots: readonly string[];
  findHandshake(helpersRoot: string, cwd: string): Promise<HandshakeResult>;
  call(port: number, token: string, tool: string, args: unknown): Promise<HelperCallResponse>;
  readFile(file: string): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
  randomKey(): string;
  version: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** How often `plan wait` asks again while a job needs attention (hydra_plan_wait returns at once then). */
  pollMs?: number;
}

/**
 * Where Hydra's windows keep their helpers folder: `HYDRA_HELPERS_DIR` alone when it is set; else a portable
 * install's own data folder (when `appDir` has one), then the Hydra app's, then VS Code's user data.
 */
export function helpersRootCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, appDir?: string, portable = false): string[] {
  if (env.HYDRA_HELPERS_DIR) return [env.HYDRA_HELPERS_DIR];
  const storage = (userData: string) => path.join(userData, 'User', 'globalStorage', extensionStorageId, 'helpers');
  const roots: string[] = [];
  if (appDir && portable) roots.push(storage(path.join(appDir, 'data', 'user-data')));
  const base = platform === 'win32' ? env.APPDATA : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  if (base) for (const name of ['Hydra', 'Code', 'Code - Insiders']) roots.push(storage(path.join(base, name)));
  return roots;
}

const usage = `Usage: hydra <command> [options]

Drives the Hydra window that owns the current folder, as you.

Commands:
  status                              The window, and how many heads and lanes it has.
  heads                               This window's heads.
  plan run <file|id> [--unattended]   Run a plan file (.hydra/plans/*.json), or a waiting plan by id.
      --usd <n> --minutes <n> --max-jobs <n>   An unattended plan's budget (else the file's "budget").
      --key <text>                    Its idempotency key (else the file's, else a new one each run).
  plan show <id>                      A plan's jobs, board and integration gate.
  plan wait <id> [--timeout <s>]      Wait for a plan to finish; exits 0 only if its integration gate passed.
  plan cancel <id> [--reason <text>]  Stop a plan's unfinished jobs.
  stop [--reason <text>]              Stop All Agents.
  resume                              Resume Agents.
  close [--force] [--reason <text>]   Close the window. Refused while heads, lanes or plans are still working,
                                      unless --force.
  report <id>                         A plan's report, as Markdown.

Options: --json (raw results), --help, --version.
Exit codes: 0 ok, 1 Hydra refused (or a waited plan didn't pass), 2 usage, 3 no Hydra window owns this folder.`;

class CliError extends Error { constructor(readonly code: ExitCode, message: string) { super(message); } }
const usageError = (message: string) => new CliError(exitCodes.usage, `${message}\n\nRun "hydra --help" for usage.`);

interface Parsed { command: string[]; flags: Map<string, string | true>; positionals: string[] }
const valueFlags = new Set(['usd', 'minutes', 'max-jobs', 'key', 'timeout', 'reason']);
const boolFlags = new Set(['json', 'unattended', 'help', 'version', 'force']);

export function parseArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>(), positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h') { flags.set('help', true); continue; }
    if (!arg.startsWith('--') || arg === '--') { positionals.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (boolFlags.has(name)) { if (inline !== undefined) throw usageError(`--${name} takes no value.`); flags.set(name, true); continue; }
    if (!valueFlags.has(name)) throw usageError(`Unknown option --${name}.`);
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw usageError(`--${name} needs a value.`);
    flags.set(name, value);
  }
  const command = positionals[0] === 'plan' ? positionals.slice(0, 2) : positionals.slice(0, 1);
  return { command, flags, positionals: positionals.slice(command.length) };
}

const numberFlag = (flags: Parsed['flags'], name: string): number | undefined => {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(number)) throw usageError(`--${name} must be a number.`);
  return number;
};
const planIdArg = (positionals: readonly string[], command: string): string => {
  if (positionals.length !== 1) throw usageError(`hydra ${command} takes one plan id.`);
  const id = positionals[0]!;
  if (!planIdPattern.test(id)) throw usageError(`"${id}" isn't a plan id (12 hex characters).`);
  return id;
};
const noPositionals = (positionals: readonly string[], command: string) => { if (positionals.length) throw usageError(`hydra ${command} takes no arguments.`); };

/** A plan file's fields: exactly hydra_plan_create's, with `$schema` allowed for editors and the idempotency key optional. */
const planFileKeys = new Set(['$schema', 'title', 'brief', 'jobs', 'run', 'budget', 'idempotency_key']);

/**
 * The published JSON schema for `.hydra/plans/*.json` (schemas/hydra-plan.schema.json, wired to editors through
 * package.json's jsonValidation): hydra_plan_create's own input schema, so the two can't drift, with `$schema`
 * allowed and the idempotency key optional. A test checks the checked-in file against this.
 */
export function planFileSchema(): Record<string, unknown> {
  const tool = leadTools.find(item => item.name === 'hydra_plan_create');
  if (!tool) throw new Error('hydra_plan_create is missing.');
  const input = tool.inputSchema as { required: string[]; properties: Record<string, unknown> };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Hydra plan',
    description: 'A Hydra plan file (.hydra/plans/*.json): the same shape as hydra_plan_create. Run it with `hydra plan run <file>`.',
    ...input,
    required: input.required.filter(name => name !== 'idempotency_key'),
    properties: { $schema: { type: 'string', description: 'This file\'s schema, for editors.' }, ...input.properties },
  };
}

/**
 * A plan file, read and checked by the same code hydra_plan_create runs (planFromLeadInput: jobs, keys, dependencies,
 * cycles, write-scope overlap, the unattended rules), before any Hydra is asked. The window checks it again, with
 * its own settings: the dollar budget there uses your per-head default, so only its shape is checked here.
 */
export function planFileArguments(text: string, source: string, flags: { unattended?: boolean; usd?: number; minutes?: number; maxJobs?: number; key?: string }, randomKey: () => string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw usageError(`${source} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError(`${source} must hold one plan object.`);
  const file = value as Record<string, unknown>;
  const unknown = Object.keys(file).filter(key => !planFileKeys.has(key));
  if (unknown.length) throw usageError(`${source} has fields a plan doesn't: ${unknown.join(', ')}.`);
  const budget = { ...(file.budget && typeof file.budget === 'object' ? file.budget as Record<string, unknown> : {}) };
  if (flags.usd !== undefined) budget.usd = flags.usd;
  if (flags.minutes !== undefined) budget.wall_clock_minutes = flags.minutes;
  if (flags.maxJobs !== undefined) budget.max_jobs = flags.maxJobs;
  const run = flags.unattended ? 'unattended' : file.run;
  const key = flags.key ?? (typeof file.idempotency_key === 'string' ? file.idempotency_key : `hydra-cli-${randomKey()}`);
  const args: Record<string, unknown> = {
    title: file.title, ...(file.brief !== undefined ? { brief: file.brief } : {}), jobs: file.jobs,
    ...(run !== undefined ? { run } : {}), ...(Object.keys(budget).length ? { budget } : {}), idempotency_key: key,
  };
  if (typeof args.title !== 'string' || !args.title.trim()) throw usageError(`${source} needs a "title".`);
  try { planFromLeadInput(args as unknown as PlanCreateInput, { leadSessionId: 'user', idempotencyKey: key }, 0); }
  catch (error) { throw usageError(`${source}: ${error instanceof Error ? error.message : String(error)}`); }
  return args;
}

/** Runs one `hydra` invocation; the exit code is its result. Never throws. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<ExitCode> {
  let json = false;
  try {
    const parsed = parseArgs(argv);
    json = parsed.flags.has('json');
    if (parsed.flags.has('version')) { deps.stdout(json ? JSON.stringify({ version: deps.version }) : `hydra ${deps.version}`); return exitCodes.ok; }
    if (parsed.flags.has('help') || !parsed.command.length || parsed.command[0] === 'help') {
      deps.stdout(usage);
      return parsed.command.length || parsed.flags.has('help') ? exitCodes.ok : exitCodes.usage;
    }
    return await dispatch(parsed, deps, json);
  } catch (error) {
    const code = error instanceof CliError ? error.code : exitCodes.refused;
    const message = error instanceof Error ? error.message : String(error);
    if (json) deps.stdout(JSON.stringify({ ok: false, exit_code: code, error: message }));
    deps.stderr(`hydra: ${message}`);
    return code;
  }
}

interface Session { port: number; token: string; repository: string; pid: number }

async function connect(deps: CliDeps): Promise<Session> {
  let refused: string | undefined, missing: string | undefined;
  for (const root of deps.helpersRoots) {
    const found = await deps.findHandshake(root, deps.cwd);
    if (found.ok) return { port: found.handshake.port, token: found.handshake.token, repository: found.handshake.repository, pid: found.handshake.pid };
    if (/^No open Hydra window|no handshake file yet/i.test(found.reason)) missing ??= found.reason;
    else refused ??= found.reason;
  }
  if (refused) throw new CliError(exitCodes.refused, refused);
  throw new CliError(exitCodes.noHydra, missing && /no handshake file yet/i.test(missing)
    ? `${missing} Its heads start once the window trusts this repository; try again in a moment.`
    : `No open Hydra window owns ${deps.cwd}. Open this repository in Hydra first.`);
}

async function call<T = Record<string, unknown>>(deps: CliDeps, session: Session, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  let response: HelperCallResponse;
  try { response = await deps.call(session.port, session.token, tool, args); }
  catch (error) { throw new CliError(exitCodes.noHydra, `The Hydra window that owns this folder stopped answering: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new CliError(exitCodes.refused, response.error ?? 'Hydra refused.');
  return response.result as T;
}

interface JobView { key: string; title: string; status: string; reason?: string; conflict_files?: string[] }
interface IntegrationView { branch: string; landed: string[]; queue: string[]; gate: { label: string }; passed?: boolean; settled?: boolean; can_merge?: boolean; error?: string }
interface PlanView { plan_id: string; title: string; state: string; error?: string; jobs: JobView[]; needs_attention?: string[]; integration?: IntegrationView; created?: boolean }
interface HeadView { job_id: string; title: string; state: string; provider?: string; branch?: string }

const planText = (plan: PlanView): string => {
  const lines = [`Plan ${plan.plan_id} "${plan.title}": ${plan.state}${plan.error ? ` (${plan.error})` : ''}`];
  for (const job of plan.jobs) lines.push(`  ${job.key.padEnd(24)} ${job.status.padEnd(10)} ${job.title}${job.reason ? ` - ${job.reason}` : ''}`);
  if (plan.needs_attention?.length) lines.push(`Needs attention: ${plan.needs_attention.join(', ')}`);
  const integration = plan.integration;
  if (integration) {
    lines.push(`Integration: ${integration.branch}, ${integration.landed.length} landed${integration.queue.length ? `, ${integration.queue.length} waiting to land` : ''}`);
    lines.push(`Integration gate: ${integration.gate.label}`);
    if (integration.error) lines.push(`Integration queue stopped: ${integration.error}`);
  }
  return lines.join('\n');
};

async function dispatch(parsed: Parsed, deps: CliDeps, json: boolean): Promise<ExitCode> {
  const [first, second] = parsed.command;
  const name = parsed.command.join(' ');
  const print = (value: unknown, text: () => string) => deps.stdout(json ? JSON.stringify(value, null, 2) : text());
  const allowed = (flags: string[]) => {
    for (const flag of parsed.flags.keys()) if (flag !== 'json' && !flags.includes(flag)) throw usageError(`hydra ${name} doesn't take --${flag}.`);
  };

  if (first === 'status') {
    allowed([]); noPositionals(parsed.positionals, name);
    const session = await connect(deps);
    const { heads } = await call<{ heads: HeadView[] }>(deps, session, 'hydra_list_heads');
    let lanes: unknown[] | undefined;
    try { const described = await call<{ lanes?: unknown[] }>(deps, session, 'hydra_lanes'); lanes = described.lanes; } catch (error) { if (error instanceof CliError && error.code === exitCodes.noHydra) throw error; }
    const counts: Record<string, number> = {};
    for (const head of heads) counts[head.state] = (counts[head.state] ?? 0) + 1;
    const status = { repository: session.repository, window: { pid: session.pid, port: session.port }, heads: counts, ...(lanes ? { lanes: lanes.length } : {}) };
    print(status, () => [
      `Hydra window ${session.pid} owns ${session.repository}`,
      `Heads: ${heads.length ? Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(', ') : 'none'}`,
      ...(lanes ? [`Lanes: ${lanes.length}`] : []),
    ].join('\n'));
    return exitCodes.ok;
  }
  if (first === 'heads') {
    allowed([]); noPositionals(parsed.positionals, name);
    const session = await connect(deps);
    const result = await call<{ heads: HeadView[] }>(deps, session, 'hydra_list_heads');
    print(result, () => result.heads.length ? result.heads.map(head => `${head.job_id}  ${head.state.padEnd(10)} ${head.provider ?? ''}\t${head.title}`).join('\n') : 'No heads.');
    return exitCodes.ok;
  }
  if (first === 'stop') {
    allowed(['reason']); noPositionals(parsed.positionals, name);
    const reason = parsed.flags.get('reason');
    const session = await connect(deps);
    const result = await call<{ heads?: number; lanes?: number }>(deps, session, 'hydra_stop_all', typeof reason === 'string' ? { reason } : {});
    print(result, () => `Stopped all agents${result.heads !== undefined ? ` (${result.heads} heads, ${result.lanes ?? 0} lanes)` : ''}. Run "hydra resume" to let them start again.`);
    return exitCodes.ok;
  }
  if (first === 'resume') {
    allowed([]); noPositionals(parsed.positionals, name);
    const session = await connect(deps);
    const result = await call(deps, session, 'hydra_resume');
    print(result, () => 'Agents may start again.');
    return exitCodes.ok;
  }
  if (first === 'close') {
    // HSEC-72: the window answers, then closes itself a moment later; it refuses while work runs, unless --force.
    allowed(['force', 'reason']); noPositionals(parsed.positionals, name);
    const reason = parsed.flags.get('reason');
    const session = await connect(deps);
    const result = await call<{ closing: boolean; forced?: boolean; in_ms?: number }>(deps, session, 'hydra_close', {
      ...(parsed.flags.has('force') ? { force: true } : {}), ...(typeof reason === 'string' ? { reason } : {}),
    });
    print({ ...result, repository: session.repository, window: { pid: session.pid, port: session.port } },
      () => `Hydra window ${session.pid} (${session.repository}) is closing${result.forced ? ', cutting its running work short' : ''}.`);
    return exitCodes.ok;
  }
  if (first === 'report') {
    allowed([]);
    const id = planIdArg(parsed.positionals, name);
    const session = await connect(deps);
    const result = await call<{ plan_id: string; markdown: string }>(deps, session, 'hydra_plan_report', { plan_id: id });
    print(result, () => result.markdown);
    return exitCodes.ok;
  }
  if (first !== 'plan') throw usageError(`Unknown command "${first}".`);

  if (second === 'run') {
    allowed(['unattended', 'usd', 'minutes', 'max-jobs', 'key']);
    if (parsed.positionals.length !== 1) throw usageError('hydra plan run takes one plan file or plan id.');
    const target = parsed.positionals[0]!;
    const file = await findPlanFile(deps, target);
    if (!file && planIdPattern.test(target)) {
      if (parsed.flags.size > (json ? 1 : 0)) throw usageError('Running a plan by id takes no options; they belong to a plan file.');
      const session = await connect(deps);
      const plan = await call<PlanView>(deps, session, 'hydra_plan_run', { plan_id: target });
      print(plan, () => planText(plan));
      return exitCodes.ok;
    }
    if (!file) throw usageError(`No plan file "${target}" (looked in this folder and .hydra/plans).`);
    const args = planFileArguments(file.text, path.relative(deps.cwd, file.path) || file.path, {
      unattended: parsed.flags.has('unattended'), usd: numberFlag(parsed.flags, 'usd'), minutes: numberFlag(parsed.flags, 'minutes'),
      maxJobs: numberFlag(parsed.flags, 'max-jobs'), key: typeof parsed.flags.get('key') === 'string' ? parsed.flags.get('key') as string : undefined,
    }, deps.randomKey);
    const session = await connect(deps);
    const plan = await call<PlanView>(deps, session, 'hydra_plan_create', args);
    print(plan, () => `${plan.created === false ? 'Already made (same idempotency key)' : 'Started'}: ${planText(plan)}\n\nWait for it with: hydra plan wait ${plan.plan_id}`);
    return exitCodes.ok;
  }
  if (second === 'show') {
    allowed([]);
    const id = planIdArg(parsed.positionals, name);
    const session = await connect(deps);
    const plan = await call<PlanView>(deps, session, 'hydra_plan_get', { plan_id: id });
    print(plan, () => planText(plan));
    return exitCodes.ok;
  }
  if (second === 'cancel') {
    allowed(['reason']);
    const id = planIdArg(parsed.positionals, name);
    const reason = parsed.flags.get('reason');
    const session = await connect(deps);
    const plan = await call<PlanView>(deps, session, 'hydra_plan_cancel', { plan_id: id, ...(typeof reason === 'string' ? { reason } : {}) });
    print(plan, () => planText(plan));
    return exitCodes.ok;
  }
  if (second === 'wait') {
    allowed(['timeout']);
    const id = planIdArg(parsed.positionals, name);
    const timeout = numberFlag(parsed.flags, 'timeout') ?? defaultWaitSeconds;
    if (timeout <= 0 || timeout > maxWaitSeconds) throw usageError(`--timeout must be 1 to ${maxWaitSeconds} seconds.`);
    const session = await connect(deps);
    const plan = await waitForPlan(deps, session, id, timeout);
    const passed = plan.view.integration?.passed === true;
    const verdict = plan.timedOut ? `Timed out after ${timeout}s; the plan is still ${plan.view.state}.`
      : passed ? 'The integration gate passed.'
      : !plan.view.integration ? 'This plan has no integration gate, so it never counts as passed.'
      : `The integration gate didn't pass: ${plan.view.integration.gate.label}.`;
    print({ ...plan.view, passed, timed_out: plan.timedOut }, () => `${planText(plan.view)}\n\n${verdict}`);
    if (!passed && json) deps.stderr(`hydra: ${verdict}`);
    return passed ? exitCodes.ok : exitCodes.refused;
  }
  throw usageError(second ? `Unknown command "plan ${second}".` : 'hydra plan needs a command: run, show, wait or cancel.');
}

/** A plan file named as given (from this folder), or under .hydra/plans, with or without .json. */
async function findPlanFile(deps: CliDeps, target: string): Promise<{ path: string; text: string } | undefined> {
  const names = [target, ...(target.endsWith('.json') ? [] : [`${target}.json`])];
  const candidates = [...names.map(name => path.resolve(deps.cwd, name)), ...names.map(name => path.resolve(deps.cwd, '.hydra', 'plans', name))];
  for (const candidate of candidates) {
    const text = await deps.readFile(candidate);
    if (text !== undefined) return { path: candidate, text };
  }
  return undefined;
}

/**
 * Waits until the plan has stopped running and its integration gate has nothing more to say (hydra_plan_wait already
 * waits for both). hydra_plan_wait returns at once while a job needs attention, so between those calls this waits
 * pollMs, rather than asking again and again.
 */
async function waitForPlan(deps: CliDeps, session: Session, id: string, timeoutSeconds: number): Promise<{ view: PlanView; timedOut: boolean }> {
  const deadline = deps.now() + timeoutSeconds * 1000;
  for (;;) {
    const left = Math.ceil((deadline - deps.now()) / 1000);
    if (left <= 0) return { view: await call<PlanView>(deps, session, 'hydra_plan_get', { plan_id: id }), timedOut: true };
    const started = deps.now();
    const view = await call<PlanView>(deps, session, 'hydra_plan_wait', { plan_id: id, max_wait_s: Math.max(1, Math.min(3000, left)) });
    if (view.state !== 'running' && (!view.integration || view.integration.settled !== false)) return { view, timedOut: false };
    if (deps.now() - started < 1000) await deps.sleep(Math.min(deps.pollMs ?? 5000, Math.max(0, deadline - deps.now())));
  }
}

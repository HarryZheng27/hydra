import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { processLaunch, terminateProcessTree } from './process';
import type { Provider } from './model';
import { claudeHeadLimit, codexHeadLimit, type HeadLimit } from './limitDetection';
import { claudeHeadTools } from './confine';
import { redactText } from './redact';

/**
 * Runs one Hydra helper process unattended (docs/Official_Extensions_Plan.md,
 * Phase 4). Helpers never ask for permission: anything outside their allowed
 * tools and sandbox is denied and they keep going.
 *
 * - Claude: one `claude -p` stream-json process for the whole job, with
 *   `--permission-mode dontAsk`, an allowed-tools list, `--max-turns` and
 *   `--max-budget-usd`. Follow-up messages (a nudge) go into the same process.
 * - Codex: `codex exec --json` with a workspace-write sandbox and approval
 *   "never"; a follow-up resumes the same thread with `codex exec resume`.
 *
 * Hydra's own actions reach the helper through the bridge, configured inline so
 * the token never touches a config file.
 */
export interface HelperRunSpec {
  provider: Provider;
  executable: string;
  worktree: string;
  prompt: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** How the CLI starts the hydra-mcp bridge, plus the helper's own endpoint port and token. */
  bridge: { command: string; args: string[]; env: Record<string, string> };
  logFile: string;
  /** Called with each process started for this helper, so Hydra can refuse it as a lead. */
  spawned?: (pid: number) => void;
  /** Packs (docs/Packs_Plan.md, section 5): what the head's role adds to its command line and environment. */
  role?: HeadRoleArguments;
  /** Step 2: how the head is confined. */
  confine: HeadConfinement;
}
/** How HelperService confines one head (src/core/confine.ts builds each piece). */
export interface HeadConfinement {
  /** Claude: the head's `--settings` file, which Hydra wrote (0600) and removes when the head ends. */
  settingsFile?: string;
  /** Claude: folders it reads besides its worktree (`--add-dir`): its role's checked pack copy. */
  addDirs: string[];
  /** Claude: whether it has a shell (Bash): only in Codex's sandbox, or where there is none to use. */
  shell: boolean;
  /** Its whole environment (headEnvironment): the allowlist, its sign-in and role variables, and what Hydra sets. */
  env: Record<string, string>;
}
/**
 * A role's pieces on a head's command line (roleLaunch, placed here). The role's
 * instructions and skill index are in the first message instead (helperPrompt).
 */
export interface HeadRoleArguments {
  /** Claude: a second `--mcp-config=<file>` with the role's servers (R3), next to the inline Hydra config. */
  mcpConfigFile?: string;
  /** Claude: `--plugin-dir` with the role's skills (R5). */
  pluginDir?: string;
  /** Claude: added to `--allowedTools`: `Skill`, `mcp__<pack>-<id>`, and `WebSearch`,`WebFetch` for a web role. */
  allowedTools: string[];
  /** Codex: `-c mcp_servers.<pack>-<id>.*` pairs (R4). */
  codexConfig: string[];
  /** Codex: web search, `'live'` only for a web role (R7). */
  webSearch: 'live' | 'disabled';
  /** Variables the role's Codex servers read by name, set in the head's own environment. */
  env: Record<string, string>;
}
export interface HelperRun {
  /** Resolves when a turn ends (the helper stopped working and is waiting for a message). */
  onTurnEnd(listener: () => void): void;
  /** Resolves once the process is gone for good. */
  readonly exited: Promise<{ code: number | null }>;
  /** Send a follow-up message (a nudge). False if the helper can no longer take one. */
  send(message: string): Promise<boolean>;
  stop(): Promise<void>;
  /** The usage limit the CLI reported for its latest turn, if that turn hit one. */
  limitHit?(): HeadLimit | undefined;
}
export type StartHelperRun = (spec: HelperRunSpec) => HelperRun;

/**
 * A Claude head's command line. Step 2 (design 1):
 * - `--setting-sources user`: a head can write `.claude/settings.local.json` in its worktree, and
 *   with project or local settings loaded, a hook it planted there ran unsandboxed (R5);
 * - `--settings <file>`: its read block and deny rules (headSettings);
 * - `--tools` and a scoped `--allowedTools` (claudeHeadTools): no PowerShell, Bash only with a shell;
 * - `--add-dir` for its role's pack copy, which the read block would otherwise hide.
 * A role's servers come in a second file, beside Hydra's token-bearing entry, which stays inline;
 * --strict-mcp-config still keeps every other server out (R3).
 */
export function claudeHelperArguments(spec: HelperRunSpec): string[] {
  const { confine } = spec;
  if (!confine.settingsFile) throw new Error('A Claude head needs its settings file.');
  // With a sandboxed shell, Claude Code starts stdio servers through the wrapper too; this marks Hydra's own (confine.ts, wrapperScript).
  const bridgeEnv = confine.env.CLAUDE_CODE_SHELL_PREFIX ? { ...spec.bridge.env, HYDRA_SHELL_DIRECT: '1' } : spec.bridge.env;
  const mcp = JSON.stringify({ mcpServers: { hydra: { type: 'stdio', command: spec.bridge.command, args: spec.bridge.args, env: bridgeEnv, timeout: 3_600_000 } } });
  const role = spec.role;
  const { tools, allowed } = claudeHeadTools(confine.shell, role?.allowedTools ?? []);
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--setting-sources', 'user', '--settings', confine.settingsFile,
    '--tools', tools.join(','), '--allowedTools', allowed.join(','),
    '--max-turns', String(spec.maxTurns), '--max-budget-usd', String(spec.maxBudgetUsd),
    `--mcp-config=${mcp}`, ...(role?.mcpConfigFile ? [`--mcp-config=${role.mcpConfigFile}`] : []), '--strict-mcp-config',
    ...confine.addDirs.flatMap(folder => ['--add-dir', folder]),
    ...(role?.pluginDir ? ['--plugin-dir', role.pluginDir] : []), ...(spec.model ? ['--model', spec.model] : [])];
}

/** A TOML literal string. Paths and tokens never contain a single quote; refuse rather than mis-quote. */
const toml = (value: string) => { if (value.includes("'") || /[\r\n]/.test(value)) throw new Error('A Codex head setting contains a quote or line break.'); return `'${value}'`; };
export function codexHelperArguments(spec: HelperRunSpec, resumeThread?: string): string[] {
  const env = Object.entries(spec.bridge.env).map(([key, value]) => `${key} = ${toml(value)}`).join(', ');
  const config = ['-c', `mcp_servers.hydra.command=${toml(spec.bridge.command)}`, '-c', `mcp_servers.hydra.args=[${spec.bridge.args.map(toml).join(', ')}]`,
    '-c', `mcp_servers.hydra.env={ ${env} }`, '-c', "mcp_servers.hydra.default_tools_approval_mode='approve'", '-c', 'mcp_servers.hydra.tool_timeout_sec=3600',
    // Packs: the role's servers, then web search, which `codex exec` has on by default: only a web role keeps it (R7).
    ...spec.role?.codexConfig ?? [], '-c', `web_search='${spec.role?.webSearch ?? 'disabled'}'`,
    '-c', "approval_policy='never'", '-s', 'workspace-write', ...(spec.model ? ['-m', spec.model] : [])];
  return resumeThread ? ['exec', 'resume', '--json', ...config, resumeThread, '-'] : ['exec', '--json', ...config, '-'];
}

export const startHelperRun: StartHelperRun = spec => spec.provider === 'claude' ? startClaude(spec) : startCodex(spec);

/**
 * 5.1: the head's own bridge token is masked (it's an exact
 * secret Hydra already knows), and so is anything else in the line that looks like a
 * secret — an API key the head's tool output happened to print, an env var value, and so on.
 */
/** Exported for tests/redact.test.ts: a head transcript that prints a planted secret masks it. */
export function logger(file: string, secret?: string) {
  let queue: Promise<unknown> = mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  const redact = (line: string) => redactText(line, secret ? [secret] : []);
  return (kind: string, data: unknown) => { queue = queue.then(() => appendFile(file, redact(JSON.stringify({ at: Date.now(), kind, data })) + '\n')).catch(() => undefined); };
}

function spawnLogged(spec: HelperRunSpec, args: string[], log: (kind: string, data: unknown) => void, onLine: (message: Record<string, unknown>) => void): ChildProcess {
  const launch = processLaunch(spec.executable, args);
  // Step 2: the head's own allowlisted environment (headEnvironment), never Hydra's whole one. A role's
  // Codex servers read some variables by name (R4): they're in it, never on the command line.
  const child = spawn(launch.executable, launch.args, { cwd: spec.worktree, env: spec.confine.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  if (child.pid) spec.spawned?.(child.pid);
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      log('stdout', line.length > 20_000 ? line.slice(0, 20_000) : line);
      try { onLine(JSON.parse(line)); } catch { /* non-JSON noise is logged only */ }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => log('stderr', chunk.slice(0, 4000)));
  return child;
}

function stopper(child: () => ChildProcess | undefined) {
  return async () => {
    const current = child();
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    try { if (current.pid) await terminateProcessTree(current.pid); } catch { current.kill(); }
  };
}

function startClaude(spec: HelperRunSpec): HelperRun {
  const log = logger(spec.logFile, spec.bridge.env.HYDRA_HELPER_TOKEN), listeners: (() => void)[] = [];
  log('start', { provider: 'claude', worktree: spec.worktree, args: claudeHelperArguments(spec) });
  let limit: HeadLimit | undefined;
  const child = spawnLogged(spec, claudeHelperArguments(spec), log, message => {
    // A limit counts for the turn it ends; a later good turn clears it.
    if (message.type === 'assistant' || message.type === 'result') limit = claudeHeadLimit(message) ?? (message.type === 'result' && message.is_error !== true ? undefined : limit);
    if (message.type === 'result') for (const listener of listeners) listener();
  });
  const exited = new Promise<{ code: number | null }>(resolve => child.on('close', code => { log('exit', { code }); resolve({ code }); }));
  child.on('error', error => log('error', error.message));
  const write = (value: unknown) => new Promise<boolean>(resolve => {
    if (child.exitCode !== null || !child.stdin || child.stdin.destroyed) return resolve(false);
    child.stdin.write(JSON.stringify(value) + '\n', error => resolve(!error));
  });
  const say = (text: string) => write({ type: 'user', message: { role: 'user', content: text } });
  void write({ type: 'control_request', request_id: 'hydra-helper-init', request: { subtype: 'initialize' } }).then(() => say(spec.prompt));
  return { onTurnEnd: listener => { listeners.push(listener); }, exited, send: async text => { limit = undefined; return say(text); }, stop: stopper(() => child), limitHit: () => limit };
}

function startCodex(spec: HelperRunSpec): HelperRun {
  const log = logger(spec.logFile, spec.bridge.env.HYDRA_HELPER_TOKEN), listeners: (() => void)[] = [];
  let thread: string | undefined, current: ChildProcess | undefined, finished = false, limit: HeadLimit | undefined;
  let resolveExit!: (value: { code: number | null }) => void;
  const exited = new Promise<{ code: number | null }>(resolve => { resolveExit = resolve; });
  const run = (prompt: string, resumeThread?: string) => {
    const args = codexHelperArguments(spec, resumeThread);
    log('start', { provider: 'codex', worktree: spec.worktree, resume: resumeThread, args });
    limit = undefined;
    const child = spawnLogged(spec, args, log, message => {
      if (message.type === 'thread.started' && typeof message.thread_id === 'string') thread = message.thread_id;
      // An error line can be a retry notice; a completed turn clears it.
      if (message.type === 'turn.completed') limit = undefined;
      else limit = codexHeadLimit(message) ?? limit;
    });
    current = child;
    child.stdin!.end(prompt);
    child.on('error', error => log('error', error.message));
    child.on('close', code => {
      log('exit', { code });
      if (finished) return;
      // Each exec is one turn. A clean exit is a turn end; the helper may get a follow-up.
      if (code === 0 && thread) for (const listener of listeners) listener();
      else { finished = true; resolveExit({ code }); }
    });
  };
  run(spec.prompt);
  return {
    onTurnEnd: listener => { listeners.push(listener); },
    exited,
    send: async text => { if (finished || !thread || (current && current.exitCode === null)) return false; run(text, thread); return true; },
    limitHit: () => limit,
    stop: async () => { const wasFinished = finished; finished = true; await stopper(() => current)(); if (!wasFinished) resolveExit({ code: current?.exitCode ?? null }); },
  };
}

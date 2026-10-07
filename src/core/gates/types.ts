import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Provider } from '../model';
import type { JobCheckResult } from '../jobs';
import type { ProbeOutput } from '../process';
import type { CheckCommandResult } from '../checkCommand';
import type { Gate } from './config';
import type { ScreenshotBrowser } from './browser';
import type { CommandSandbox } from '../headSandbox';
import type { AgentIsolation } from '../agentHome';
import { redactText } from '../redact';

/**
 * What a caller tells the gates about the work being checked. Heads
 * (HelperService.accept) and lanes (Merge, Run gates) both fill it in.
 */
export interface GateContext {
  /** Whose work it is. A review by "other" uses the other agent. */
  author: Provider;
  /**
   * For a head's gates (HSEC-09): the environment that pins Hydra's own git calls in the worktree to its checked
   * metadata (pinnedWorktreeGit), so a .git the head rewrites while gates run is never read.
   */
  gitEnvironment?: NodeJS.ProcessEnv;
  /** O6: providers this job ran under before `author` (a usage-limit handoff). When set, "other" has no clean choice — both wrote the diff — and the pick says so. */
  priorAuthors?: Provider[];
  /** The project's `tests` globs from gates.json (editedTests.ts), replacing the default test patterns. */
  testPatterns?: readonly string[];
  /** Where this run's logs, the reviewer's reply and the screenshots go. Created if missing. */
  logDirectory: string;
  /** What the work was for, for the reviewer: the head's title, brief and write scope, or a lane's goal. */
  title?: string;
  brief?: string;
  writeScope?: string[];
  /**
   * The provider CLI, already version-checked (HelperService's `executable`).
   * Throws a plain reason when it isn't installed or can't be used. Defaults to a PATH lookup.
   */
  executable?: (provider: Provider) => Promise<string>;
  /** A provider that is at its usage limit now; a review then uses the other one. */
  limited?: (provider: Provider) => boolean;
  /** Every process a gate starts (commands, the app, the reviewer, the browser), so none of them can act as a lead. */
  spawned?: (pid: number) => void;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** As each gate starts and finishes, for progress on a tile ("Gates: unit ✓ · review …"). */
  onProgress?: (progress: { done: JobCheckResult[]; running?: string }) => void;
  /** Test seams: a fake reviewer, browser, clock or port. */
  runtime?: Partial<GateRuntime>;
  /**
   * Step 2 (design 5): Codex's sandbox for command gates and the
   * screenshots gate's app, with the worktree writable and the allowlisted environment. Without it,
   * or when it isn't available, they run as before. Review gates don't use it: they run read-only.
   */
  sandbox?: CommandSandbox;
  /**
   * Where a sandboxed gate command's own TEMP goes: a short folder, since Windows refuses paths
   * past 260 characters and tools like npm nest deep inside TEMP. Without it, beside the gate's log.
   */
  tempRoot?: string;
  /**
   * HSEC-71: Hydra's storage folder, which holds the Codex reviewer's own CODEX_HOME (agentHome.ts).
   * Without it, a Codex reviewer uses your home, with Hydra's flags keeping your config.toml out.
   */
  agentStorage?: string;
  /**
   * 5.1: masks secrets in gate evidence (command logs, review
   * prompts and replies) and in a JobCheckResult's own text. Defaults to `redactText` with no
   * live secrets besides the environment; a caller that knows about live secrets (Hydra's own
   * endpoint tokens) can pass a redactor that also masks those.
   */
  redact?: (text: string) => string;
}

/** A sandboxed gate command's own TEMP folder (see GateContext.tempRoot): short and unique per run. */
export function gateTemp(run: Pick<GateContext, 'tempRoot' | 'logDirectory'>, gateId: string): string {
  return run.tempRoot ? path.join(run.tempRoot, `g${randomBytes(5).toString('hex')}`) : path.join(run.logDirectory, `${gateId}-temp`);
}

export interface ReviewerSpec {
  provider: Provider;
  executable: string;
  args: string[];
  /** The prompt, written to the CLI's stdin. */
  input: string;
  /** The worktree under review; the reviewer only reads it. */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  spawned?: (pid: number) => void;
  /** HSEC-71: set on top of Hydra's environment (AgentIsolation.env): Claude's switches, or Codex's CODEX_HOME. */
  env?: Record<string, string>;
}

/** Everything a gate does to the outside world, so tests can replace any of it. */
export interface GateRuntime {
  runCommand(command: { executable: string; args: string[]; env?: Record<string, string>; environment?: Record<string, string> }, cwd: string, logFile: string, timeoutMs: number, signal?: AbortSignal, spawned?: (pid: number) => void): Promise<CheckCommandResult>;
  runReviewer(spec: ReviewerSpec): Promise<ProbeOutput>;
  /** HSEC-71: what a reviewer runs with so none of your own configuration reaches it (agentIsolation). */
  isolation(provider: Provider, storage: string | undefined): Promise<AgentIsolation>;
  browser: ScreenshotBrowser;
  freePort(): Promise<number>;
  fetch: typeof fetch;
  /** Kills a process and everything it started. */
  terminate(pid: number): Promise<void>;
  now(): number;
  /** How often the screenshots gate asks whether the app is ready. */
  pollMs: number;
}

/** One gate's view of the run: the context, where it runs, and what ran before it. */
export interface GateRun extends GateContext {
  /** The head's (or lane's) worktree. Gates never run anywhere else. */
  worktree: string;
  /** Where the work started: the diff under review is baseCommit..HEAD. */
  baseCommit: string;
  runtime: GateRuntime;
  earlier: JobCheckResult[];
  /** Existing test files this change edited or deleted, for a review gate to check (editedTests.ts). Only worked out when a review gate runs. */
  editedTests?: readonly string[];
}

export type GateRunner<G extends Gate> = (gate: G, run: GateRun) => Promise<JobCheckResult>;

/** A gate that couldn't run. It is reported with the reason and never fails the work. */
export function notRun(gate: Pick<Gate, 'id' | 'type' | 'required'>, reason: string, durationMs = 0, extra: Partial<JobCheckResult> = {}): JobCheckResult {
  return { id: gate.id, kind: gate.type, required: gate.required, state: 'notRun', passed: false, exitCode: null, durationMs, outputTail: '', summary: reason, ...extra };
}
/**
 * 5.1: every gate goes through this before its result is kept, so a command's printed secret
 * or a reviewer's quoted one never reaches the job's checks, the UI or a lane's Send to lane.
 */
export function redactGateResult(result: JobCheckResult, redact: (text: string) => string = redactText): JobCheckResult {
  return {
    ...result,
    outputTail: redact(result.outputTail),
    ...(result.summary !== undefined ? { summary: redact(result.summary) } : {}),
    ...(result.retriedAfter !== undefined ? { retriedAfter: redact(result.retriedAfter) } : {}),
    ...(result.findings ? { findings: result.findings.map(finding => ({ ...finding, note: redact(finding.note) })) } : {}),
  };
}
export const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}…` : value;
export const tail = (value: string, max: number): string => value.length > max ? `…${value.slice(-max)}` : value;
export const providerName = (provider: Provider): string => provider === 'claude' ? 'Claude Code' : 'Codex';

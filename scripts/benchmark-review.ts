// O9 (docs/Benchmark.md): the review a plan's integration gate runs, on the single agent's result. benchmark.mjs
// review bundles this file with esbuild when it runs, so the review is Hydra's own code (integrationGates,
// runGateList, the review gate, findProvider), not a copy of it.
import { loadGates, runGateList, type GateRuntime } from '../src/core/gates/index';
import { defaultRunReviewer } from '../src/core/gates/review';
import { integrationGates } from '../src/core/integration';
import { findProvider } from '../src/core/providers';
import type { JobCheckResult } from '../src/core/jobs';
import type { Provider } from '../src/core/model';

export interface BenchmarkReviewOptions {
  /** The single agent's repository; the gates run here and the reviewer reads it. */
  repo: string;
  /** Where the work started: the review sees base..HEAD. */
  base: string;
  /** The plan the single agent was given, for the reviewer's task, as a plan's integration review has it. */
  planTitle: string;
  planBrief?: string;
  logDirectory: string;
  /** Whose work it is: the review goes to the other agent. Claude Code by default, the benchmark's single agent. */
  author?: Provider;
  /** Absolute paths to the CLIs, like hydra.claudePath and hydra.codexPath; otherwise looked up on PATH as Hydra does. */
  paths?: Partial<Record<Provider, string>>;
  /** A stand-in for the reviewer's command line (tests): the reviewer's arguments follow it. */
  reviewerCommand?: string[];
  runtime?: Partial<GateRuntime>;
  log?: (line: string) => void;
  now?: () => number;
}

export interface BenchmarkReview { checks: JobCheckResult[]; durationMs: number; startedAt: string }

/** A provider's CLI, found the way Hydra finds it (findProvider): the configured path, else PATH. */
export async function providerExecutable(provider: Provider, configured?: string): Promise<string> {
  const found = await findProvider(provider, configured);
  if (!found.executable) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI not found`);
  return found.executable;
}

/**
 * The gates a plan's integration gate runs (integrationGates with a review: the project's command gates, and its
 * review gates or rigor's review by the other agent), run on `repo` at base..HEAD, with the same title and brief a
 * plan's integration review gives the reviewer.
 */
export async function reviewRepository(options: BenchmarkReviewOptions): Promise<BenchmarkReview> {
  const now = options.now ?? Date.now;
  const started = now();
  const config = await loadGates(options.repo);
  const { gates, notRun } = integrationGates(config, true);
  const stand = options.reviewerCommand;
  const runtime: Partial<GateRuntime> = {
    ...(stand ? { runReviewer: spec => defaultRunReviewer({ ...spec, executable: stand[0]!, args: [...stand.slice(1), ...spec.args] }) } : {}),
    ...options.runtime,
  };
  const checks = await runGateList(gates, options.repo, options.base, {
    author: options.author ?? 'claude',
    title: `Plan "${options.planTitle}": every job's work together`,
    brief: options.planBrief || `The combined work of every job in plan "${options.planTitle}", merged on its integration branch.`,
    writeScope: [],
    logDirectory: options.logDirectory,
    executable: provider => stand ? Promise.resolve(stand[0]!) : providerExecutable(provider, options.paths?.[provider]),
    ...(options.log ? { log: options.log } : {}),
    runtime,
  });
  return { checks: [...checks, ...notRun], durationMs: now() - started, startedAt: new Date(started).toISOString() };
}

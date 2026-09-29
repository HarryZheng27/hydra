import { mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import type { Provider } from './model';
import type { DependencyResult } from './headStart';
import { gateIdPattern, type Gate, type PlanRigor } from './gates/config';
import type { GitMetaFingerprint } from './git';
import { validateProviderWait, type ProviderWait } from './providerWait';

/**
 * Hydra helper jobs (docs/Official_Extensions_Plan.md, Phase 2).
 *
 * One store per workspace, one writer (this extension host), and one table of
 * allowed state changes. Every change is validated against the table, recorded in
 * the job's history, and written atomically, so a crash midway leaves the previous
 * file readable.
 */
export type JobState = 'queued' | 'starting' | 'running' | 'blocked' | 'checking' | 'done' | 'failed' | 'cancelled';
export const jobStates: readonly JobState[] = ['queued', 'starting', 'running', 'blocked', 'checking', 'done', 'failed', 'cancelled'];
export const finalJobStates: ReadonlySet<JobState> = new Set(['done', 'failed', 'cancelled']);

/** The only allowed state changes. Anything else is refused. */
export const jobTransitions: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['starting', 'failed', 'cancelled'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['blocked', 'checking', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  checking: ['done', 'running', 'failed', 'cancelled'],
  done: [],
  // The one way out of "failed": HelperService.continueWith sends a head that
  // failed on a usage limit back to queued, with the same worktree and branch.
  failed: ['queued'],
  cancelled: [],
};
export const canTransition = (from: JobState, to: JobState): boolean => jobTransitions[from].includes(to);

/** parseJobInput's cap on `brief`; HelperService.continueWith clips an appended handoff to the same limit. */
export const maxBriefLength = 32000;
export interface JobLimits { wallClockMs: number; maxTurns: number; maxBudgetUsd: number }
export const defaultJobLimits: JobLimits = { wallClockMs: 30 * 60_000, maxTurns: 60, maxBudgetUsd: 5 };

/** Raw values from Hydra's heads settings, before clamping. */
export interface HeadDefaultsInput { minutes?: number; maxTurns?: number; budgetUsd?: number }
const clampDefault = (value: unknown, fallback: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
/**
 * Resolve the default caps for a head started without explicit limits, from
 * Hydra's heads settings (hydra.heads.defaultMinutes/defaultMaxTurns/defaultBudgetUsd).
 * Pure so it is unit-testable; matches the package.json minimum/maximum for each setting.
 */
export function resolveHeadDefaults(input: HeadDefaultsInput): JobLimits {
  return {
    wallClockMs: clampDefault(input.minutes, 30, 1, 480) * 60_000,
    maxTurns: clampDefault(input.maxTurns, 60, 1, 500),
    maxBudgetUsd: clampDefault(input.budgetUsd, 5, 0.5, 100),
  };
}
/** How many times a head may report done before it fails, unless .hydra/gates.json says otherwise. */
export const defaultMaxAttempts = 3;
/** Gates (docs/Gates_Plan.md): what kind of gate a result is from, and how it ended. */
export type GateKind = 'command' | 'screenshots' | 'review';
export type GateState = 'passed' | 'failed' | 'notRun';
export type FindingSeverity = 'blocker' | 'major' | 'minor';
export interface GateFinding { file?: string; line?: number; severity: FindingSeverity; note: string }
/**
 * One gate's result: a command, the screenshots or a review. Results recorded
 * before gates existed have only the first six fields; read those through
 * gateKind and gateState. `passed` stays true only for a gate that passed.
 */
export interface JobCheckResult {
  id: string; required: boolean; passed: boolean; exitCode: number | null; durationMs: number; outputTail: string;
  kind?: GateKind; state?: GateState;
  /** Files that show what happened: the command's log, the reviewer's reply, the screenshots. */
  evidence?: string[];
  /** A review's findings. */
  findings?: GateFinding[];
  /** One line on the outcome: the review's summary, what the screenshots showed, or why the gate didn't run. */
  summary?: string;
  /** Who reviewed, for a review gate. */
  reviewer?: Provider;
  /** The pack the gate comes from (docs/Packs_Plan.md), for "From the Coding pack". */
  pack?: string;
  /** That pack's title. */
  packTitle?: string;
}
export const gateKind = (check: JobCheckResult): GateKind => check.kind ?? 'command';
export const gateState = (check: JobCheckResult): GateState => check.state ?? (check.passed ? 'passed' : 'failed');
/** A gate that stops the work being accepted: required and failed. A gate that didn't run never blocks. */
export const gateBlocks = (check: JobCheckResult): boolean => check.required && gateState(check) === 'failed';

/**
 * One gate's result as the dashboard shows it (docs/Gates_Plan.md, "Seeing
 * results"): enough to draw a chip and to open View evidence without
 * refetching the whole JobCheckResult. src/core/model.ts's HelperJobView
 * re-exports this type; it lives here so toHeadCheckView (below) and its unit
 * test never need model.ts.
 */
export interface HeadCheckView { id: string; passed: boolean; kind: GateKind; state: GateState; required: boolean; summary?: string; findings?: GateFinding[]; evidence?: string[]; pack?: string; packTitle?: string }
/** A stored JobCheckResult, as extension.ts's headViews sends it to the dashboard. Pure, so the mapping is unit tested directly. */
export function toHeadCheckView(check: JobCheckResult): HeadCheckView {
  return {
    id: check.id, passed: check.passed, kind: gateKind(check), state: gateState(check), required: check.required,
    ...(check.summary ? { summary: check.summary } : {}),
    ...(check.findings?.length ? { findings: check.findings } : {}),
    ...(check.evidence?.length ? { evidence: check.evidence } : {}),
    ...(check.pack ? { pack: check.pack } : {}),
    ...(check.packTitle ? { packTitle: check.packTitle } : {}),
  };
}

/**
 * A gate chip (docs/Gates_Plan.md, "Seeing results"): "✓ unit · ✓ review · ✗
 * ui", plus a not-run style with the reason on hover. Text as well as colour,
 * never colour alone — `tone` only ever adds colour on top of `label`'s icon.
 * Pure so both the Agents canvas and the Lanes tiles (and their SSR tests) use
 * the same reading of a result.
 */
export interface GateChipView { id: string; icon: '✓' | '✗' | '–'; label: string; tone: 'good' | 'bad' | 'neutral'; title: string }
export function gateChip(check: Pick<JobCheckResult, 'id' | 'kind' | 'state' | 'passed' | 'summary' | 'required'>): GateChipView {
  const state = gateState(check as JobCheckResult);
  const icon = state === 'passed' ? '✓' : state === 'notRun' ? '–' : '✗';
  const tone: GateChipView['tone'] = state === 'passed' ? 'good' : state === 'notRun' ? 'neutral' : 'bad';
  const title = state === 'notRun' ? (check.summary ? `Not run: ${check.summary}` : 'Not run') : (check.summary || (state === 'failed' ? 'Failed' : 'Passed'));
  return { id: check.id, icon, label: `${icon} ${check.id}`, tone, title };
}
export interface JobResult {
  summary: string; commit: string; changedFiles: string[]; checks: JobCheckResult[];
  /** 1.6: set when .hydra/gates.json, checks.json or packs.json changed while this head ran. The gate floor (1.1) still ran the head's start-of-run gates regardless. */
  note?: string;
  /** Step A: the truthful evidence status at acceptance. Missing on results from before this change, and on an accepted result nothing about gates should label (an optional-changes role that changed nothing): never relabelled after the fact. */
  status?: EvidenceStatus;
}

// ---- Step A ("truthful gate status for every job") ----

/** How a project's gates were set up when a job finished: a real gates/checks file, a gates.json that deliberately lists none, or no file at all. */
export type GatesConfigured = 'file' | 'empty-file' | 'none';
/**
 * One truthful label for how a job's work was accepted, shown identically everywhere the result
 * appears (the canvas node, the lane tile, the plan view, the Agents tree and View evidence):
 * - `passed`: every required gate passed, and no gate was skipped.
 * - `partial`: required gates passed, but at least one gate (required or not) didn't run.
 * - `none`: the project has no gates file at all.
 * - `none-chosen`: the project's gates.json deliberately lists none.
 * - `override`: a required gate failed, and a human went ahead anyway (Merge anyway / Mark done anyway).
 */
export type EvidenceStatus = 'passed' | 'partial' | 'none' | 'none-chosen' | 'override';
export interface EvidenceStatusInput {
  checks: JobCheckResult[];
  configured: GatesConfigured;
  /** A human overrode a failed required gate. Never set for a head: heads have no override, only lanes do. */
  override?: boolean;
}
/**
 * Step A: the status for a finished job's checks. Undefined in the two cases that aren't a
 * governance decision about gates at all, so neither gets a gates label:
 * - a required gate failed and nobody overrode it — the work wasn't accepted, so there is
 *   nothing to label (the caller should not have reached acceptance in this case, but the
 *   function stays total rather than throwing);
 * - an accepted job whose checks are empty because nothing ran (for example an optional-changes
 *   role that changed nothing): calling that "no gates configured" would misstate a project that
 *   has real gates, so it is left unlabelled instead.
 * A `notRun` required gate can never yield `passed` — `partial` always wins over it.
 */
export function evidenceStatus({ checks, configured, override }: EvidenceStatusInput): EvidenceStatus | undefined {
  if (checks.some(gateBlocks)) return override ? 'override' : undefined;
  if (configured === 'none') return 'none';
  if (configured === 'empty-file') return 'none-chosen';
  if (!checks.length) return undefined;
  return checks.some(check => gateState(check) === 'notRun') ? 'partial' : 'passed';
}
const evidenceLabels: Readonly<Record<EvidenceStatus, string>> = {
  passed: 'Passed required gates',
  partial: 'Some gates not run',
  none: 'No gates configured',
  'none-chosen': 'No gates (project choice)',
  override: 'Human override',
};
export const evidenceLabel = (status: EvidenceStatus): string => evidenceLabels[status];
/**
 * Whether a project's gates counted as configured (Step A): 'none' when there is no gates or
 * checks file at all; 'empty-file' when the effective gate list is empty even though a file
 * exists (a deliberate gates.json with `"gates": []`, or the packs that would have added to it
 * inactive); 'file' otherwise. `effectiveGateCount` should count every gate that would run or be
 * reported not-run — gates.json's own gates plus any a pack added.
 */
export function gatesConfigured(source: 'gates' | 'checks' | 'none', effectiveGateCount: number): GatesConfigured {
  // Gates a pack adds count even without a gates.json of the project's own.
  if (effectiveGateCount > 0) return 'file';
  return source === 'none' ? 'none' : 'empty-file';
}
export interface JobEvent { at: string; from: JobState | null; to: JobState; reason?: string }

/** The chat that started a job: one lead bridge (one Claude Code or Codex conversation). Set by Hydra from the caller's token. */
export interface JobLead {
  sessionId: string; provider?: Provider; label?: string;
  /** The Hydra lane that chat runs in, when it does (docs/Lanes_And_Planner_Plan.md). */
  lane?: string;
}
export interface Job {
  version: 1;
  id: string;
  /** Who started it: the lead of one Hydra window. Assigned by Hydra from the caller's token, never by the caller. */
  leadKey: string;
  lead?: JobLead;
  idempotencyKey: string;
  title: string;
  brief: string;
  writeScope: string[];
  provider: Provider;
  model?: string;
  dependsOn: string[];
  state: JobState;
  limits: JobLimits;
  /** Check attempts used, and the most allowed (the first run plus re-prompts). */
  attempts: number;
  maxAttempts: number;
  /** A helper that stops without reporting is nudged once, then failed. */
  nudged: boolean;
  /** Failed because its provider hit a usage limit (headLimitReason), not the head's own fault. Lets HelperService.continueWith find it, and clears once it does. */
  limitHit?: boolean;
  /** O6: every provider this job ran under before `provider` (continueWith), so a review knows when no agent reviewing it is independent (gates/review.ts's chooseReviewer). */
  priorProviders?: Provider[];
  /** O9: what its runs cost, as the providers reported it (Claude Code in dollars, Codex in tokens), summed over its runs. */
  usage?: JobUsage;
  /** While its CLI retries against the provider (docs/Heads.md, "Waiting on the provider"): since when, how many retries, and what the provider said. Cleared when ordinary output resumes. */
  providerWait?: ProviderWait;
  /** The total time its runs spent waiting on the provider, in milliseconds, over every wait that ended, so a benchmark can subtract or flag it. */
  providerWaitMs?: number;
  /** O6 (docs/Heads.md, "Rigor"): a plan job's own rigor, added to the project's gate floor, never replacing it. Internal only: hydra_start_head's schema has no such field; only a plan sets it (planHeadInput). */
  rigor?: PlanRigor;
  /** The helper's own git worktree, created when it starts. */
  worktree?: string;
  baseCommit?: string;
  branch?: string;
  question?: string;
  replies: JobReply[];
  progress?: string;
  reason?: string;
  result?: JobResult;
  // ---- Plan lanes (docs/Plan_Lanes_Plan.md, "Heads that depend on a lane job") ----
  /**
   * Work it starts from besides its `dependsOn` heads: the results of the plan's lane
   * jobs it depends on. Set only by Hydra (HelperService.startForPlan), never from a
   * lead's call; kept with the job so a queued head keeps them across a restart.
   */
  inputs?: DependencyResult[];
  /**
   * O3: a previous try's commit, merged into this head's fresh worktree before it starts (a plan job re-queued
   * after a conflict on its integration branch). Set only by Hydra (HelperService.startForPlan).
   */
  carry?: string;
  // ---- Packs (docs/Packs_Plan.md, "Heads") ----
  /** The role it works in, from an active pack. Resolved again when it starts, from the pack's checked copy. */
  role?: JobRole;
  // ---- Hardening (Step 1) ----
  /**
   * 1.1: the gates in force when this head started (the same loader `hydra_done` otherwise uses),
   * so a head that edits or removes a gate from .hydra/gates.json mid-run can't weaken what checks
   * it — see gateFloor. Missing on jobs from before this change, and when gates.json couldn't be
   * read at start: hydra_done then falls back to today's config only, exactly as it always did.
   */
  gatesAtStart?: JobGatesSnapshot;
  /** 1.4: the git metadata fingerprint (gitMetaFingerprint) of the lead folder's shared .git when this head started. Compared again at hydra_done; a change refuses acceptance (a failed check, like a scope failure). */
  gitMetaAtStart?: GitMetaFingerprint;
  /** 1.6: hashes of .hydra/gates.json, checks.json and packs.json when this head started, for the tamper note on its result if any of them changed while it ran. */
  tamperAtStart?: TamperSnapshot;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  history: JobEvent[];
}
/**
 * An answer to a head's hydra_stuck. `auto` marks one Hydra gave itself (docs/Heads.md, "When nobody answers"):
 * `unattended` for a head in an unattended plan, answered at once; `no-answer` when the wait ended with no answer
 * (its time ran out, or the head's call ended). `question` is what it had asked, kept since the job's own clears.
 */
export interface JobReply { at: string; message: string; auto?: 'unattended' | 'no-answer'; question?: string }
/** A head's role: "coding/builder", with the titles it had when the head was started, for the views. */
export interface JobRole { ref: string; title: string; packTitle: string }

// ---- Hardening (Step 1) ----

/** 1.1: a head's gates at start (HelperService.startHelper), the same shape `loadGates`/`effectiveGates` return. */
export interface JobGatesSnapshot { gates: Gate[]; notRun: JobCheckResult[] }
/** 1.6: SHA-256 hex digests of the lead's .hydra files, or null when a file is missing. */
export interface TamperSnapshot { gatesJson: string | null; checksJson: string | null; packsJson: string | null }

/** Caps on a stored gates snapshot (1.1), matching packCaps.effectiveGates in src/core/packs/format.ts: a project's gates.json plus its packs together are capped at 24. */
const maxSnapshotGates = 24;
const maxSnapshotBytes = 256 * 1024;
const looksLikeGate = (value: unknown): value is { id: string; type: string } =>
  !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && gateIdPattern.test((value as { id: string }).id) && typeof (value as { type?: unknown }).type === 'string';
/**
 * A stored `gatesAtStart` snapshot, checked for shape and size only — the individual Gate and
 * JobCheckResult fields are Hydra's own output, not user input, so (as elsewhere in this file,
 * for example JobCheckResult on a loaded Job) they aren't re-validated field by field. A snapshot
 * that fails these caps is dropped rather than trusted: hydra_done then falls back to today's
 * gates only, exactly as it does for a job with no snapshot at all.
 */
function validateGatesSnapshot(value: unknown): JobGatesSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<JobGatesSnapshot>;
  const gates = Array.isArray(source.gates) ? source.gates : undefined;
  const notRun = source.notRun === undefined ? [] : Array.isArray(source.notRun) ? source.notRun : undefined;
  if (!gates || !notRun || gates.length > maxSnapshotGates || notRun.length > maxSnapshotGates) return undefined;
  if (!gates.every(looksLikeGate) || !notRun.every(looksLikeGate)) return undefined;
  try { if (Buffer.byteLength(JSON.stringify({ gates, notRun })) > maxSnapshotBytes) return undefined; } catch { return undefined; }
  return { gates: gates as Gate[], notRun: notRun as JobCheckResult[] };
}

/**
 * 1.1: the gates that actually run at hydra_done — the snapshot's
 * own definition for every gate id it already knew about (so a head that edits or deletes a gate
 * from .hydra/gates.json mid-run, or points its command somewhere weaker, can't change what runs
 * for that id), plus any gate in today's config whose id the snapshot never had (a gate — or a
 * newly turned-on pack's gate — added since the head started runs like any other). A gate that
 * was "not run" at start (an inactive pack) but is a real gate in today's config is exactly such
 * an addition, so it now runs too. `maxAttempts` always comes from today's config, never the
 * snapshot: Settings -> Gates changes apply to heads started after they're made, never mid-run.
 * With no snapshot (a job from before this change, or gates.json unreadable at start), today's
 * config is all there is, exactly as before Step 1.
 */
export function gateFloor(snapshot: JobGatesSnapshot | undefined, current: { gates: Gate[]; notRun?: JobCheckResult[] }): { gates: Gate[]; notRun: JobCheckResult[] } {
  if (!snapshot) return { gates: current.gates, notRun: current.notRun ?? [] };
  const known = new Set(snapshot.gates.map(gate => gate.id));
  const added = current.gates.filter(gate => !known.has(gate.id));
  const notRun = (current.notRun ?? []).filter(result => !known.has(result.id));
  return { gates: [...snapshot.gates, ...added], notRun };
}

const maxGitMetaEntries = 64, maxGitMetaKey = 300;
const hexDigest = /^[a-f0-9]{64}$/;
/** A stored `gitMetaAtStart` fingerprint (1.4): a plain map of relative path to a sha256 hex digest. */
function validateGitMeta(value: unknown): GitMetaFingerprint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxGitMetaEntries) return undefined;
  const result: Record<string, string> = {};
  for (const [name, digest] of entries) {
    if (typeof name !== 'string' || !name || name.length > maxGitMetaKey || typeof digest !== 'string' || !hexDigest.test(digest)) return undefined;
    result[name] = digest;
  }
  return result;
}

/** A stored `tamperAtStart` snapshot (1.6): three optional sha256 hex digests. */
function validateTamperSnapshot(value: unknown): TamperSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<Record<keyof TamperSnapshot, unknown>>;
  const field = (name: keyof TamperSnapshot) => source[name] === null ? null : typeof source[name] === 'string' && hexDigest.test(source[name] as string) ? source[name] as string : undefined;
  const gatesJson = field('gatesJson'), checksJson = field('checksJson'), packsJson = field('packsJson');
  if (gatesJson === undefined || checksJson === undefined || packsJson === undefined) return undefined;
  return { gatesJson, checksJson, packsJson };
}

export interface JobInput {
  title: string; brief: string; writeScope: string[];
  /** Missing: the role's agent, else Claude (HelperService decides; parseJobInput leaves it out when the lead did). */
  provider?: Provider;
  model?: string;
  dependsOn?: string[]; idempotencyKey: string; limits?: Partial<JobLimits>;
  /** Optional name for the chat that started it, shown on the Agents canvas. */
  leadLabel?: string;
  /** Internal only (HelperService.startForPlan): a plan's lane results it starts from. parseJobInput never sets it. */
  inputs?: DependencyResult[];
  /** A role's name as the lead or plan gave it: "builder", or "coding/builder". Checked against the active roles by HelperService. */
  role?: string;
  /** Internal only (HelperService): the role that name means. parseJobInput never sets it. */
  jobRole?: JobRole;
  /** Internal only (HelperService.headStartSnapshot, Step 1 hardening): never set by parseJobInput. */
  gatesAtStart?: JobGatesSnapshot;
  gitMetaAtStart?: GitMetaFingerprint;
  tamperAtStart?: TamperSnapshot;
  /** O6: internal only (HelperService.startForPlan reads it off the raw args); hydra_start_head's schema has no such field, so parseJobInput never sets it. */
  rigor?: PlanRigor;
  /** O3: internal only (HelperService.startForPlan); parseJobInput never sets it. */
  carry?: string;
}

const text = (value: unknown, name: string, max: number, min = 1): string => {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${name} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Error(`${name} must be ${min}–${max} characters.`);
  return trimmed;
};
const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** A write-scope entry: a repository-relative path, never absolute or escaping the repository. */
export function parseWriteScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('write_scope must list 1–32 repository paths.');
  const scope = value.map(item => {
    const entry = text(item, 'write_scope entry', 300).replace(/\\/g, '/');
    if (path.posix.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.split('/').includes('..')) throw new Error(`write_scope entry "${entry}" must stay inside the repository.`);
    return entry === '.' ? '' : entry.replace(/^\.\//, '');
  });
  return [...new Set(scope)];
}

/** Validate what a lead asked for. Everything the provider sends is untrusted. */
export function parseJobInput(value: unknown): JobInput {
  if (!value || typeof value !== 'object') throw new Error('Job input must be an object.');
  const source = value as Record<string, unknown>;
  // A head without a provider takes its role's (docs/Packs_Plan.md, "Heads"), so "not given" stays missing here.
  const provider = source.provider;
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') throw new Error('provider must be "claude" or "codex".');
  const role = source.role;
  if (role !== undefined && (typeof role !== 'string' || !/^(?:[a-z0-9-]{1,24}\/)?[a-z0-9-]{1,24}$/.test(role))) throw new Error('role must be a role\'s name, like "builder" or "coding/builder".');
  const dependsOn = source.depends_on ?? source.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.length > 16 || dependsOn.some(item => typeof item !== 'string' || !/^[a-f0-9]{12}$/.test(item))) throw new Error('depends_on must list job ids.');
  const limits = (source.limits && typeof source.limits === 'object' ? source.limits : {}) as Record<string, unknown>;
  return {
    title: text(source.title, 'title', 200),
    brief: text(source.brief, 'brief', maxBriefLength),
    writeScope: parseWriteScope(source.write_scope ?? source.writeScope),
    ...(provider ? { provider } : {}),
    ...(role ? { role } : {}),
    model: source.model === undefined ? undefined : text(source.model, 'model', 100),
    dependsOn: [...new Set(dependsOn as string[])],
    idempotencyKey: text(source.idempotency_key ?? source.idempotencyKey, 'idempotency_key', 200),
    leadLabel: source.lead_label === undefined ? undefined : text(source.lead_label, 'lead_label', 60),
    limits: {
      wallClockMs: limits.wall_clock_minutes === undefined ? undefined : clamp(Number(limits.wall_clock_minutes) * 60_000, defaultJobLimits.wallClockMs, 60_000, 4 * 3600_000),
      maxTurns: limits.max_turns === undefined ? undefined : clamp(limits.max_turns, defaultJobLimits.maxTurns, 1, 500),
      maxBudgetUsd: limits.max_budget_usd === undefined ? undefined : clamp(limits.max_budget_usd, defaultJobLimits.maxBudgetUsd, 0.1, 100),
    },
  };
}

interface StoreFile { version: 1; jobs: Job[] }

/**
 * The single writer of helper jobs for one workspace. Writes are serialized in
 * process and guarded across processes by a lock file whose owner pid is checked,
 * so a crashed writer never blocks the store for good.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date(), private readonly lockStaleMs = 30_000, private readonly getDefaultLimits: () => JobLimits = () => defaultJobLimits) {}
  get file(): string { return path.join(this.directory, 'jobs.json'); }
  private get lockFile(): string { return `${this.file}.lock`; }

  /** Load the store. A job that was starting, running or checking when Hydra stopped has lost its helper process, so it is failed with the reason. */
  async load(): Promise<Job[]> {
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      let parsed: StoreFile = { version: 1, jobs: [] };
      try { parsed = parseStoreFile(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Hydra head jobs could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      this.jobs = new Map(parsed.jobs.map(job => [job.id, job]));
      this.loaded = true;
      let changed = false;
      for (const job of this.jobs.values()) {
        if (job.state === 'starting' || job.state === 'running' || job.state === 'checking') { this.apply(job, 'failed', 'Hydra stopped while this head was running.'); changed = true; }
        // No head process survives a restart, so no wait on its provider does either; the total it waited stays.
        if (job.providerWait) { delete job.providerWait; changed = true; }
      }
      if (changed) await this.write();
      return this.list();
    });
  }

  list(leadKey?: string): Job[] { return [...this.jobs.values()].filter(job => !leadKey || job.leadKey === leadKey).map(job => structuredClone(job)); }
  get(id: string): Job | undefined { const job = this.jobs.get(id); return job && structuredClone(job); }

  /** Create a job, or return the existing one for a repeated idempotency key from the same lead. */
  async create(leadKey: string, input: JobInput, lead?: Omit<JobLead, 'label'>): Promise<{ job: Job; created: boolean }> {
    return this.serialize(async () => {
      this.assertLoaded();
      const existing = [...this.jobs.values()].find(job => job.leadKey === leadKey && job.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: structuredClone(existing), created: false };
      for (const dependency of input.dependsOn || []) {
        const found = this.jobs.get(dependency);
        if (!found || found.leadKey !== leadKey) throw new Error(`depends_on names an unknown job: ${dependency}.`);
      }
      const at = this.now().toISOString();
      let id: string; do { id = randomBytes(6).toString('hex'); } while (this.jobs.has(id));
      const limits = { ...this.getDefaultLimits(), ...Object.fromEntries(Object.entries(input.limits || {}).filter(([, value]) => value !== undefined)) } as JobLimits;
      const job: Job = {
        version: 1, id, leadKey, ...(lead ? { lead: { ...lead, ...(input.leadLabel ? { label: input.leadLabel } : {}) } } : {}),
        idempotencyKey: input.idempotencyKey, title: input.title, brief: input.brief, writeScope: input.writeScope,
        provider: input.provider ?? 'claude', model: input.model, dependsOn: input.dependsOn || [], state: 'queued', limits, attempts: 0, maxAttempts: defaultMaxAttempts, nudged: false,
        ...(input.inputs?.length ? { inputs: structuredClone(input.inputs) } : {}),
        ...(input.jobRole ? { role: { ref: input.jobRole.ref, title: input.jobRole.title, packTitle: input.jobRole.packTitle } } : {}),
        ...(input.gatesAtStart ? { gatesAtStart: structuredClone(input.gatesAtStart) } : {}),
        ...(input.gitMetaAtStart ? { gitMetaAtStart: structuredClone(input.gitMetaAtStart) } : {}),
        ...(input.tamperAtStart ? { tamperAtStart: structuredClone(input.tamperAtStart) } : {}),
        ...(input.rigor ? { rigor: input.rigor } : {}),
        ...(input.carry ? { carry: input.carry } : {}),
        replies: [], createdAt: at, updatedAt: at, history: [{ at, from: null, to: 'queued' }],
      };
      this.jobs.set(id, job);
      try { await this.write(); } catch (error) { this.jobs.delete(id); throw error; }
      return { job: structuredClone(job), created: true };
    });
  }

  /** Move a job to another state. Refused unless the table allows it. */
  async transition(id: string, to: JobState, reason?: string, patch: Partial<Omit<Job, 'id' | 'version' | 'leadKey' | 'state' | 'history'>> = {}): Promise<Job> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Unknown head job ${id}.`);
      if (!canTransition(job.state, to)) throw new Error(`Head job ${id} cannot go from ${job.state} to ${to}.`);
      const previous = structuredClone(job);
      Object.assign(job, patch);
      this.apply(job, to, reason);
      try { await this.write(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return structuredClone(job);
    });
  }

  /** Change fields that don't change state (progress, replies, worktree). Refused once a job is final. */
  /** O9: adds a run's reported usage, whatever the job's state (a run's process usually exits after its job has finished). */
  async recordUsage(id: string, run: RunUsage | undefined): Promise<void> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      const usage = job && addUsage(job.usage, run);
      if (!job || !usage || usage === job.usage) return;
      const previous = job.usage;
      job.usage = usage;
      try { await this.write(); } catch (error) { if (previous) job.usage = previous; else delete job.usage; throw error; }
    });
  }
  /**
   * A head's wait on its provider (docs/Heads.md, "Waiting on the provider"): `wait` while it's open,
   * undefined once it ends, adding `waitedMs` to the job's total. Whatever the job's state, like recordUsage,
   * since the run's last wait can end as its process exits.
   */
  async recordProviderWait(id: string, wait: ProviderWait | undefined, waitedMs = 0): Promise<void> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      if (!job) return;
      const added = Number.isFinite(waitedMs) && waitedMs > 0 ? Math.round(waitedMs) : 0;
      // A late notice from a run whose job has already moved on opens nothing.
      if (wait && job.state !== 'running') wait = undefined;
      if (!wait && !job.providerWait && !added) return;
      const previous = { wait: job.providerWait, ms: job.providerWaitMs };
      if (wait) job.providerWait = wait; else delete job.providerWait;
      if (added) job.providerWaitMs = (job.providerWaitMs ?? 0) + added;
      try { await this.write(); } catch (error) {
        if (previous.wait) job.providerWait = previous.wait; else delete job.providerWait;
        if (previous.ms !== undefined) job.providerWaitMs = previous.ms; else delete job.providerWaitMs;
        throw error;
      }
    });
  }
  async update(id: string, patch: Partial<Pick<Job, 'progress' | 'replies' | 'worktree' | 'baseCommit' | 'branch' | 'question' | 'nudged' | 'attempts' | 'maxAttempts'>>): Promise<Job> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Unknown head job ${id}.`);
      if (finalJobStates.has(job.state)) throw new Error(`Head job ${id} is ${job.state}.`);
      const previous = structuredClone(job);
      Object.assign(job, patch, { updatedAt: this.now().toISOString() });
      try { await this.write(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return structuredClone(job);
    });
  }

  /**
   * Give up on a head that failed on a usage limit (docs/Plan_Lanes_Plan.md, decision 7):
   * heads queued behind it wait while `limitHit` is set, so Continue in can still save
   * them; clearing it lets them fail. The job stays failed, with the reason in its history.
   */
  async releaseLimit(id: string, reason: string): Promise<Job> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Unknown head job ${id}.`);
      if (job.state !== 'failed' || !job.limitHit) return structuredClone(job);
      const previous = structuredClone(job);
      const at = this.now().toISOString();
      job.limitHit = false; job.updatedAt = at;
      job.history.push({ at, from: 'failed', to: 'failed', reason });
      if (job.history.length > 200) job.history.splice(0, job.history.length - 200);
      try { await this.write(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return structuredClone(job);
    });
  }

  private apply(job: Job, to: JobState, reason?: string): void {
    const at = this.now().toISOString();
    job.history.push({ at, from: job.state, to, ...(reason ? { reason } : {}) });
    if (job.history.length > 200) job.history.splice(0, job.history.length - 200);
    if (to === 'running' && !job.startedAt) job.startedAt = at;
    if (finalJobStates.has(to)) job.finishedAt = at;
    job.state = to; job.updatedAt = at;
    // A wait on the provider belongs to one running process: any other state ends it (its total, providerWaitMs, stays).
    if (to !== 'running') delete job.providerWait;
    if (reason !== undefined || finalJobStates.has(to)) job.reason = reason;
  }
  private assertLoaded(): void { if (!this.loaded) throw new Error('Hydra head jobs are not loaded yet.'); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async write(): Promise<void> {
    await this.withLock(async () => {
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      const body: StoreFile = { version: 1, jobs: [...this.jobs.values()] };
      await writeFile(temporary, JSON.stringify(body, null, 1), { encoding: 'utf8', mode: 0o600 });
      try { await replaceAtomic(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
    });
  }
  /** Cross-process guard. A lock whose owner is gone, or older than the stale limit, is removed. */
  private async withLock(work: () => Promise<void>): Promise<void> {
    const token = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() })); } finally { await handle.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.clearStaleLock()) continue;
        if (attempt >= 100) throw new Error('Hydra head jobs are locked by another Hydra window.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { await work(); }
    finally {
      try { const owner = JSON.parse(await readFile(this.lockFile, 'utf8')); if (owner.token === token) await rm(this.lockFile, { force: true }); } catch { /* already gone */ }
    }
  }
  private async clearStaleLock(): Promise<boolean> {
    let owner: { pid?: number; at?: number };
    try { owner = JSON.parse(await readFile(this.lockFile, 'utf8')); } catch { owner = {}; }
    const alive = typeof owner.pid === 'number' && processAlive(owner.pid);
    const old = typeof owner.at !== 'number' || Date.now() - owner.at > this.lockStaleMs;
    if (alive && !old) return false;
    await rm(this.lockFile, { force: true });
    return true;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

// ---- O9: what a head's runs cost ----

/** One run's usage, as its CLI reported it: Claude Code's `total_cost_usd`, Codex's token counts. */
export interface RunUsage { costUsd?: number; inputTokens?: number; outputTokens?: number }
/** A job's usage over all its runs. `runs` counts the runs that reported anything. */
export interface JobUsage extends RunUsage { runs: number }
const usageNumber = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
/** Adds one run's usage (pure). A run that reported nothing changes nothing. */
export function addUsage(current: JobUsage | undefined, run: RunUsage | undefined): JobUsage | undefined {
  const cost = usageNumber(run?.costUsd, 1e6) ? run!.costUsd : undefined;
  const input = usageNumber(run?.inputTokens, 1e12) ? run!.inputTokens : undefined;
  const output = usageNumber(run?.outputTokens, 1e12) ? run!.outputTokens : undefined;
  if (cost === undefined && input === undefined && output === undefined) return current;
  const sum = (a: number | undefined, b: number | undefined) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const costUsd = sum(current?.costUsd, cost), inputTokens = sum(current?.inputTokens, input), outputTokens = sum(current?.outputTokens, output);
  return { runs: (current?.runs ?? 0) + 1, ...(costUsd !== undefined ? { costUsd: Math.round(costUsd * 1e6) / 1e6 } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
}
function validateUsage(value: unknown): JobUsage | undefined {
  const usage = value as Partial<JobUsage> | undefined;
  if (!usage || typeof usage !== 'object' || !Number.isInteger(usage.runs) || usage.runs! < 1 || usage.runs! > 10_000) return undefined;
  if (usage.costUsd !== undefined && !usageNumber(usage.costUsd, 1e6)) return undefined;
  if (usage.inputTokens !== undefined && !usageNumber(usage.inputTokens, 1e12)) return undefined;
  if (usage.outputTokens !== undefined && !usageNumber(usage.outputTokens, 1e12)) return undefined;
  return { runs: usage.runs!, ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}), ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}) };
}

function parseStoreFile(value: unknown): StoreFile {
  const source = value as Partial<StoreFile>;
  if (!source || source.version !== 1 || !Array.isArray(source.jobs)) throw new Error('Unsupported head job store.');
  for (const job of source.jobs) {
    if (!job || job.version !== 1 || typeof job.id !== 'string' || !/^[a-f0-9]{12}$/.test(job.id) || !jobStates.includes(job.state) || !Array.isArray(job.history)) throw new Error('A stored head job is malformed.');
    // Step 1 hardening: capped, shape-checked rather than trusted outright. An invalid or
    // oversized snapshot is dropped (never thrown on), so a corrupted jobs.json still loads and
    // that one job simply behaves as though it had no snapshot.
    (job as Job).gatesAtStart = validateGatesSnapshot((job as Job).gatesAtStart);
    (job as Job).gitMetaAtStart = validateGitMeta((job as Job).gitMetaAtStart);
    (job as Job).tamperAtStart = validateTamperSnapshot((job as Job).tamperAtStart);
    const usage = validateUsage((job as Job).usage);
    if (usage) (job as Job).usage = usage; else delete (job as Job).usage;
    const wait = validateProviderWait((job as Job).providerWait);
    if (wait) (job as Job).providerWait = wait; else delete (job as Job).providerWait;
    const waitedMs = (job as Job).providerWaitMs;
    if (!(typeof waitedMs === 'number' && Number.isFinite(waitedMs) && waitedMs > 0 && waitedMs < 1e12)) delete (job as Job).providerWaitMs;
  }
  return { version: 1, jobs: source.jobs };
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { git, gitMetaChanges, gitMetaFingerprint, type GitMetaFingerprint } from './git';
import { isWindowsShim } from './process';
import { headEnvironment, headSettings, storageReadDeny, type HeadShell } from './confine';
import { otherWorktrees, storageListing } from './confineFiles';
import type { CommandSandbox } from './headSandbox';
import { roleLaunch, type RoleLaunch, type RoleSource } from './packs/launch';
import { createWorktree } from './worktrees';
import { defaultMaxAttempts, evidenceStatus, finalJobStates, gateBlocks, gateFloor, gateKind, gatesConfigured, gateState, maxBriefLength, parseJobInput, type Job, type JobCheckResult, type JobGatesSnapshot, type JobStore, type TamperSnapshot } from './jobs';
import { freshDirectory, gateFailureMessage, loadGates, runGateList, type GateContext, type GateRuntime, type GatesConfig, type GatesLoader } from './gates';
import { dependencyBase, dependencyBrief, dependencyNoun, type DependencyResult } from './headStart';
import type { HelperCaller, HelperEndpoint } from './helperEndpoint';
import type { HeadConfinement, HelperRun, StartHelperRun } from './helperRunner';
import type { Provider } from './model';
import { headLimitReason } from './limitDetection';
import type { LimitEvent } from './limitEvents';
import { continuedHistoryReason } from './limitOffer';
import type { StopSwitch } from './stopSwitch';
import type { AuditEvent } from './audit';

/**
 * Hydra helpers, end to end (docs/Official_Extensions_Plan.md, Phases 4 and 6).
 * Every action from the endpoint lands here. Hydra's code, not a model, drives the
 * chain: start the helper, enforce its limits, check its work when it reports, and
 * hand the result back to the lead through hydra_wait_for_heads.
 */
export { loadHelperChecks, type HelperCheck } from './gates';
export interface HelperServiceOptions {
  store: JobStore;
  endpoint: Pick<HelperEndpoint, 'issue' | 'revokeJob' | 'port'>;
  /** The window's folder: the lead's working copy. Helpers branch from its HEAD, and its .hydra/gates.json (or checks.json) is used. */
  leadFolder: string;
  leadKey: string;
  worktreeRoot?: () => string | undefined;
  startRun: StartHelperRun;
  /** The provider CLI to run, already version-checked; throws a clear reason if unusable. */
  executable: (provider: Provider) => Promise<string>;
  /** How a CLI starts the bridge (Hydra's executable as Node plus dist/hydra-mcp.cjs). */
  bridge: { command: string; args: string[]; env?: Record<string, string> };
  logDirectory: string;
  maxConcurrent: () => number;
  onChange?: () => void;
  log?: (line: string) => void;
  now?: () => number;
  watchdogMs?: number;
  /**
   * This window's lanes (docs/Lanes_And_Planner_Plan.md): the hydra_lanes answer,
   * and the name a lane's heads are labelled with.
   */
  lanes?: {
    describe(you?: string): Promise<unknown>; name(id: string): string | undefined;
    /** An open lane's worktree: a head started from a lane branches from the lane's HEAD (docs/Gates_Plan.md, section 3). */
    worktree?(id: string): string | undefined;
    /** hydra_job_ready from a lane that runs a plan job (docs/Plan_Lanes_Plan.md, decision 6): ask the user to mark it done. */
    jobReady?(laneId: string, note?: string): Promise<unknown>;
  };
  /** Gates (docs/Gates_Plan.md): whether a provider is at its usage limit now, so a review uses the other one. */
  providerLimited?: (provider: Provider) => boolean;
  /** Gates: test seams for the reviewer, the browser and the clock. */
  gateRuntime?: Partial<GateRuntime>;
  // ---- Packs (docs/Packs_Plan.md) ----
  /** Where a folder's gates come from: gates.json plus the active packs' gates (PackService.gates). Defaults to gates.json only. */
  gates?: GatesLoader;
  /** The active packs' roles (PackService). Without it, no head has a role and a head that names one is refused. */
  roles?: RoleSource;
  // ---- Step 2 (docs/Hydra_Improvements.md): confining heads ----
  /**
   * Codex's sandbox for Claude heads' shells and for gate commands (HeadSandbox). Without it, a
   * Claude head has no shell and gate commands run as before.
   */
  sandbox?: { shell(): Promise<HeadShell> } & CommandSandbox;
  /** Hydra's global storage: a Claude head writes none of it and reads none of it but its role's pack copy. Defaults to the log directory, which holds its settings file. */
  hydraStorage?: string;
  /** Where each head's own TEMP folder goes. Defaults to `temp` beside the log directory. */
  tempDirectory?: string;
  // ---- 5.3 (docs/Hydra_Improvements.md): Stop All Agents ----
  /** Without it, heads never refuse to start and dispatch always runs (as before 5.3). */
  stop?: StopSwitch;
  // ---- 5.2 (docs/Hydra_Improvements.md): the audit log ----
  /** Without it, a head cancelled and a hydra_done refused for changed git settings aren't recorded. */
  audit?: (event: AuditEvent) => void;
}

interface Active {
  run: HelperRun; token: string; startedAt: number; blockedSince?: number; blockedTotal: number; answer?: (reply: string) => void;
  /** Packs: the role it started with, for `changes`. */
  role?: RoleLaunch;
  /** Packs: the Claude head's `--mcp-config` file for its role's servers, removed when the head ends. */
  mcpConfigFile?: string;
  /** Step 2: the Claude head's `--settings` file and the head's own TEMP folder, both removed when it ends. */
  settingsFile?: string;
  temp?: string;
  /** Step 2: why a Claude head had no shell, for its result. */
  shellNote?: string;
}
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

export class HelperService {
  private readonly active = new Map<string, Active>();
  /** Every process Hydra started for a helper or its checks. None of them, or their children, may act as a lead. */
  private readonly helperPids = new Set<number>();
  private readonly waiters = new Set<() => void>();
  private readonly merged = new Set<string>();
  private readonly limitListeners = new Set<(event: LimitEvent) => void>();
  private dispatching = false;
  private dispatchAgain = false;
  private dispatchRun: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  constructor(private readonly options: HelperServiceOptions) {
    this.now = options.now || Date.now;
    this.watchdog = setInterval(() => { void this.enforceLimits(); void this.refreshMerged(); }, options.watchdogMs ?? 5000);
    this.watchdog.unref?.();
  }

  /** After a restart no helper process survives, so a helper that was waiting for an answer can't continue. */
  async recover(): Promise<void> {
    for (const job of this.options.store.list(this.options.leadKey)) {
      if (job.state === 'blocked') await this.options.store.transition(job.id, 'failed', 'Hydra restarted while this head was waiting for an answer.').catch(() => {});
    }
    this.changed();
    void this.dispatch();
  }

  /** The endpoint handler. */
  async handle(caller: HelperCaller, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (caller.leadKey !== this.options.leadKey) throw new Error('This Hydra window does not own that caller.');
    if (caller.role === 'lead') {
      switch (tool) {
        case 'hydra_start_head': return this.startHelper(args, caller);
        case 'hydra_wait_for_heads': return this.waitForHelpers(args, signal);
        case 'hydra_get_head': return this.describe(this.ownJob(args.job_id), true);
        case 'hydra_list_heads': return { heads: this.options.store.list(this.options.leadKey).map(job => this.describe(job, false)) };
        case 'hydra_reply_to_head': return this.reply(args);
        case 'hydra_cancel_head': return this.cancel(this.ownJob(args.job_id).id, typeof args.reason === 'string' ? clip(args.reason, 500) : 'Cancelled by the lead.');
        case 'hydra_lanes':
          if (!this.options.lanes) throw new Error('Lanes are not available in this Hydra window.');
          return this.options.lanes.describe(caller.lane);
        // Packs (docs/Packs_Plan.md, decision 6): a lead's bridge asks once, for its instructions and hydra_start_head's `role`.
        case 'hydra_active_roles': return { roles: await this.activeRoles() };
        // ---- Plan lanes (docs/Plan_Lanes_Plan.md, decision 6): a lane's agent asks the user; it never marks the job itself ----
        case 'hydra_job_ready': {
          if (!caller.lane || !this.options.lanes?.jobReady) throw new Error('hydra_job_ready works only in a Hydra lane that runs a plan job.');
          const note = args.note;
          if (note !== undefined && (typeof note !== 'string' || note.length > 2000 || note.includes('\0'))) throw new Error('note must be text of at most 2000 characters.');
          return this.options.lanes.jobReady(caller.lane, typeof note === 'string' && note.trim() ? note.trim() : undefined);
        }
      }
    } else {
      const jobId = caller.jobId!;
      switch (tool) {
        case 'hydra_done': return this.done(jobId, args, signal);
        case 'hydra_stuck': return this.stuck(jobId, args, signal);
        case 'hydra_progress': return this.progress(jobId, args);
      }
    }
    throw new Error(`Unknown Hydra action ${tool}.`);
  }

  list(): Job[] { return this.options.store.list(this.options.leadKey); }
  /** A finished head whose commit is already in the lead folder's HEAD: the lead merged it. */
  isMerged(id: string): boolean { return this.merged.has(id); }
  /**
   * Check finished heads against the lead folder's HEAD. Cheap (one git call per
   * unmerged done head) and run with the watchdog, so a merge shows up within seconds.
   */
  async refreshMerged(): Promise<void> {
    let changed = false;
    for (const job of this.list()) {
      if (job.state !== 'done' || !job.result?.commit || this.merged.has(job.id)) continue;
      try { await git(this.options.leadFolder, ['merge-base', '--is-ancestor', job.result.commit, 'HEAD']); this.merged.add(job.id); changed = true; }
      catch { /* not merged yet, or the commit is gone */ }
    }
    if (changed) this.changed();
  }
  helperProcessIds(): ReadonlySet<number> { return this.helperPids; }
  /** A head stopped because its provider hit a usage limit. */
  onLimit(listener: (event: LimitEvent) => void): { dispose(): void } {
    this.limitListeners.add(listener);
    return { dispose: () => { this.limitListeners.delete(listener); } };
  }
  get leadFolder(): string { return this.options.leadFolder; }

  async stopAll(reason = 'Stopped with "Stop all heads".'): Promise<number> {
    const open = this.list().filter(job => !finalJobStates.has(job.state));
    await Promise.all(open.map(job => this.cancel(job.id, reason).catch(() => undefined)));
    return open.length;
  }

  /** Window closing: stop every helper and record why. */
  async dispose(): Promise<void> {
    this.disposed = true; clearInterval(this.watchdog);
    await this.dispatchRun.catch(() => undefined);
    const files = [...this.active.values()].flatMap(active => [active.mcpConfigFile, active.settingsFile, active.temp].filter((file): file is string => !!file));
    await Promise.all([...this.active.keys()].map(id => this.finish(id, 'failed', 'The Hydra window closed while this head was running.').catch(() => undefined)));
    await Promise.all(files.map(file => rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)));
    for (const job of this.list()) if (job.state === 'queued') await this.options.store.transition(job.id, 'failed', 'The Hydra window closed before this head started.').catch(() => undefined);
    this.changed();
  }

  // ---- lead actions ----

  // ---- Plan lanes (docs/Plan_Lanes_Plan.md, "Heads that depend on a lane job") ----
  /**
   * Start a plan job's head: the same arguments as a lead's hydra_start_head, under
   * the plan's lead (`plan-<id>`), plus `inputs`, the results of the lane jobs it
   * depends on. Only Hydra passes inputs; a lead's call never can.
   */
  async startForPlan(args: Record<string, unknown>, leadSessionId: string, inputs: readonly DependencyResult[] = [], defaultProvider?: Provider) {
    if (inputs.length > 16 || inputs.some(input => !isDependencyResult(input))) throw new Error('A plan head\'s inputs are malformed.');
    return this.startHelper(args, { role: 'lead', leadKey: this.options.leadKey, leadSessionId }, inputs, defaultProvider);
  }

  /**
   * Start a head. Its provider is the one asked for, else its role's (docs/Packs_Plan.md, "Heads"),
   * else `defaultProvider` (a plan's hydra.defaultProvider), else Claude. A role must be active now;
   * it is resolved again from its pack's checked copy when the head starts.
   */
  private async startHelper(args: Record<string, unknown>, caller?: HelperCaller, inputs: readonly DependencyResult[] = [], defaultProvider?: Provider) {
    this.options.stop?.assertRunning('Starting a head');
    const parsed = parseJobInput(args);
    const open = this.list().filter(job => !finalJobStates.has(job.state)).length;
    if (open >= 16) throw new Error('This window already has 16 unfinished heads. Wait for some to finish or cancel them.');
    const repeat = this.list().find(existing => existing.idempotencyKey === parsed.idempotencyKey);
    const role = parsed.role && !repeat ? await this.pickRole(parsed.role) : undefined;
    const input = { ...parsed, provider: parsed.provider ?? role?.provider ?? defaultProvider ?? 'claude', ...(role ? { jobRole: { ref: role.ref, title: role.title, packTitle: role.packTitle } } : {}) };
    // A head started from a lane is grouped under it, labelled with the lane's name, and
    // branches from the lane's HEAD rather than the main checkout's (docs/Gates_Plan.md, section 3).
    const laneName = caller?.lane ? this.options.lanes?.name(caller.lane) : undefined;
    const laneWorktree = caller?.lane && laneName ? this.options.lanes?.worktree?.(caller.lane) : undefined;
    const from = laneWorktree ?? this.options.leadFolder;
    const head = (await git(from, ['rev-parse', 'HEAD'])).trim();
    const dirty = (await git(from, ['status', '--porcelain=v1', '--untracked-files=no'])).trim();
    const lead = caller?.leadSessionId ? { sessionId: caller.leadSessionId, ...(caller.provider ? { provider: caller.provider } : {}), ...(laneName ? { lane: caller.lane } : {}) } : undefined;
    // A plan head that depends only on lane jobs starts from their results, which never move, so its
    // base is known now: hydra_get_head shows it at once, and results that conflict refuse the start.
    const inputBase = inputs.length && !input.dependsOn?.length && !repeat ? await dependencyBase(this.options.leadFolder, input.title, inputs) : undefined;
    const withInputs = inputs.length ? { ...input, inputs: [...inputs] } : input;
    // Step 1 hardening (docs/Hydra_Improvements.md): a snapshot of the gates, the git metadata and
    // the .hydra files a repeated idempotency key would reuse an existing job for anyway, so it's
    // skipped there — `store.create` returns that job untouched before looking at these fields.
    const snapshot = repeat ? {} : await this.headStartSnapshot();
    const { job, created } = await this.options.store.create(this.options.leadKey, lead && laneName ? { ...withInputs, leadLabel: laneName, ...snapshot } : { ...withInputs, ...snapshot }, lead);
    // A dependent starts from what it waits for, so its base is known only when it starts.
    const dependent = job.dependsOn.length > 0 || !!job.inputs?.length;
    if (created && (!dependent || inputBase)) await this.options.store.update(job.id, { baseCommit: inputBase ?? head });
    this.changed();
    void this.dispatch();
    const base = created ? (dependent ? inputBase : head) : this.options.store.get(job.id)?.baseCommit;
    return {
      job_id: job.id, state: job.state, created, provider: job.provider,
      ...(job.role ? { role: job.role.ref } : {}),
      ...(base ? { base_commit: base } : {}),
      ...(dependent && !base ? { starts_from: `The result of the ${job.inputs?.length ? 'jobs' : 'heads'} it depends on, merged if there are several. hydra_get_head shows its base_commit once it starts.` } : {}),
      ...(created && dirty ? { warning: laneWorktree
        ? 'Your lane has uncommitted changes. The head starts from the lane\'s last commit and will not see them; commit first if it needs them.'
        : 'Your folder has uncommitted changes. The head starts from the last commit and will not see them; commit first if it needs them.' } : {}),
    };
  }

  // ---- Step 1 hardening (docs/Hydra_Improvements.md) ----

  /**
   * What a fresh head's job record carries from the moment it's created, so its later `hydra_done`
   * can't be talked down by changes the head itself makes to the lead's `.hydra` files or to git's
   * shared metadata: 1.1's gates snapshot, 1.4's git metadata fingerprint and 1.6's file hashes.
   * Each piece is best-effort and independent: one failing (an unreadable gates.json, a repository
   * with no git yet) never stops the others, and simply leaves that one check off for this head,
   * exactly as if Step 1 hadn't run for it.
   */
  private async headStartSnapshot(): Promise<{ gatesAtStart?: JobGatesSnapshot; gitMetaAtStart?: GitMetaFingerprint; tamperAtStart?: TamperSnapshot }> {
    const snapshot: { gatesAtStart?: JobGatesSnapshot; gitMetaAtStart?: GitMetaFingerprint; tamperAtStart?: TamperSnapshot } = {};
    try {
      const gates: Awaited<ReturnType<GatesLoader>> = await (this.options.gates ?? loadGates)(this.options.leadFolder);
      snapshot.gatesAtStart = { gates: gates.gates, notRun: gates.notRun ?? [] };
    } catch { /* no snapshot: hydra_done falls back to today's config only, as it always has */ }
    try { snapshot.gitMetaAtStart = await gitMetaFingerprint(this.options.leadFolder); } catch { /* best effort: no git-metadata check for this head */ }
    try { snapshot.tamperAtStart = await hydraFileHashes(this.options.leadFolder); } catch { /* best effort: no tamper note for this head */ }
    return snapshot;
  }

  /** 1.6: whether any of .hydra/gates.json, checks.json or packs.json changed since this head started. */
  private async tamperNote(job: Job): Promise<string | undefined> {
    if (!job.tamperAtStart) return undefined;
    let now: TamperSnapshot;
    try { now = await hydraFileHashes(this.options.leadFolder); } catch { return undefined; }
    const changed = now.gatesJson !== job.tamperAtStart.gatesJson || now.checksJson !== job.tamperAtStart.checksJson || now.packsJson !== job.tamperAtStart.packsJson;
    return changed ? 'The project\'s gates changed while this head ran; the gates from its start still ran.' : undefined;
  }

  // ---- Packs (docs/Packs_Plan.md, "Heads") ----

  /** The active roles as a lead's bridge hears of them. None without packs, or when packs.json can't be read. */
  private async activeRoles() {
    const roles = await this.options.roles?.roles(this.options.leadFolder).catch(error => { this.options.log?.(`[heads] roles: ${error instanceof Error ? error.message : String(error)}`); return []; }) ?? [];
    return roles.map(role => ({ name: role.name, title: role.title, packTitle: role.packTitle, description: role.description, provider: role.provider }));
  }
  /** The active role a lead or a plan named, or why it can't be used, listing the active roles. */
  private async pickRole(name: string) {
    if (!this.options.roles) throw new Error(`There's no active role "${name}": packs aren't available in this Hydra window.`);
    return this.options.roles.pick(this.options.leadFolder, name);
  }

  private async waitForHelpers(args: Record<string, unknown>, signal: AbortSignal) {
    const ids = args.job_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16) throw new Error('job_ids must list 1–16 head job ids.');
    const jobs = ids.map(id => this.ownJob(id));
    const maxWait = Math.max(1, Math.min(3000, typeof args.max_wait_s === 'number' ? args.max_wait_s : 1800)) * 1000;
    const settled = () => jobs.every(job => { const current = this.options.store.get(job.id)!; return finalJobStates.has(current.state) || current.state === 'blocked'; });
    const deadline = this.now() + maxWait;
    while (!settled() && !signal.aborted && this.now() < deadline) {
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, Math.min(5000, Math.max(1, deadline - this.now())));
        this.waiters.add(wake); signal.addEventListener('abort', wake, { once: true });
      });
    }
    const current = jobs.map(job => this.describe(this.options.store.get(job.id)!, true));
    return { all_settled: settled(), heads: current };
  }

  private async reply(args: Record<string, unknown>) {
    const job = this.ownJob(args.job_id);
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 8000) throw new Error('message must be 1–8000 characters.');
    const active = this.active.get(job.id);
    if (job.state !== 'blocked' || !active?.answer) throw new Error(`Head ${job.id} is not waiting for an answer (it is ${job.state}).`);
    await this.options.store.update(job.id, { replies: [...job.replies, { at: new Date(this.now()).toISOString(), message: args.message }] });
    active.answer(args.message);
    return { job_id: job.id, delivered: true };
  }

  private async cancel(id: string, reason: string) {
    const job = this.options.store.get(id)!;
    if (finalJobStates.has(job.state)) {
      // A head held on a usage limit (decision 7): cancelling it gives up on it, so heads waiting on it fail.
      if (job.state === 'failed' && job.limitHit) { await this.options.store.releaseLimit(id, reason); this.changed(); void this.dispatch(); }
      return { job_id: id, state: job.state };
    }
    if (this.active.has(id)) await this.finish(id, 'cancelled', reason);
    else await this.options.store.transition(id, 'cancelled', reason);
    // 5.2: a head cancelled (a stop), including each one Stop All Agents cancels through stopAll.
    this.options.audit?.({ kind: 'stop', what: 'head cancelled', detail: reason, jobId: id });
    this.changed();
    void this.dispatch();
    return { job_id: id, state: 'cancelled' };
  }

  // ---- helper actions ----

  private async done(jobId: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const job = this.options.store.get(jobId);
    if (!job || job.state !== 'running') throw new Error(`This head can't report done while it is ${job?.state ?? 'unknown'}.`);
    if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('summary is required.');
    const summary = clip(args.summary.trim(), 8000);
    const worktree = job.worktree!, base = job.baseCommit!;
    // Hydra commits whatever the helper left uncommitted: in Codex's Windows sandbox a head can't
    // write its worktree's .git metadata, so it can't commit (R4). Hydra's own git calls in the head's
    // worktree run with hooks off (Step 2): a hook the head edited (a husky script, say) would otherwise
    // run as Hydra, outside any sandbox.
    await mkdir(this.tempRoot, { recursive: true });
    const hooksOff = await mkdtemp(path.join(this.tempRoot, 'nh-'));
    try {
      if ((await git(worktree, [...noHooks(hooksOff), 'status', '--porcelain=v1', '--untracked-files=all'])).trim()) await commitAll(worktree, `${job.title} (Hydra head ${job.id})`, hooksOff);
    } finally { await rm(hooksOff, { recursive: true, force: true }).catch(() => undefined); }
    const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
    if (commit === base) {
      // A role with changes "optional" (a reviewer, a fact-checker) may finish without changing
      // anything: its summary is the result, and with nothing to check no gate runs.
      if (this.active.get(jobId)?.role?.changes !== 'optional') return { accepted: false, message: 'You have not changed anything yet. Make the changes, then call hydra_done again.' };
      await this.options.store.transition(jobId, 'checking');
      await this.options.store.transition(jobId, 'done', undefined, { result: { summary, commit, changedFiles: [], checks: [] } });
      this.changed();
      return { accepted: true, message: 'Accepted: you changed nothing, so your summary is the result. Stop now.' };
    }
    // Gates come from the lead's folder, never the head's worktree. A gates file Hydra can't
    // read is the project's problem, not the head's: no attempt is spent on it.
    let gates: Awaited<ReturnType<GatesLoader>>;
    try { gates = await (this.options.gates ?? loadGates)(this.options.leadFolder); }
    catch (error) { return { accepted: false, message: `Hydra can't check your work: ${error instanceof Error ? error.message : String(error)} That isn't your fault. Call hydra_stuck and ask the lead to fix it, then call hydra_done again.` }; }
    // 1.1: maxAttempts always comes from today's config, never the start-of-run snapshot below —
    // Settings -> Gates changes apply to heads started after they're made, never mid-run.
    const maxAttempts = gates.maxAttempts ?? defaultMaxAttempts;
    // 1.6's tamper note, and Step 2's reason a Claude head had no shell (design 7: said in the head's result).
    const note = [await this.tamperNote(job), this.active.get(jobId)?.shellNote].filter(Boolean).join(' ') || undefined;
    const changedFiles = (await git(worktree, ['diff', '--name-only', '-z', '--no-renames', base, commit, '--'])).split('\0').filter(Boolean);
    const outside = changedFiles.filter(file => !inScope(file, job.writeScope));
    // 1.4: the git metadata a head shares with the main checkout (config, hooks, …) must not move.
    // Checked before anything runs. It spends no attempt: the change may not be the head's (you,
    // or another lane, can change them too), so the head restores what it changed or asks.
    if (job.gitMetaAtStart) {
      const changedMeta = await gitMetaFingerprint(worktree).then(now => gitMetaChanges(job.gitMetaAtStart!, now), () => []);
      if (changedMeta.length) {
        // 5.2: a denial — hydra_done refused for changed git settings or hooks.
        this.options.audit?.({ kind: 'denial', what: 'hydra_done refused: git settings or hooks changed', detail: changedMeta.join(', '), jobId });
        return { accepted: false, message: `The repository's git settings or hooks changed while you worked: ${changedMeta.join(', ')}. Hydra won't accept work while they differ, because git runs them outside your worktree. If you changed them, put them back exactly as they were, then call hydra_done again. If you didn't, don't try to fix them: call hydra_stuck with this message and wait for the lead.` };
      }
    }
    await this.options.store.transition(jobId, 'checking');
    this.changed();
    const attempts = job.attempts + 1;
    if (outside.length) return this.checkFailed(jobId, attempts, maxAttempts, `These files are outside your write scope (${job.writeScope.join(', ') || '(whole repository)'}):\n${outside.join('\n')}\nUndo those changes in a new commit, then call hydra_done again.`, [], note);
    // 1.1: the gate floor — the snapshot's own definition for every gate id it already had, plus
    // any gate added to today's config since (see gateFloor's own comment for the full rule).
    const floor = gateFloor(job.gatesAtStart, gates);
    // The scope and git-metadata checks first, then the gates in order (docs/Gates_Plan.md, "Heads").
    // A listed pack that can't run reports its gates as not run (docs/Packs_Plan.md); those never block.
    const checks = [...floor.gates.length ? await runGateList(floor.gates, worktree, base, await this.gateContext(job, attempts, signal)) : [], ...floor.notRun];
    if (this.options.store.get(jobId)?.state !== 'checking') return { accepted: false, message: 'This head was stopped. Stop now.' };
    if (signal?.aborted) {
      // The head's call ended mid-check: not its failure, so no attempt is spent.
      await this.options.store.transition(jobId, 'running', 'The gates were interrupted.');
      this.changed();
      return { accepted: false, message: 'The gates were interrupted. Call hydra_done again.' };
    }
    if (checks.some(gateBlocks)) return this.checkFailed(jobId, attempts, maxAttempts, gateFailureMessage(checks), checks, note);
    await this.options.store.update(jobId, { attempts, maxAttempts });
    // Step A (docs/Hydra_Improvements_Pt_2.md): a head has no override, so this is passed/partial/none/none-chosen or, for
    // an empty checks list that isn't from "no gates configured" (there shouldn't be one here — floor.gates.length was checked), undefined.
    const status = evidenceStatus({ checks, configured: gatesConfigured(gates.source, floor.gates.length + floor.notRun.length) });
    await this.options.store.transition(jobId, 'done', undefined, { result: { summary, commit, changedFiles, checks, ...(note ? { note } : {}), ...(status ? { status } : {}) } });
    this.changed();
    return { accepted: true, message: `Accepted. Your work is recorded for the lead.${note ? ` ${note}` : ''} Stop now.` };
  }

  private async checkFailed(jobId: string, attempts: number, maxAttempts: number, message: string, checks: JobCheckResult[] = [], note?: string) {
    const job = this.options.store.get(jobId)!;
    await this.options.store.update(jobId, { attempts, maxAttempts });
    if (attempts >= maxAttempts) {
      await this.options.store.transition(jobId, 'failed', `Gates failed ${attempts} ${attempts === 1 ? 'time' : 'times'}.`, { result: { summary: 'Not accepted: its gates kept failing.', commit: (await git(job.worktree!, ['rev-parse', 'HEAD'])).trim(), changedFiles: [], checks, ...(note ? { note } : {}) } });
      this.changed();
      void this.stopRun(jobId);
      return { accepted: false, message: `${message}\n\nThat was the last attempt (${attempts} of ${maxAttempts}). Stop now; the lead will see the failure.` };
    }
    await this.options.store.transition(jobId, 'running', `Gates failed (attempt ${attempts} of ${maxAttempts}).`);
    this.changed();
    return { accepted: false, attempt: attempts, attempts_left: maxAttempts - attempts, message };
  }

  /** What the gates need to know about a head, and where this attempt's logs, replies and screenshots go. */
  private async gateContext(job: Job, attempt: number, signal?: AbortSignal): Promise<GateContext> {
    return {
      author: job.provider, title: job.title, brief: job.brief, writeScope: job.writeScope,
      logDirectory: await freshDirectory(this.options.logDirectory, `${job.id}-gates-${attempt}`),
      executable: provider => this.options.executable(provider),
      ...(this.options.providerLimited ? { limited: this.options.providerLimited } : {}),
      // Step 2 (design 5): command gates and the screenshots gate's app run in Codex's sandbox when it's available.
      ...(this.options.sandbox ? { sandbox: this.options.sandbox, tempRoot: this.tempRoot } : {}),
      spawned: pid => { this.helperPids.add(pid); },
      ...(signal ? { signal } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
      ...(this.options.gateRuntime ? { runtime: this.options.gateRuntime } : {}),
    };
  }

  private async stuck(jobId: string, args: Record<string, unknown>, signal: AbortSignal) {
    const job = this.options.store.get(jobId), active = this.active.get(jobId);
    if (!job || job.state !== 'running' || !active) throw new Error(`This head can't ask a question while it is ${job?.state ?? 'unknown'}.`);
    const reason = typeof args.reason === 'string' && args.reason.trim() ? clip(args.reason.trim(), 2000) : 'Blocked.';
    const question = typeof args.question === 'string' && args.question.trim() ? clip(args.question.trim(), 2000) : reason;
    await this.options.store.transition(jobId, 'blocked', reason, { question });
    active.blockedSince = this.now();
    this.changed();
    const answer = await new Promise<string | undefined>(resolve => {
      active.answer = reply => resolve(reply);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    active.answer = undefined;
    if (active.blockedSince !== undefined) { active.blockedTotal += this.now() - active.blockedSince; active.blockedSince = undefined; }
    const current = this.options.store.get(jobId)!;
    if (answer === undefined || current.state !== 'blocked') return { answered: false, message: 'No answer is coming: this head was stopped. Stop now.' };
    await this.options.store.transition(jobId, 'running', 'The lead answered.', { question: undefined });
    this.changed();
    return { answered: true, answer };
  }

  private async progress(jobId: string, args: Record<string, unknown>) {
    const job = this.options.store.get(jobId);
    if (!job || finalJobStates.has(job.state)) throw new Error('This head is finished.');
    if (typeof args.note !== 'string') throw new Error('note is required.');
    await this.options.store.update(jobId, { progress: clip(args.note.trim(), 500) });
    this.changed();
    return { recorded: true };
  }

  // ---- lifecycle ----

  /** Start queued helpers. A request that arrives mid-pass runs another pass, so none is lost. */
  private dispatch(): Promise<void> {
    if (this.disposed) return this.dispatchRun;
    this.dispatchAgain = true;
    if (!this.dispatching) this.dispatchRun = this.dispatchLoop();
    return this.dispatchRun;
  }

  private async dispatchLoop(): Promise<void> {
    this.dispatching = true;
    try {
      while (this.dispatchAgain && !this.disposed) {
        this.dispatchAgain = false;
        try { await this.dispatchQueued(); }
        catch (error) { this.options.log?.(`[heads] dispatch: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally { this.dispatching = false; }
  }

  private async dispatchQueued(): Promise<void> {
    // 5.3: stopped means no queued head starts, ever, until Resume Agents.
    if (this.options.stop?.isStopped()) return;
    {
      for (const listed of this.list().filter(item => item.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        // Each job is judged on its current state, and one job's trouble never stops the rest.
        const job = this.options.store.get(listed.id);
        if (!job || job.state !== 'queued') continue;
        try {
          const dependencies = job.dependsOn.map(id => this.options.store.get(id));
          // A dependency that stopped on a usage limit can still be continued in the other provider
          // (docs/Plan_Lanes_Plan.md, decision 7), so its dependents wait for it instead of failing.
          const broken = dependencies.find(dependency => !dependency || dependency.state === 'cancelled' || (dependency.state === 'failed' && !dependency.limitHit));
          if (broken) { await this.options.store.transition(job.id, 'failed', `A job it depends on did not finish (${broken?.id ?? 'missing'}).`); this.changed(); continue; }
          if (dependencies.some(dependency => dependency!.state !== 'done')) continue;
          if (this.disposed || this.active.size >= Math.max(1, this.options.maxConcurrent())) continue;
          await this.launch(job);
        } catch (error) { this.options.log?.(`[heads] ${job.id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }

  private async launch(job: Job): Promise<void> {
    await this.options.store.transition(job.id, 'starting');
    this.changed();
    let token: string | undefined, mcpConfigFile: string | undefined, settingsFile: string | undefined, temp: string | undefined;
    try {
      const executable = await this.options.executable(job.provider);
      // Packs: the role from its pack's checked copy, before anything is created. A role that has
      // gone away fails the head here: "the role coding/builder isn't available (the Coding pack is off)."
      const role = job.role ? await this.roleFor(job, executable) : undefined;
      if (role?.notes.length) this.options.log?.(`[heads] ${job.id}: ${role.notes.join(' ')}`);
      // Step 2: how a Claude head's shell runs (checked once per window). Codex heads keep Codex's own sandbox.
      const shell = job.provider === 'claude' ? await this.headShell() : undefined;
      if (role && Object.keys(role.mcpServers).length) {
        // Only `${NAME}` references and plain values: Claude fills them in from its environment (R3).
        // With the wrapper, Claude Code starts stdio servers through it too; the marker lets a role's servers run as before.
        const servers = shell?.kind === 'sandboxed' ? Object.fromEntries(Object.entries(role.mcpServers).map(([name, server]) => [name, server.type === 'stdio' ? { ...server, env: { ...server.env, HYDRA_SHELL_DIRECT: '1' } } : server])) : role.mcpServers;
        mcpConfigFile = this.mcpConfigFile(job.id);
        await mkdir(this.options.logDirectory, { recursive: true });
        await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: servers }, null, 2), { encoding: 'utf8', mode: 0o600 });
      }
      // A dependent starts from its dependencies' result commits (merged, if several) and hears what they did:
      // the heads it waited on, and a plan's lane jobs it was given as inputs.
      const dependencies = [...this.dependencyResults(job), ...(job.inputs ?? [])];
      // Continuing after a usage limit (HelperService.continueWith): the job already has
      // its worktree and branch from the earlier run, so reuse them instead of creating
      // a second worktree for the same job id (which "git worktree add" would refuse anyway).
      const created = job.worktree && job.branch && job.baseCommit
        ? { worktree: job.worktree, branch: job.branch, baseCommit: job.baseCommit }
        : await createWorktree(this.options.leadFolder, job.title, job.id, this.options.worktreeRoot?.(), job.baseCommit ?? (dependencies.length ? await dependencyBase(this.options.leadFolder, job.title, dependencies) : undefined));
      await this.options.store.update(job.id, { worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit });
      // Step 2: its settings file (Claude), its own TEMP and its allowlisted environment. A settings file
      // Hydra can't build correctly stops the head here, rather than letting it run unconfined.
      await mkdir(this.tempRoot, { recursive: true });
      temp = await mkdtemp(path.join(this.tempRoot, `${job.id}-`));
      const confined = await this.confine(job, created.worktree, executable, role, shell, temp);
      settingsFile = confined.settingsFile;
      const shellNote = shell?.kind === 'off' ? `This head had no shell: ${shell.reason}.` : undefined;
      if (shellNote) this.options.log?.(`[heads] ${job.id}: ${shellNote}`);
      token = this.options.endpoint.issue({ role: 'helper', leadKey: this.options.leadKey, jobId: job.id });
      // The time limit counts from here, before the job is visible as running.
      const startedAt = this.now();
      await this.options.store.transition(job.id, 'running');
      const run = this.options.startRun({
        // Decision 4: the lead's model first, then the role's, which roleLaunch gives only on the role's own provider.
        provider: job.provider, executable, worktree: created.worktree, model: job.model ?? role?.model,
        prompt: helperPrompt({ ...job, worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit }, dependencies.length ? dependencyBrief(dependencies) : undefined, dependencyNoun(dependencies), role, shell?.kind === 'off' ? shell.reason : undefined),
        maxTurns: job.limits.maxTurns, maxBudgetUsd: job.limits.maxBudgetUsd,
        bridge: { command: this.options.bridge.command, args: this.options.bridge.args, env: { ...(this.options.bridge.env || {}), HYDRA_HELPER_PORT: String(this.options.endpoint.port), HYDRA_HELPER_TOKEN: token } },
        logFile: path.join(this.options.logDirectory, `${job.id}.jsonl`),
        spawned: pid => { this.helperPids.add(pid); },
        ...(role ? { role: {
          ...(mcpConfigFile ? { mcpConfigFile } : {}), ...(role.pluginDir ? { pluginDir: role.pluginDir } : {}),
          allowedTools: role.allowedTools, codexConfig: role.codexConfig, webSearch: role.webSearch, env: role.env,
        } } : {}),
        confine: confined.spec,
      });
      const active: Active = { run, token, startedAt, blockedTotal: 0, ...(role ? { role } : {}), ...(mcpConfigFile ? { mcpConfigFile } : {}), ...(settingsFile ? { settingsFile } : {}), temp, ...(shellNote ? { shellNote } : {}) };
      this.active.set(job.id, active);
      run.onTurnEnd(() => { void this.turnEnded(job.id); });
      void run.exited.then(({ code }) => this.exited(job.id, code));
      // A cancel (or Stop all) can land while the launch is still writing its state: the job
      // then reads as running but had no process to stop. Honour it now.
      if (finalJobStates.has(this.options.store.get(job.id)?.state ?? 'failed')) { void this.stopRun(job.id); return; }
      this.options.log?.(`[heads] ${job.id} started (${job.provider}) in ${created.worktree}`);
    } catch (error) {
      if (token) this.options.endpoint.revokeJob(job.id);
      await this.active.get(job.id)?.run.stop().catch(() => undefined);
      this.active.delete(job.id);
      for (const file of [mcpConfigFile, settingsFile, temp]) if (file) await rm(file, { recursive: true, force: true }).catch(() => undefined);
      await this.options.store.transition(job.id, 'failed', `Could not start: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    }
    this.changed();
  }

  /** The helper finished a turn. If it hasn't reported, nudge it once; then fail it. */
  private async turnEnded(id: string): Promise<void> {
    const job = this.options.store.get(id), active = this.active.get(id);
    if (!job || !active) return;
    if (finalJobStates.has(job.state)) { await this.stopRun(id); return; }
    if (job.state !== 'running') return;
    // A usage limit isn't the head's fault and a nudge would only hit it again.
    if (await this.limitReached(id)) return;
    if (!job.nudged) {
      await this.options.store.update(id, { nudged: true });
      const sent = await active.run.send('You stopped without reporting to Hydra. Call hydra_done with a summary (Hydra commits your work), or call hydra_stuck with one clear question. Do it now.');
      if (sent) return;
    }
    await this.finish(id, 'failed', 'The head stopped without calling hydra_done or hydra_stuck.');
  }

  private async exited(id: string, code: number | null): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    try {
      if (await this.limitReached(id)) { this.active.delete(id); this.changed(); void this.dispatch(); return; }
      active.answer?.(undefined as unknown as string);
      this.active.delete(id);
      this.options.endpoint.revokeJob(id);
      const job = this.options.store.get(id);
      if (job && !finalJobStates.has(job.state)) {
        await this.options.store.transition(id, 'failed', `The head process exited${code === null ? '' : ` (code ${code})`} without finishing.`).catch(() => undefined);
      }
      this.changed();
      void this.dispatch();
    } finally {
      // The process is gone for good: its role's server file goes with it (docs/Packs_Plan.md, section 4),
      // and so do its settings file and its own TEMP folder (Step 2). After the state is settled, so a
      // slow delete never holds it up; each launch has its own names, so this never hits a relaunch's files.
      for (const file of [active.mcpConfigFile, active.settingsFile, active.temp]) if (file) await rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
    }
  }

  /** If the head's last turn hit a usage limit: fail it with that reason (no nudge, no attempt used) and report it. */
  private async limitReached(id: string): Promise<boolean> {
    const job = this.options.store.get(id), limit = this.active.get(id)?.run.limitHit?.();
    if (!job || !limit || finalJobStates.has(job.state)) return false;
    await this.finish(id, 'failed', headLimitReason(job.provider, limit), { limitHit: true });
    const event: LimitEvent = { provider: job.provider, source: 'head', at: new Date(this.now()).toISOString(), jobId: id, message: limit.message, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), ...(job.worktree ? { cwd: job.worktree } : {}) };
    this.options.log?.(`[heads] ${id} stopped: ${headLimitReason(job.provider, limit)}`);
    for (const listener of [...this.limitListeners]) { try { listener(event); } catch { /* the listener's problem */ } }
    return true;
  }

  private async enforceLimits(): Promise<void> {
    for (const [id, active] of this.active) {
      const job = this.options.store.get(id);
      if (!job || finalJobStates.has(job.state)) continue;
      const blocked = active.blockedTotal + (active.blockedSince !== undefined ? this.now() - active.blockedSince : 0);
      if (this.now() - active.startedAt - blocked > job.limits.wallClockMs) {
        await this.finish(id, 'failed', `Time limit reached (${Math.round(job.limits.wallClockMs / 60000)} minutes of work).`).catch(() => undefined);
      }
    }
  }

  /** Stop a running helper and settle its job. */
  private async finish(id: string, to: 'failed' | 'cancelled', reason: string, patch: Partial<Pick<Job, 'limitHit'>> = {}): Promise<void> {
    const active = this.active.get(id);
    const job = this.options.store.get(id);
    if (job && !finalJobStates.has(job.state)) await this.options.store.transition(id, to, reason, patch);
    active?.answer?.(undefined as unknown as string);
    this.changed();
    await this.stopRun(id);
  }

  /**
   * Continue a head with the other provider after its own hit a usage limit
   * (docs/Hydra_Agent_Plan.md, Phase 3). Same worktree and branch: the brief gets
   * a "## Handoff" section, attempts and the nudge flag reset, and the job goes
   * back to queued so dispatch restarts it where it left off.
   */
  async continueWith(jobId: string, provider: Provider, handoffMarkdown: string): Promise<Job> {
    const job = this.options.store.get(jobId);
    if (!job || job.leadKey !== this.options.leadKey) throw new Error(`No head ${jobId} in this window.`);
    if (job.state !== 'failed' || !job.limitHit) throw new Error(`Head ${jobId} did not fail from a usage limit.`);
    const brief = clip(`${job.brief}\n\n## Handoff\n\n${handoffMarkdown.trim()}`, maxBriefLength);
    const updated = await this.options.store.transition(jobId, 'queued', continuedHistoryReason(job.provider, provider), {
      provider, model: undefined, brief, attempts: 0, nudged: false, limitHit: false,
    });
    this.changed();
    void this.dispatch();
    return updated;
  }

  private async stopRun(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.options.endpoint.revokeJob(id);
    await active.run.stop().catch(() => undefined);
  }

  /** A Claude head's `--mcp-config` file for its role's servers (docs/Packs_Plan.md, section 4). */
  private mcpConfigFile(id: string): string { return path.join(this.options.logDirectory, `${id}.mcp.json`); }

  // ---- Step 2 (docs/Hydra_Improvements.md): confining heads ----

  /** Where each head's own TEMP folder goes: under Hydra's storage, never the shared TEMP, which Codex's sandbox makes writable (R4). */
  private get tempRoot(): string { return this.options.tempDirectory ?? path.join(path.dirname(this.options.logDirectory), 'temp'); }

  /** How Claude heads' shells run in this window. Without a sandbox (tests, a window without one), a head has none. */
  private async headShell(): Promise<HeadShell> {
    if (!this.options.sandbox) return { kind: 'off', reason: 'this Hydra window has no sandbox for head shells' };
    return this.options.sandbox.shell();
  }

  /**
   * One head's confinement (design 1, 3 and 4): its own TEMP, its allowlisted environment, and for
   * Claude its `--settings` file (0600, beside its `.mcp.json`), its `--add-dir` for the role's pack
   * copy, and whether it has a shell. headSettings throws when the file wouldn't be right, and the
   * head then doesn't start.
   */
  private async confine(job: Job, worktree: string, executable: string, role: RoleLaunch | undefined, shell: HeadShell | undefined, temp: string): Promise<{ spec: HeadConfinement; settingsFile?: string }> {
    const platform = process.platform;
    const env = headEnvironment({ base: process.env, platform, provider: job.provider, temp, worktree, ...(shell ? { shell } : {}), roleNames: role?.variables ?? [], roleValues: role?.env ?? {} });
    if (job.provider !== 'claude') return { spec: { addDirs: [], shell: false, env } };
    const shim = isWindowsShim(executable);
    const storage = this.options.hydraStorage ?? this.options.logDirectory;
    // One name per launch: a continued head's new file is never the one its old run's cleanup removes.
    const settingsFile = path.join(this.options.logDirectory, `${job.id}-${randomBytes(4).toString('hex')}.settings.json`);
    // A `.cmd` launcher's command line passes through cmd.exe: a path it would misread can't be given.
    if (shim && cmdUnsafe.test(settingsFile)) throw new Error('Hydra can\'t pass the head\'s settings file to Claude Code through its .cmd launcher: its path has characters cmd.exe reads as commands.');
    const addDirs = role && !(shim && cmdUnsafe.test(role.packCopy)) ? [role.packCopy] : [];
    if (role && !addDirs.length) this.options.log?.(`[heads] ${job.id}: the role's files were left out: their path has characters cmd.exe reads as commands.`);
    const keep = role ? [role.packCopy, ...(role.pluginDir ? [role.pluginDir] : [])] : [];
    const settings = headSettings({
      platform, env: process.env, storage, storageRead: storageReadDeny(storage, keep, await storageListing(storage, keep), platform),
      worktree, addDirs, otherWorktrees: await otherWorktrees(this.options.leadFolder, worktree), leadFolder: this.options.leadFolder,
    });
    await mkdir(this.options.logDirectory, { recursive: true });
    await writeFile(settingsFile, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { spec: { settingsFile, addDirs, shell: shell?.kind === 'sandboxed' || shell?.kind === 'unconfined', env }, settingsFile };
  }

  /** A head's role for this launch (docs/Packs_Plan.md, section 5), resolved from its pack's checked copy. */
  private async roleFor(job: Job, executable: string): Promise<RoleLaunch> {
    if (!this.options.roles) throw new Error(`the role ${job.role!.ref} isn't available (packs aren't available in this Hydra window).`);
    const resolved = await this.options.roles.resolve(this.options.leadFolder, job.role!.ref);
    return roleLaunch(resolved, { provider: job.provider, target: 'head', env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, shim: isWindowsShim(executable) });
  }

  /** A dependent's finished dependencies, in the order it named them. */
  private dependencyResults(job: Job): DependencyResult[] {
    return job.dependsOn.flatMap(id => {
      const dependency = this.options.store.get(id);
      return dependency?.state === 'done' && dependency.result ? [{ id, kind: 'head' as const, title: dependency.title, summary: dependency.result.summary, commit: dependency.result.commit, ...(dependency.branch ? { branch: dependency.branch } : {}), changedFiles: dependency.result.changedFiles }] : [];
    });
  }

  private ownJob(id: unknown): Job {
    if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new Error('job_id must be a head job id.');
    const job = this.options.store.get(id);
    if (!job || job.leadKey !== this.options.leadKey) throw new Error(`No head ${id} in this window.`);
    return job;
  }

  private describe(job: Job, detail: boolean) {
    return {
      job_id: job.id, title: job.title, state: job.state, provider: job.provider,
      ...(job.role ? { role: job.role.ref, role_title: job.role.title } : {}),
      ...(job.branch ? { branch: job.branch } : {}), ...(job.worktree ? { worktree: job.worktree } : {}), ...(job.baseCommit ? { base_commit: job.baseCommit } : {}),
      ...(job.progress ? { progress: job.progress } : {}), ...(job.question && job.state === 'blocked' ? { question: job.question } : {}),
      ...(job.reason && job.state !== 'running' ? { reason: job.reason } : {}),
      ...(job.result ? { summary: job.result.summary, commit: job.result.commit, ...(job.result.note ? { note: job.result.note } : {}), ...(detail ? { changed_files: job.result.changedFiles, checks: job.result.checks.map(describeGate) } : {}) } : {}),
      ...(detail ? { write_scope: job.writeScope, attempts: job.attempts, max_attempts: job.maxAttempts } : {}),
    };
  }

  private changed(): void {
    for (const wake of [...this.waiters]) wake();
    this.options.onChange?.();
  }
}

/** SHA-256 of a file, or null when it doesn't exist. Used for 1.6's tamper note. */
async function hashOptionalFile(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** 1.6 (docs/Hydra_Improvements.md): hashes of the lead's own .hydra/gates.json, checks.json and packs.json, so a head's result can say when one changed while it ran. */
async function hydraFileHashes(folder: string): Promise<TamperSnapshot> {
  const dir = path.join(folder, '.hydra');
  const [gatesJson, checksJson, packsJson] = await Promise.all([
    hashOptionalFile(path.join(dir, 'gates.json')), hashOptionalFile(path.join(dir, 'checks.json')), hashOptionalFile(path.join(dir, 'packs.json')),
  ]);
  return { gatesJson, checksJson, packsJson };
}

/** What cmd.exe reads as syntax in a path on a `.cmd` launcher's command line (as in packs/launch.ts). */
const cmdUnsafe = /["%^&|<>!\u0000-\u001f\u007f]/;

/**
 * Git's hooks off (Step 2, docs/Hydra_Improvements.md): `core.hooksPath` pointed at an empty folder
 * only Hydra writes, so no hook the repository or a head set up runs when Hydra runs git in a
 * head's worktree. `-c` beats every config file, a head's included.
 */
export const noHooks = (emptyFolder: string): string[] => ['-c', `core.hooksPath=${emptyFolder}`];

/**
 * Commit everything in a helper's worktree, with the repository's identity or, if it has none,
 * Hydra's, and with hooks off (`hooksOff`: an empty folder only Hydra writes). `git add` runs with
 * them off too: it can run a post-index-change hook.
 */
export async function commitAll(worktree: string, message: string, hooksOff: string): Promise<void> {
  await git(worktree, [...noHooks(hooksOff), 'add', '-A']);
  try { await git(worktree, [...noHooks(hooksOff), 'commit', '-q', '-m', message]); }
  catch (error) {
    if (!/tell me who you are|user\.email|user\.name|empty ident/i.test(String(error))) throw error;
    await git(worktree, [...noHooks(hooksOff), '-c', 'user.name=Hydra head', '-c', 'user.email=helper@hydra.invalid', 'commit', '-q', '-m', message]);
  }
}

/** A plan head's input, checked before it is stored: Hydra builds these, but they are written to disk and read back. */
function isDependencyResult(value: unknown): value is DependencyResult {
  const input = value as Partial<DependencyResult> | undefined;
  const text = (field: unknown, max: number) => typeof field === 'string' && field.length <= max && !field.includes('\0');
  return !!input && typeof input === 'object' && (input.kind === 'lane' || input.kind === 'head') && /^[a-f0-9]{12}$/.test(String(input.id))
    && text(input.title, 200) && !!input.title && text(input.summary, 8000) && typeof input.commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.commit)
    && (input.branch === undefined || text(input.branch, 200)) && Array.isArray(input.changedFiles) && input.changedFiles.length <= 1000 && input.changedFiles.every(file => text(file, 1000));
}

export function inScope(file: string, scope: string[]): boolean {
  const normalized = file.replace(/\\/g, '/');
  return scope.some(entry => {
    if (entry === '') return true;
    const prefix = entry.replace(/\/+$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

/** One gate result as hydra_get_head shows it. Results from before gates read as command gates. */
function describeGate(check: JobCheckResult) {
  const state = gateState(check);
  return {
    id: check.id, kind: gateKind(check), state, passed: check.passed, required: check.required,
    ...(check.summary ? { summary: check.summary } : {}),
    ...(check.findings?.length ? { findings: check.findings } : {}),
    ...(check.evidence?.length ? { evidence: check.evidence } : {}),
    ...(state !== 'passed' && check.outputTail ? { output_tail: check.outputTail } : {}),
    ...(check.pack ? { pack: check.pack } : {}),
  };
}

/**
 * The head's first message. `dependencies` is "What the heads you depend on did"
 * (dependencyBrief), for a head that starts from their work; `noun` is "jobs" when
 * any of them is a plan's lane job. A head with a role (docs/Packs_Plan.md, "Heads")
 * hears it first: "Your role: Builder (Coding pack)", its instructions and its skill index.
 * `shellOff` is why a Claude head has no shell (Step 2, design 1), which it hears too.
 */
export function helperPrompt(job: Pick<Job, 'id' | 'title' | 'brief' | 'writeScope' | 'worktree' | 'branch' | 'baseCommit'>, dependencies?: string, noun: 'heads' | 'jobs' = 'heads', role?: Pick<RoleLaunch, 'label' | 'text' | 'changes'>, shellOff?: string): string {
  return [
    `You are a Hydra head (job ${job.id}): ${job.title}`,
    '',
    ...(role ? [`Your role: ${role.label}`, role.text, ''] : []),
    job.brief,
    ...(dependencies ? ['', dependencies] : []),
    '',
    'How to work:',
    `- Work only in this git worktree: ${job.worktree}, on branch ${job.branch}. It starts from commit ${job.baseCommit}${dependencies ? `, which already has the work of the ${noun} it depends on` : ''}.`,
    `- You may change only these paths: ${job.writeScope.length ? job.writeScope.map(entry => entry || '(whole repository)').join(', ') : '(whole repository)'}. Changes elsewhere are refused.`,
    '- Nobody will approve anything for you. Tools you are not allowed to use are denied; work around them.',
    ...(shellOff ? [`- Your shell is off: Codex's Windows sandbox isn't available (${shellOff}). Hydra's gates run the tests.`] : []),
    '- When you are finished, call the hydra_done tool with a summary. Hydra commits your changes for you, so don\'t commit yourself: git commands that write (commit, checkout, config) may fail in your sandbox. Hydra then runs the project\'s gates on the changes (its checks, and possibly a review by another agent), and tells you if anything must be fixed.',
    ...(role?.changes === 'optional' ? ['- Your role may finish without changing any file: then your summary is the result, so put everything the lead needs in it.'] : []),
    '- If you cannot continue without a decision, call hydra_stuck with one clear question. The answer comes back as the tool result.',
    '- Never stop without calling hydra_done or hydra_stuck.',
  ].join('\n');
}

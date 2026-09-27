import { flattenGateFailureMessage, summarizeGateFailures } from './gates';
import type { JobCheckResult } from './jobs';
import type { LaneService } from './laneService';
import type { PlanRunner } from './planRunner';

/**
 * Step C: hydra_job_ready from a lane of a plan that auto-dispatches.
 * Hydra checks the job itself instead of asking you: it runs the lane's gates as Mark job done does (with no
 * dialogs), marks the job done with its commit and evidence status when they pass, and otherwise types the
 * failures into the same lane, presses Enter and counts an attempt; the runner fails the job when the
 * attempts run out. Anything you do by hand (Mark job done, Cancel job, Run gates) wins over a check in
 * flight. Nothing here knows about VS Code.
 */
export type DispatchLanes = Pick<LaneService, 'get' | 'handOn' | 'handOnGates' | 'runGates' | 'typeText' | 'input'>;
export type DispatchRunner = Pick<PlanRunner, 'jobForLane' | 'markLaneDone' | 'recordGateFailure'>;

/** How one check ended. */
export type DispatchCheck =
  | { kind: 'passed'; commit: string }
  /** The failures went back to the lane (`sent`), or couldn't, since its session has ended: `text` is what to paste. */
  | { kind: 'retry'; failures: number; attempts?: number; sent: boolean; text: string }
  | { kind: 'failed'; reason: string }
  /** The lane's HEAD moved, or it got uncommitted work, while the gates ran: it was asked to call again. */
  | { kind: 'moved' }
  /** The job was marked done, cancelled or failed meanwhile, or the gates run was cancelled: nothing to do. */
  | { kind: 'ended' }
  | { kind: 'error'; message: string };

/** The last line of the failures typed into a dispatched lane (the rest is Send to lane's text). */
export const dispatchGatesEnding = 'Fix them, commit, and call hydra_job_ready again; Hydra runs the gates again then.';

export interface LaneDispatchOptions {
  lanes: DispatchLanes;
  /** Undefined while plans aren't ready in this window. */
  runner(): DispatchRunner | undefined;
  /** Gate progress for the lane's tile, as Run gates reports it. */
  onGatesProgress?(laneId: string, progress: { done: JobCheckResult[]; running?: string }): void;
  /** A check ended, for the notification. */
  onChecked?(laneId: string, check: DispatchCheck, job: { planTitle: string; jobTitle: string }): void;
  log?(line: string): void;
  /**
   * Enter goes after the text, not with it: a terminal UI that sees text and Enter in one write may take
   * them as a paste and keep the Enter as a new line instead of sending.
   */
  enterDelayMs?: number;
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export class LaneDispatch {
  private readonly checking = new Map<string, Promise<DispatchCheck>>();
  /** Lanes whose hydra_job_ready is still looking at what to hand on: a second call waits its turn as one in flight. */
  private readonly starting = new Set<string>();
  constructor(private readonly options: LaneDispatchOptions) {}

  /** Whether hydra_job_ready from this lane is Hydra's to check: its job is running, in a plan that auto-dispatches. */
  handles(laneId: string): boolean {
    const found = this.options.runner()?.jobForLane(laneId);
    return !!found?.plan.dispatch && found.view.status === 'active' && !found.job.result;
  }

  /** The check in progress for this lane, if any (tests wait on it). */
  pending(laneId: string): Promise<DispatchCheck> | undefined { return this.checking.get(laneId); }

  /**
   * hydra_job_ready: the agent hears right away (uncommitted work and nothing to hand on are its to fix);
   * the gates run afterwards, so the agent's turn can end and the failures reach an idle prompt.
   */
  async ready(laneId: string, note?: string): Promise<{ checking: boolean; message: string }> {
    const runner = this.options.runner();
    const found = runner?.jobForLane(laneId);
    if (!runner || !found) throw new Error('This lane doesn\'t run a plan job, so there is nothing to check.');
    if (this.checking.has(laneId) || this.starting.has(laneId)) return { checking: true, message: 'Hydra is already running the gates for this job. Wait: if they fail, the failures are typed here.' };
    this.starting.add(laneId);
    const work = await this.options.lanes.handOn(laneId).finally(() => this.starting.delete(laneId));
    if (!work.ok) return { checking: false, message: work.reason === 'dirty' ? `${work.message} Then call hydra_job_ready again.` : 'Nothing to hand on yet: commit your work, then call hydra_job_ready again.' };
    const check = this.check(laneId, note, work.commit, { planId: found.plan.id, key: found.job.key, planTitle: found.plan.title, jobTitle: found.job.title })
      .catch((error): DispatchCheck => ({ kind: 'error', message: describe(error) }))
      .then(result => {
        this.checking.delete(laneId);
        this.options.log?.(`[plans] ${found.plan.id} job ${found.job.key}: auto-dispatch check ${result.kind}`);
        this.options.onChecked?.(laneId, result, { planTitle: found.plan.title, jobTitle: found.job.title });
        return result;
      });
    this.checking.set(laneId, check);
    return { checking: true, message: `Hydra is running the gates on ${work.commit.slice(0, 7)}. If they pass, it marks the job done; if they fail, the failures are typed here for you to fix. Nothing more to do until then.` };
  }

  private async check(laneId: string, note: string | undefined, commit: string, job: { planId: string; key: string; planTitle: string; jobTitle: string }): Promise<DispatchCheck> {
    const { lanes } = this.options;
    const gates = await lanes.handOnGates(laneId);
    let results: JobCheckResult[] | undefined;
    if (gates.kind === 'run') {
      try {
        const outcome = await lanes.runGates(laneId, progress => this.options.onGatesProgress?.(laneId, progress));
        if (outcome.failed.length) results = outcome.results;
      } catch (error) {
        this.options.onGatesProgress?.(laneId, { done: [] });
        // A fresh Run gates or Mark job done cancels this run: yours wins, and no attempt is counted.
        if (/cancelled/.test(describe(error))) return { kind: 'ended' };
        throw error;
      }
    }
    const runner = this.options.runner();
    if (!runner) return { kind: 'ended' };
    if (results) {
      const counted = await runner.recordGateFailure(job.planId, job.key, laneId, summarizeGateFailures(results));
      if (!counted) return { kind: 'ended' };
      const reason = runner.jobForLane(laneId)?.job.outcome?.reason;
      if (counted.failed) return { kind: 'failed', reason: reason ?? `Gates failed ${counted.failures} times.` };
      const text = flattenGateFailureMessage(results, 1500, dispatchGatesEnding);
      const sent = await this.send(laneId, text);
      return { kind: 'retry', failures: counted.failures, ...(counted.attempts !== undefined ? { attempts: counted.attempts } : {}), sent, text };
    }
    // Passed (or no gates for lanes): hand on exactly the commit the gates saw.
    const work = await lanes.handOn(laneId).catch(() => undefined);
    if (!work?.ok || work.commit !== commit) {
      await this.send(laneId, 'Your lane changed while Hydra ran the gates. Commit your work, then call hydra_job_ready again.');
      return { kind: 'moved' };
    }
    const record = lanes.get(laneId)?.lastGates;
    const status = record?.commit === work.commit ? record.status : undefined;
    try {
      await runner.markLaneDone(job.planId, job.key, laneId, { commit: work.commit, ...(note ? { note } : {}), changedFiles: work.changedFiles, ...(status ? { status } : {}) }, { first: true });
    } catch (error) {
      this.options.log?.(`[plans] ${job.planId} job ${job.key}: not marked done: ${describe(error)}`);
      return { kind: 'ended' };
    }
    return { kind: 'passed', commit: work.commit };
  }

  /** Type Hydra's text into the lane (through typeText, since it holds gate output), then press Enter. */
  private async send(laneId: string, text: string): Promise<boolean> {
    if (!this.options.lanes.typeText(laneId, text)) return false;
    const delay = this.options.enterDelayMs ?? 150;
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    return this.options.lanes.input(laneId, '\r');
  }
}

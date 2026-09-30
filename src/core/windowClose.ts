import { finalJobStates, type JobState } from './jobs';
import type { PlanState } from './plans';
import type { PlanIntegration } from './integration';

/**
 * `hydra close` (docs/Heads.md, "Scripts and CI"; docs/THREAT_MODEL.md, HSEC-72): the user role asks the window
 * that owns its folder to close itself. The benchmark harness uses it to close the windows it opened. It refuses
 * while anything in the window is still working, unless forced, so a script can't cut running work short by accident.
 */
export { closeWindowTool } from './helperTools';
/** The window answers first, then closes this long after, so the caller gets its reply. */
export const closeDelayMs = 1500;

/** What in a window is still working: each count is a reason not to close it. */
export interface WindowActivity {
  /** Heads that haven't finished (queued, starting, running, blocked on a question, or being checked). */
  heads: number;
  /** Lanes whose agent is running in its terminal. */
  lanes: number;
  /** Plans being planned or running. */
  plans: number;
  /** Plans that stopped running but whose work is still landing: a landing queued or in flight, or the integration gate running. */
  landing: number;
}

export interface ActivitySource {
  heads: readonly { state: JobState }[];
  lanes: readonly { running?: boolean }[];
  plans: readonly { state: PlanState; integration?: Pick<PlanIntegration, 'queue' | 'inFlight' | 'gate' | 'merged'> }[];
}

const inProgress = (state: PlanState) => state === 'running' || state === 'planning';
const landing = (integration: ActivitySource['plans'][number]['integration']) =>
  !!integration && !integration.merged && (integration.queue.length > 0 || !!integration.inFlight || integration.gate?.running === true);

/** Counts what is still working in a window (pure). A running plan that is also landing counts once, as in progress. */
export function windowActivity(source: ActivitySource): WindowActivity {
  return {
    heads: source.heads.filter(head => !finalJobStates.has(head.state)).length,
    lanes: source.lanes.filter(lane => lane.running).length,
    plans: source.plans.filter(plan => inProgress(plan.state)).length,
    landing: source.plans.filter(plan => !inProgress(plan.state) && landing(plan.integration)).length,
  };
}

export const isBusy = (activity: WindowActivity) => activity.heads + activity.lanes + activity.plans + activity.landing > 0;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What is working, in words: "2 heads, 1 plan in progress". Empty when nothing is. */
export function describeActivity(activity: WindowActivity): string {
  return [
    activity.heads ? count(activity.heads, 'head') : '',
    activity.lanes ? count(activity.lanes, 'lane') : '',
    activity.plans ? `${count(activity.plans, 'plan')} in progress` : '',
    activity.landing ? `${count(activity.landing, 'plan')} landing` : '',
  ].filter(Boolean).join(', ');
}

/** Why the window won't close (pure), or undefined when it may: never while work runs, unless forced. */
export function closeRefusal(activity: WindowActivity, force: boolean): string | undefined {
  if (force || !isBusy(activity)) return undefined;
  return `This Hydra window is still working (${describeActivity(activity)}), so it won't close: that would cut the work short. Wait for it to finish, or force it (hydra close --force).`;
}

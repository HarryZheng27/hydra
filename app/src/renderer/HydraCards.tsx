import type { ReactElement } from 'react';
import type { HeadCardView, PlanCardView } from '../shared/ipc';
import type { ChatItem } from './chatModel';

/**
 * Hydra in the chat (G5 milestone 2): a head or plan the chat started shows as a live card where its tool call is,
 * from the project's controller (src/host/controller.ts's tree). Everything on it is text; nothing on it acts yet
 * (the Agents view does, milestone 3).
 */
export interface HydraView { heads: HeadCardView[]; plans: PlanCardView[] }

/** Claude names a tool `mcp__hydra__hydra_start_head`; Codex names its MCP tools by server and tool too. */
const toolOf = (name: string): 'head' | 'plan' | undefined => (/(^|[_.])hydra_start_head$/.test(name) ? 'head' : /(^|[_.])hydra_plan_create$/.test(name) ? 'plan' : undefined);
const idIn = (output: string | undefined, key: 'job_id' | 'plan_id'): string | undefined => new RegExp(`"${key}"\\s*:\\s*"([a-f0-9]{12})"`).exec(output ?? '')?.[1];

const stateTone = (state: string): string => (/^(done|merged|success)$/.test(state) ? 'ok' : /^(failed|error|cancelled|incomplete|interrupted)$/.test(state) ? 'error' : /^(blocked|question|waiting)$/.test(state) ? 'warning' : 'running');

export function HeadCard({ head }: { head: HeadCardView }) {
  const required = head.checks.filter(check => check.required);
  const passed = required.filter(check => check.passed).length;
  return (
    <div className="hydra-card head" data-head={head.id}>
      <div className="hydra-card-head">
        <span className="hydra-card-kind">Head</span>
        <span className="hydra-card-title">{head.title}</span>
        <span className={`hydra-state ${stateTone(head.state)}`}>{head.merged ? 'merged' : head.state}</span>
      </div>
      <div className="hydra-card-meta">{[head.provider === 'codex' ? 'Codex' : 'Claude Code', head.branch, head.changedFiles ? `${head.changedFiles} file${head.changedFiles === 1 ? '' : 's'} changed` : '', required.length ? `checks ${passed}/${required.length}` : ''].filter(Boolean).join(' · ')}</div>
      {head.question && <div className="hydra-card-line warning">Asks: {head.question}</div>}
      {!head.question && head.progress && <div className="hydra-card-line">{head.progress}</div>}
      {head.summary && <details className="hydra-card-summary"><summary>Summary</summary><div>{head.summary}</div></details>}
    </div>
  );
}

export function PlanCard({ plan }: { plan: PlanCardView }) {
  const done = plan.jobs.filter(job => /^(done|merged)$/.test(job.status)).length;
  return (
    <div className="hydra-card plan" data-plan={plan.id}>
      <div className="hydra-card-head">
        <span className="hydra-card-kind">Plan</span>
        <span className="hydra-card-title">{plan.title}</span>
        <span className={`hydra-state ${stateTone(plan.state)}`}>{plan.state}</span>
      </div>
      <div className="hydra-card-meta">{plan.jobs.length} job{plan.jobs.length === 1 ? '' : 's'} · {done} done</div>
      {plan.error && <div className="hydra-card-line error">{plan.error}</div>}
      <ul className="hydra-jobs">
        {plan.jobs.map(job => <li key={job.key}><span className={`hydra-state ${stateTone(job.status)}`}>{job.status}</span><span>{job.title}</span>{job.reason && <span className="hydra-job-reason">{job.reason}</span>}</li>)}
      </ul>
    </div>
  );
}

/** The card for a Hydra tool call, once its result names a head or plan this project knows; undefined otherwise. */
export function hydraCard(item: ChatItem & { kind: 'tool' }, view: HydraView | undefined): ReactElement | undefined {
  const tool = toolOf(item.name);
  if (!tool || !view) return undefined;
  if (tool === 'head') { const head = view.heads.find(candidate => candidate.id === idIn(item.output, 'job_id')); return head && <HeadCard key={item.key} head={head} />; }
  const plan = view.plans.find(candidate => candidate.id === idIn(item.output, 'plan_id'));
  return plan && <PlanCard key={item.key} plan={plan} />;
}

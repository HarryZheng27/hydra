import { useEffect, useState } from 'react';
import type { ClientMessage, HelperJobView, LaneLimitOfferView, LaneServerMessage, LaneView, Snapshot } from '../../../src/core/model';
import type { Plan } from '../../../src/core/plans';
import type { JobCheckResult } from '../../../src/core/jobs';
import type { PlanJobView } from '../../../src/core/planRunner';
import { AgentsBody, type AgentsViewName } from '../../../webview/AgentsBody';
import type { LaneSwitchCountdown } from '../../../webview/LanesView';
import { emitLaneEvent } from '../../../webview/laneBus';
import '../../../webview/agents-canvas.css';
import '../../../webview/lanes.css';
import type { Project } from '../shared/ipc';

/**
 * The Agents view (G5 milestone 3): the IDE's own canvas of heads, plans and lanes (webview/AgentsBody.tsx), for the
 * project the user has open, driven by that project's controller. Its messages are the IDE webview's own: what the
 * controller sends arrives over `onHydraUi`, and what the view asks goes back through `agentsMessage`, where the
 * controller parses and checks it. This replaces webview/index.tsx's App, which talks to VS Code's webview instead.
 */
export function AgentsView({ project }: { project: Project }) {
  const send = (message: ClientMessage) => { void window.hydra.agentsMessage(project.id, message).catch(error => setError(error instanceof Error ? error.message : String(error))); };
  const [snapshot, setSnapshot] = useState<Snapshot>({ busy: false, mode: 'agents' });
  const [heads, setHeads] = useState<HelperJobView[]>([]);
  const [dismissedTray, setDismissedTray] = useState<string[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planJobs, setPlanJobs] = useState<Record<string, PlanJobView[]>>({});
  const [newPlanSignal, setNewPlanSignal] = useState(0);
  const [view, setView] = useState<AgentsViewName>('canvas');
  const [lanes, setLanes] = useState<LaneView[]>([]);
  const [terminals, setTerminals] = useState(false);
  const [laneError, setLaneError] = useState<string>();
  const [laneFocus, setLaneFocus] = useState<string>();
  const [laneLimits, setLaneLimits] = useState<Record<string, LaneLimitOfferView>>({});
  const [laneSwitchCountdowns, setLaneSwitchCountdowns] = useState<Record<string, LaneSwitchCountdown>>({});
  const [laneGates, setLaneGates] = useState<Record<string, { done: JobCheckResult[]; running?: string }>>({});
  const [headFocus, setHeadFocus] = useState<{ id: string; at: number }>();
  const [error, setError] = useState<string>();
  const changeView = (next: AgentsViewName, focus?: string) => { setView(next); send({ type: 'view', view: next, ...(focus ? { focus } : {}) }); };

  useEffect(() => {
    // A different project: its own state from scratch, then its controller's snapshot.
    setSnapshot({ busy: false, mode: 'agents' }); setHeads([]); setPlans([]); setPlanJobs({}); setLanes([]); setError(undefined);
    const stop = window.hydra.onHydraUi(({ projectId, message }) => {
      if (projectId !== project.id) return;
      const data = message as { type?: string } & Record<string, unknown>;
      if (data?.type === 'snapshot') { const next = data.snapshot as Snapshot; setSnapshot(next); setHeads(next.helpers || []); setPlans(next.plans || []); setPlanJobs(next.planJobs || {}); setDismissedTray(next.dismissedTray || []); }
      if (data?.type === 'heads') setHeads(data.heads as HelperJobView[]);
      if (data?.type === 'plans') { setPlans(data.plans as Plan[]); setPlanJobs((data.planJobs as Record<string, PlanJobView[]> | undefined) || {}); }
      if (data?.type === 'showNewPlan') setNewPlanSignal(value => value + 1);
      const lane = data as LaneServerMessage | undefined;
      if (lane?.type === 'lanes') { setLanes(lane.lanes); setTerminals(lane.terminals); }
      if (lane?.type === 'laneError') setLaneError(lane.message);
      if (lane?.type === 'laneData' || lane?.type === 'laneReplay') emitLaneEvent({ type: lane.type, id: lane.id, data: lane.data });
      if (lane?.type === 'laneLimit') setLaneLimits(current => {
        if (!lane.offer) { if (!(lane.id in current)) return current; const { [lane.id]: _removed, ...rest } = current; return rest; }
        return { ...current, [lane.id]: lane.offer };
      });
      if (lane?.type === 'laneSwitchCountdown') setLaneSwitchCountdowns(current => ({ ...current, [lane.id]: { to: lane.to, deadline: lane.deadline } }));
      if (lane?.type === 'laneSwitchCancelled') setLaneSwitchCountdowns(current => { if (!(lane.id in current)) return current; const { [lane.id]: _removed, ...rest } = current; return rest; });
      if (lane?.type === 'laneGates') setLaneGates(current => {
        if (!lane.running && !lane.done.length) { if (!(lane.id in current)) return current; const { [lane.id]: _removed, ...rest } = current; return rest; }
        return { ...current, [lane.id]: { done: lane.done, ...(lane.running ? { running: lane.running } : {}) } };
      });
      if (lane?.type === 'show') {
        setView(lane.view);
        if (lane.focus) { if (lane.view === 'lanes') setLaneFocus(lane.focus); else setHeadFocus({ id: lane.focus, at: Date.now() }); }
      }
    });
    send({ type: 'ready' });
    return () => { stop(); void window.hydra.agentsMessage(project.id, { type: 'hidden' }).catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  return (
    <section className="agents ide-agents" aria-label={`${project.name}: agents`} data-project={project.id}>
      {(error || snapshot.error) && <div className="banner warning" role="alert">{error ?? snapshot.error} <button className="link" onClick={() => { setError(undefined); send({ type: 'refresh' }); }}>Retry</button></div>}
      <AgentsBody view={view} onViewChange={changeView} heads={heads} dismissedTray={dismissedTray} plans={plans} lanes={lanes} planJobs={planJobs} terminals={terminals} defaultProvider={snapshot.defaultProvider}
        laneError={laneError} laneFocus={laneFocus} onLaneFocused={() => setLaneFocus(undefined)} laneLimits={laneLimits} laneSwitchCountdowns={laneSwitchCountdowns} laneGates={laneGates} roles={snapshot.roles} openNewPlanAt={newPlanSignal} focusHead={headFocus}
        onAction={(type, jobId) => send({ type, jobId } as ClientMessage)} onPlan={send} onStopAll={() => send({ type: 'helperStopAll' })}
        onOpenLane={id => { setLaneFocus(id); changeView('lanes', id); }} onSend={send} />
    </section>
  );
}

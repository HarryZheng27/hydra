import React from 'react';
import type { ClientMessage, HelperJobView, LaneLimitOfferView, LaneView, Provider, SnapshotRole } from '../src/core/model';
import type { Plan } from '../src/core/plans';
import type { JobCheckResult } from '../src/core/jobs';
import type { PlanJobView } from '../src/core/planRunner';
import { AgentsCanvas, type HeadAction } from './AgentsCanvas';
import { LanesView, type LaneSwitchCountdown } from './LanesView';
import { NeedsYouView } from './NeedsYouView';
import type { NeedsYouItem } from '../src/core/needsYou';
import { type NeedsYouAction } from '../src/core/needsYouList';

export type AgentsViewName = 'canvas' | 'lanes' | 'needs';

/**
 * The Agents tab's Canvas | Lanes switch (docs/internal/Lanes_And_Planner_Plan.md,
 * section 2): a segmented control under the topbar, with each view getting the
 * full space. Both views stay mounted (only one is shown) so a lane's terminal
 * keeps running and its scrollback stays put while you're looking at the canvas.
 * No host bridge here (webview/bridge.ts), unlike index.tsx, so this renders under SSR too.
 */
export function AgentsBody({
  view, onViewChange, heads, dismissedTray, plans, lanes, planJobs, terminals, defaultProvider, laneError, laneFocus, onLaneFocused,
  laneLimits, laneSwitchCountdowns, laneGates, roles, onAction, onPlan, onStopAll, openNewPlanAt, onOpenLane, onSend, focusHead,
  needsYou, onNeedsYouAction, onNeedsYouPutOff, onNeedsYouUndo,
}: {
  view: AgentsViewName;
  onViewChange: (view: AgentsViewName) => void;
  heads: readonly HelperJobView[];
  /** Finished heads the tray's Clear button has hidden (docs/internal/Lanes_And_Planner_Plan.md, "Canvas tidy-up"). */
  dismissedTray?: readonly string[];
  plans?: readonly Plan[];
  lanes?: readonly LaneView[];
  /** Each plan's job statuses (docs/internal/Plan_Lanes_Plan.md, section 4-5), by plan id. */
  planJobs?: Readonly<Record<string, readonly PlanJobView[]>>;
  terminals: boolean;
  defaultProvider?: Provider;
  /** The active packs' roles (docs/internal/Packs_Plan.md, "Picking a role"), for the New lane card and the job popover. */
  roles?: readonly SnapshotRole[];
  laneError?: string;
  laneFocus?: string;
  onLaneFocused: () => void;
  /** Usage-limit banners and switch countdowns (docs/internal/Gates_Plan.md, section 2), by lane id. */
  laneLimits?: Readonly<Record<string, LaneLimitOfferView>>;
  laneSwitchCountdowns?: Readonly<Record<string, LaneSwitchCountdown>>;
  /** A gates run in progress on a lane, by lane id (docs/internal/Gates_Plan.md, "Lanes"). */
  laneGates?: Readonly<Record<string, { done: JobCheckResult[]; running?: string }>>;
  onAction: (action: HeadAction, jobId: string) => void;
  onPlan?: (message: ClientMessage) => void;
  onStopAll?: () => void;
  openNewPlanAt?: number;
  onOpenLane: (laneId: string) => void;
  onSend: (message: ClientMessage) => void;
  focusHead?: { id: string; at: number };
  /** The Needs you tab (docs/internal/Needs_You_Plan.md, Phase 5): what waits on the user, already in order and without what's put off. Without it there is no tab. */
  needsYou?: readonly NeedsYouItem[];
  /** Anything the tab's keys chose that isn't a message to the controller: opening a chat (the app) is the parent's. Messages and opening a head or lane are handled here. */
  onNeedsYouAction?: (action: NeedsYouAction, item: NeedsYouItem) => void;
  onNeedsYouPutOff?: (item: NeedsYouItem, until: number) => void;
  onNeedsYouUndo?: (item: NeedsYouItem) => void;
}) {
  const [headTarget, setHeadTarget] = React.useState<{ id: string; at: number }>();
  const focus = headTarget && (!focusHead || headTarget.at >= focusHead.at) ? headTarget : focusHead;
  const needsAction = (action: NeedsYouAction, item: NeedsYouItem) => {
    if (action.kind === 'send') { onSend(action.message); return; }
    if (action.kind === 'open') {
      if (action.view === 'lanes' && action.focus) { onOpenLane(action.focus); return; }
      if (action.focus) setHeadTarget({ id: action.focus, at: Date.now() });
      onViewChange('canvas');
      return;
    }
    onNeedsYouAction?.(action, item);
  };
  return <div className="agents-body">
    <div className="agents-view-switch" role="tablist" aria-label="Agents view">
      {needsYou && <button role="tab" aria-selected={view === 'needs'} className={view === 'needs' ? 'on' : ''} onClick={() => onViewChange('needs')}>Needs you <span className="agents-view-count">{needsYou.length}</span></button>}
      <button role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'on' : ''} onClick={() => onViewChange('canvas')}>Canvas</button>
      <button role="tab" aria-selected={view === 'lanes'} className={view === 'lanes' ? 'on' : ''} onClick={() => onViewChange('lanes')}>Lanes <span className="agents-view-count">{(lanes || []).length}</span></button>
    </div>
    {needsYou && <div className="agents-view-pane" hidden={view !== 'needs'}>
      <NeedsYouView items={needsYou} onAction={needsAction} onPutOff={(item, until) => onNeedsYouPutOff?.(item, until)} onUndo={item => onNeedsYouUndo?.(item)} />
    </div>}
    <div className="agents-view-pane" hidden={view !== 'canvas'}>
      <AgentsCanvas heads={heads} dismissedTray={dismissedTray} plans={plans} lanes={lanes} planJobs={planJobs} defaultProvider={defaultProvider} roles={roles} onAction={onAction} onPlan={onPlan} onStopAll={onStopAll} openNewPlanAt={openNewPlanAt} onOpenLane={onOpenLane} focusHead={focus} />
    </div>
    <div className="agents-view-pane" hidden={view !== 'lanes'}>
      <LanesView lanes={lanes || []} terminals={terminals} defaultProvider={defaultProvider} laneError={laneError} focus={laneFocus} onSend={onSend} onFocused={onLaneFocused}
        laneLimits={laneLimits} laneSwitchCountdowns={laneSwitchCountdowns} laneGates={laneGates} roles={roles} />
    </div>
  </div>;
}

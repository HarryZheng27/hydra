import type { Job } from '../core/jobs';
import { buildHandoff, saveHandoff, type HandoffDeps } from '../core/limitHandoff';
import type { LimitEvent } from '../core/limitEvents';
import { otherProvider } from '../core/limitEvents';
import { buildOffer, LimitOfferTracker, providerLabel } from '../core/limitOffer';
import type { Provider } from '../core/model';
import type { Disposable, Host } from './host';

/**
 * Phase 3 (docs/internal/Hydra_Agent_Plan.md, "Offer where to continue"): on each limit
 * event, save the handoff to global storage and show one notification with
 * "Continue in <Other>" (or "Set up <Other>"), "View handoff" and "Wait". The
 * decision logic (message, buttons, dedupe) is in src/core/limitOffer.ts; this
 * module wires it to the host (notifications, the clipboard, the other extension,
 * HelperService.continueWith).
 */
export interface LimitOfferDeps {
  /** The program Hydra runs in (src/host/host.ts). */
  host: Host;
  limitEvents: (listener: (event: LimitEvent) => unknown) => Disposable;
  /** Opens the other provider's official chat (the IDE's official extension), following Docked/Tabs. */
  openOfficial: (provider: Provider) => Promise<void>;
  /** Extension global storage root; handoffs are saved under `<storageDir>/handoffs`. */
  storageDir: string;
  offerEnabled: () => boolean;
  /** Looks up a head's job for a `source: 'head'` event, for the handoff builder and continueWith. */
  job: (jobId: string) => Job | undefined;
  /** Whether the other provider is installed and connected to Hydra. */
  otherReady: (provider: Provider) => Promise<boolean>;
  /** HelperService.continueWith for a head; not called for a chat. */
  continueWith: (jobId: string, provider: Provider, handoffMarkdown: string) => Promise<void>;
  handoffDeps?: HandoffDeps;
  now?: () => Date;
  log?: (line: string) => void;
  /** O6: true when this head runs a plan job and hydra.limits.autoContinuePlans is on; it then fails over without asking, since an unattended plan may have nobody watching. */
  autoContinuePlan?: (jobId: string) => boolean;
  /**
   * Shared with the lane banner (src/host/lanes.ts LanesController), so
   * "otherStillLimited" reflects every chat, head and lane in this window, not
   * just chats. Defaults to a fresh, unshared tracker.
   */
  tracker?: LimitOfferTracker;
}

export function registerLimitOffer(deps: LimitOfferDeps): Disposable {
  const tracker = deps.tracker ?? new LimitOfferTracker();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const subscription = deps.limitEvents(event => {
    void handle(event).catch(error => log(`[limits] offer failed: ${error instanceof Error ? error.message : String(error)}`));
  });

  async function handle(event: LimitEvent): Promise<void> {
    // Lane events are shown on the lane's tile (LanesController.onLimitEvent), never as a notification.
    if (event.source === 'lane') return;
    // O6: a plan job fails over on its own — nobody may be watching an unattended plan — bypassing
    // the interactive offer (and hydra.limits.offerHandoff) entirely, as long as the other provider
    // is actually ready and not itself limited; otherwise it falls through to the ordinary offer.
    const autoContinue = event.source === 'head' && !!event.jobId && !!deps.autoContinuePlan?.(event.jobId);
    if (!autoContinue && !deps.offerEnabled()) return;
    const considered = tracker.consider(event, now());
    if (!considered) return; // a repeat of the same chat/head within the dedupe window
    const job = event.source === 'head' && event.jobId ? deps.job(event.jobId) : undefined;
    const handoff = await buildHandoff({ event, job }, deps.handoffDeps);
    const file = await saveHandoff(deps.storageDir, event, handoff.markdown);
    const other = otherProvider(event.provider);
    const otherReady = considered.otherAlsoLimited ? false : await deps.otherReady(other).catch(() => false);
    if (autoContinue && otherReady) {
      await continueInOther(event, other, handoff.markdown, deps);
      log(`[limits] plan job ${event.jobId}: continued automatically in ${other} after ${event.provider}'s usage limit`);
      return;
    }
    // Auto-continue wanted it but couldn't (both limited, or the other isn't set up): falls
    // through to the ordinary offer below, same as any other head.
    if (!deps.offerEnabled()) return;
    const offer = buildOffer(event, now(), considered.otherAlsoLimited, otherReady);
    const choice = await deps.host.notify('info', offer.message, ...offer.buttons.map(button => button.label));
    const button = offer.buttons.find(candidate => candidate.label === choice);
    if (!button) return; // dismissed, or "Wait"
    try {
      switch (button.id) {
        case 'viewHandoff': await deps.host.openMarkdown(file); break;
        case 'setupOther': await deps.host.command('hydra.openSettings', 'connectors'); break;
        case 'continueOther': await continueInOther(event, other, handoff.markdown, deps); break;
        case 'wait': break;
      }
    } catch (error) {
      void deps.host.notify('error', error instanceof Error ? error.message : String(error));
    }
  }
  return { dispose: () => subscription.dispose() };
}

async function continueInOther(event: LimitEvent, other: Provider, markdown: string, deps: LimitOfferDeps): Promise<void> {
  if (event.source === 'head' && event.jobId) {
    await deps.continueWith(event.jobId, other, markdown);
    return;
  }
  // A chat: Hydra never types into the other extension. It copies the handoff and
  // opens the other chat (following Docked/Tabs), for the user to paste themselves.
  await deps.host.copy(markdown);
  await deps.openOfficial(other);
  void deps.host.notify('info', `Handoff copied. Paste it into the new ${providerLabel[other]} chat to continue.`);
}

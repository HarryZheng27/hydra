import path from 'node:path';
import type { ChatEvent } from '../../../src/core/chat/events';
import { AwayBanners, deriveNeedsYou, isAway, type BannerContent, type ChatFact, type NeedsYouFacts, type Presence } from '../../../src/core/needsYou';
import { nextStatus, type ChatStatus } from '../shared/chatStatus';

/**
 * OS banners while the user is away (docs/internal/Needs_You_Plan.md, Phase 1). The decisions about what needs the
 * user and when to say so are in src/core/needsYou.ts; this is the app's side of it: it tracks each chat's status
 * from the events main already pushes, asks each running project for what else waits (heads, plans, limits), and
 * hands a banner to the OS when core says to. It keeps no state of its own on disk.
 *
 * A chat that needs an answer always counts. A chat that finished counts only if the user wasn't at the window when
 * it did, and stops counting once they come back: it is then in the sidebar, and the banner was for being away.
 */
export interface BannerDeps {
  now: () => number;
  /** Whether Hydra is the focused window, and how long the machine has been idle (powerMonitor.getSystemIdleTime). */
  presence: () => Presence;
  /** notifications.whenAway. */
  enabled: () => boolean | Promise<boolean>;
  /** The projects Hydra runs for, with what waits in each (HydraProjects.needsYouFacts). */
  projects: () => NeedsYouFacts[];
  /** A chat's title and folder, from the chat store. */
  chat: (chatId: string) => Promise<{ title: string; cwd: string } | undefined>;
  /** The app's projects, to name the project a chat belongs to. */
  known: () => Promise<readonly { id: string; name: string; path: string }[]>;
  /** The OS banner. `click` runs when the user clicks it. */
  show: (banner: BannerContent, click: () => void) => void;
  /** Focuses the window and opens what the banner was about. */
  open: (banner: BannerContent) => void;
  log?: (line: string) => void;
}

/** How long an item waits before a banner: a lead that has just woken to a head's question and is working out its answer, or a chat that resumes, never gets one. */
export const bannerGraceMs = 60_000;
/** How often presence is looked at: idle time only becomes "away" by the clock, not by an event. */
export const bannerPollMs = 15_000;

const inside = (folder: string, root: string): boolean => {
  const a = path.resolve(folder).toLowerCase(), b = path.resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

interface Tracked { status: ChatStatus; since: number; waiting: Set<string>; title?: string; projectId?: string; projectName?: string }

export class WhenAwayBanners {
  private readonly chats = new Map<string, Tracked>();
  private readonly policy = new AwayBanners(bannerGraceMs);
  private timer?: ReturnType<typeof setInterval>;
  private evaluating = false;
  private again = false;

  constructor(private readonly deps: BannerDeps) {}

  start(): void {
    this.timer ??= setInterval(() => this.changed(), bannerPollMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** The events main pushes for a chat (the same stream the window's sidebar dots come from). */
  chatEvents(chatId: string, events: readonly ChatEvent[], start: number): void {
    if (start < 0 || !events.length) return;
    const previous = this.chats.get(chatId);
    const waiting = previous?.waiting ?? new Set<string>();
    // At the window, a finished reply is already seen: only being away makes it something to come back to.
    const next = nextStatus(previous?.status, events, waiting, !isAway(this.deps.presence()));
    if (next === previous?.status) return;
    if (!next) { this.chats.delete(chatId); this.changed(); return; }
    this.chats.set(chatId, { ...previous, status: next, since: this.deps.now(), waiting });
    if (next === 'needs' || next === 'unread') void this.name(chatId).then(() => this.changed());
    else this.changed();
  }

  /** The window gained or lost focus, or anything Hydra tracks changed (a head blocked, a plan finished). */
  changed(): void {
    // Back at the window: what finished while away is in the sidebar now.
    if (!isAway(this.deps.presence())) for (const [id, entry] of this.chats) if (entry.status === 'unread') this.chats.delete(id);
    if (this.evaluating) { this.again = true; return; }
    this.evaluating = true;
    void this.evaluate().catch(error => this.deps.log?.(`[needs you] ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
      this.evaluating = false;
      if (this.again) { this.again = false; this.changed(); }
    });
  }

  private async name(chatId: string): Promise<void> {
    const entry = this.chats.get(chatId);
    if (!entry || entry.title !== undefined) return;
    const [record, projects] = await Promise.all([this.deps.chat(chatId).catch(() => undefined), this.deps.known().catch(() => [])]);
    if (!record) { entry.title = 'A chat'; return; }
    const project = projects.find(candidate => inside(record.cwd, candidate.path));
    entry.title = record.title; entry.projectId = project?.id ?? ''; entry.projectName = project?.name ?? path.basename(record.cwd);
  }

  private async evaluate(): Promise<void> {
    if (!(await this.deps.enabled())) return;
    const facts = this.deps.projects();
    const byProject = new Map<string, NeedsYouFacts>(facts.map(project => [project.projectId, { ...project, chats: [] }]));
    for (const [id, entry] of this.chats) {
      if (entry.title === undefined || (entry.status !== 'needs' && entry.status !== 'unread')) continue;
      const projectId = entry.projectId ?? '';
      const project = byProject.get(projectId) ?? { projectId, projectName: entry.projectName ?? '' };
      const chat: ChatFact = { id, title: entry.title, status: entry.status, since: entry.since };
      byProject.set(projectId, { ...project, chats: [...(project.chats ?? []), chat] });
    }
    const items = deriveNeedsYou([...byProject.values()], this.deps.now());
    const banner = this.policy.update(items, this.deps.presence(), this.deps.now());
    if (banner) this.deps.show(banner, () => this.deps.open(banner));
  }
}

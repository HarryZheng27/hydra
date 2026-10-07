import { compareNeedsYou, deriveNeedsYou, type ChatFact, type NeedsYouFacts, type NeedsYouItem } from '../../../src/core/needsYou';
import { putOffKey, putOffStorageKey, PutOffs } from '../../../src/core/needsYouList';
import type { ChatRecord, HydraTreeMessage, Project } from '../shared/ipc';
import type { ChatStatus } from './chatStatus';

/**
 * The Needs you list as the window assembles it (docs/internal/Needs_You_Plan.md, Phase 5): each project's items come
 * from its controller (already without what the user put off), and the window adds its own chats, whose dots it keeps
 * (chatStatus.ts). Chats put off are the window's: kept in local storage, like the sidebar's folded projects.
 */

const chatPutOffKey = `${putOffStorageKey}.chats`;

export function readChatPutOffs(now = Date.now()): PutOffs {
  try { return PutOffs.parse(localStorage.getItem(chatPutOffKey), now); } catch { return new PutOffs(); }
}
export function saveChatPutOffs(putOffs: PutOffs): void {
  try { localStorage.setItem(chatPutOffKey, JSON.stringify(putOffs.toJSON())); } catch { /* best effort: a put-off just isn't remembered */ }
}

export const isChatItem = (item: Pick<NeedsYouItem, 'kind'>): boolean => item.kind === 'chat-needs' || item.kind === 'chat-unread';

/** A project's item as this window knows the project: its id and name, and the id that follows. */
export function inProject(item: NeedsYouItem, project: Pick<Project, 'id' | 'name'>): NeedsYouItem {
  return { ...item, projectId: project.id, projectName: project.name, id: `${item.kind}:${project.id}:${item.sourceId}` };
}

/** The chats that wait on the user (a dot that is `needs` or `unread`), by the project whose folder they are in. */
export function chatFacts(chats: readonly ChatRecord[], statuses: Readonly<Record<string, ChatStatus>>, projects: readonly Project[]): NeedsYouFacts[] {
  const byProject = new Map<string, { project: Pick<Project, 'id' | 'name'>; chats: ChatFact[] }>();
  for (const chat of chats) {
    const status = statuses[chat.id];
    if (chat.archivedAt || (status !== 'needs' && status !== 'unread')) continue;
    const project = projects.find(candidate => candidate.path.toLowerCase() === chat.cwd.toLowerCase());
    const key = project?.id ?? '';
    const entry = byProject.get(key) ?? { project: project ?? { id: '', name: '' }, chats: [] };
    const since = Date.parse(chat.updatedAt);
    entry.chats.push({ id: chat.id, title: chat.title, status, since: Number.isFinite(since) ? since : 0 });
    byProject.set(key, entry);
  }
  return [...byProject.values()].map(({ project, chats: list }) => ({ projectId: project.id, projectName: project.name, chats: list }));
}

/** Everything waiting on the user across the window's projects, in order. */
export function needsYouItems(args: {
  projects: readonly Project[]; trees: Readonly<Record<string, HydraTreeMessage>>; chats: readonly ChatRecord[];
  statuses: Readonly<Record<string, ChatStatus>>; chatPutOffs: PutOffs; now: number;
}): NeedsYouItem[] {
  const { projects, trees, chats, statuses, chatPutOffs, now } = args;
  const fromProjects = projects.flatMap(project => (trees[project.id]?.needsYou ?? []).map(item => inProject(item, project)));
  const fromChats = chatPutOffs.visible(deriveNeedsYou(chatFacts(chats, statuses, projects), now), now);
  return [...fromProjects, ...fromChats].sort(compareNeedsYou);
}

export { putOffKey };

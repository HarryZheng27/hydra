import type { ChatEvent } from '../../../src/core/chat/events';

/**
 * A chat's state in the sidebar, as Claude desktop shows its sessions: working (a flashing grey dot), waiting on the
 * user (yellow: an approval, a question or a plan), or finished while the user was elsewhere (blue). Idle is the rest.
 */
export type ChatStatus = 'working' | 'needs' | 'unread';

/** The status after these events, given what it was, the requests still waiting, and whether the chat is on screen. */
export function nextStatus(previous: ChatStatus | undefined, events: readonly ChatEvent[], waiting: Set<string>, onScreen: boolean): ChatStatus | undefined {
  let status = previous;
  for (const event of events) {
    if (event.type === 'user') status = 'working';
    else if (event.type === 'approval' || event.type === 'question' || event.type === 'plan') { waiting.add(event.id); status = 'needs'; }
    else if (event.type === 'resolved') { waiting.delete(event.id); status = waiting.size ? 'needs' : 'working'; }
    else if (event.type === 'done') { waiting.clear(); status = onScreen ? undefined : 'unread'; }
    else if (event.type === 'error' && event.fatal) { waiting.clear(); status = undefined; }
  }
  return status;
}

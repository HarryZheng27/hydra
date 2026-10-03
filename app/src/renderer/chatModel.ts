import type { ChatEvent } from '../shared/ipc';

/** What the chat pane draws, folded from the chat's events in order. */
export type ChatItem =
  | { kind: 'user'; key: string; text: string; images?: number }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'request'; key: string; event: Extract<ChatEvent, { type: 'approval' | 'question' | 'plan' }>; resolved?: Extract<ChatEvent, { type: 'resolved' }> }
  | { kind: 'error'; key: string; message: string }
  | { kind: 'turn-end'; key: string; status: 'success' | 'interrupted' | 'error'; detail?: string; usage?: Extract<ChatEvent, { type: 'usage' }> };

export interface ChatView { items: ChatItem[]; running: boolean; pending: string[] }

/** Folds events into items: deltas of one block join, tool results meet their calls, answers meet their requests. */
export function foldEvents(events: readonly ChatEvent[]): ChatView {
  const items: ChatItem[] = [];
  const blocks = new Map<string, ChatItem & { kind: 'text' | 'thinking' }>();
  const tools = new Map<string, ChatItem & { kind: 'tool' }>();
  const requests = new Map<string, ChatItem & { kind: 'request' }>();
  let usage: Extract<ChatEvent, { type: 'usage' }> | undefined;
  let running = false;
  let n = 0;
  for (const event of events) {
    switch (event.type) {
      case 'user': items.push({ kind: 'user', key: `u${n++}`, text: event.text, ...(event.images ? { images: event.images } : {}) }); running = true; usage = undefined; blocks.clear(); break;
      case 'text': case 'thinking': {
        const id = `${event.type}:${event.block}`;
        const existing = blocks.get(id);
        if (existing) existing.text += event.delta;
        else { const item = { kind: event.type, key: `b${n++}`, text: event.delta }; blocks.set(id, item); items.push(item); }
        break;
      }
      case 'tool-call': { const item = { kind: 'tool' as const, key: `t${n++}`, id: event.id, name: event.name, input: event.input }; tools.set(event.id, item); items.push(item); break; }
      case 'tool-result': { const tool = tools.get(event.id); if (tool) { tool.output = event.output; tool.isError = event.isError; } break; }
      case 'approval': case 'question': case 'plan': { const item = { kind: 'request' as const, key: `r${n++}`, event }; requests.set(event.id, item); items.push(item); break; }
      case 'resolved': { const request = requests.get(event.id); if (request) request.resolved = event; break; }
      case 'usage': usage = event; break;
      case 'error': items.push({ kind: 'error', key: `e${n++}`, message: event.message }); break;
      case 'done': items.push({ kind: 'turn-end', key: `d${n++}`, status: event.status, ...(event.detail ? { detail: event.detail } : {}), ...(usage ? { usage } : {}) }); running = false; usage = undefined; break;
      default: break;
    }
  }
  const pending = [...requests.values()].filter(request => !request.resolved && running).map(request => request.event.id);
  return { items, running, pending };
}

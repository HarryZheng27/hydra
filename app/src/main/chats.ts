import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClaudeAdapter } from '../../../src/core/chat/claude';
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatImage, ChatOptions, ChatProvider, ClaudePermissionMode, CodexSandbox } from '../../../src/core/chat/events';
import { ChatSession, type Launch, type SessionTimings } from '../../../src/core/chat/session';
import { ChatStore, titleFrom, type ChatRecord, type LogEntry } from '../../../src/core/chat/store';

/**
 * The app's chats (G4): one ChatSession per open chat, its events written to the ChatStore and pushed to the window.
 * A chat starts only in a project the user has trusted in main's own confirm (hard rule 6): `claude -p` and Codex run
 * a project's hooks and MCP servers without asking.
 */
export interface ChatManagerDeps {
  store: ChatStore;
  launch: Launch;
  /** The CLI to run, from the machine setting or PATH; undefined when it isn't installed. */
  executable(provider: ChatProvider): Promise<string | undefined>;
  /** Whether the user has trusted this folder in the app. */
  trusted(cwd: string): Promise<boolean>;
  /** Pushes events to the window; `start` is the first one's position in the chat's log. */
  push(chatId: string, events: ChatEvent[], start: number): void;
  adapters?: Partial<Record<ChatProvider, () => ChatAdapter>>;
  timings?: SessionTimings;
}

export interface NewChat { cwd: string; provider: ChatProvider; model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox }

export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  /** Sessions being set up, so two quick messages share one. */
  private readonly starting = new Map<string, Promise<ChatSession>>();
  private readonly titled = new Set<string>();
  /** Set once the app is quitting: no chat starts after that. */
  private closing = false;

  constructor(private readonly deps: ChatManagerDeps) {}

  private adapter(provider: ChatProvider): () => ChatAdapter {
    const make = this.deps.adapters?.[provider] ?? (provider === 'claude' ? () => new ClaudeAdapter() : undefined);
    if (!make) throw new Error(`${provider === 'codex' ? 'Codex' : provider} chats aren't available yet.`);
    return make;
  }

  list(): Promise<ChatRecord[]> { return this.deps.store.list(); }

  async create(input: NewChat): Promise<ChatRecord> {
    if (!path.isAbsolute(input.cwd)) throw new Error('A chat needs a project folder.');
    if (!(await this.deps.trusted(input.cwd))) throw new Error('Trust this folder before starting a chat in it.');
    this.adapter(input.provider);
    return this.deps.store.create({
      provider: input.provider, cwd: input.cwd,
      ...(input.provider === 'claude' ? { providerSessionId: randomUUID(), permissionMode: input.permissionMode ?? 'default' } : { sandbox: input.sandbox ?? 'read-only' }),
      ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}),
    });
  }

  async open(id: string): Promise<{ record: ChatRecord; log: LogEntry[]; running: boolean }> {
    const record = await this.record(id);
    return { record, log: await this.deps.store.read(id), running: this.sessions.get(id)?.busy ?? false };
  }

  private async record(id: string): Promise<ChatRecord> {
    const record = await this.deps.store.get(id);
    if (!record) throw new Error('No such chat.');
    return record;
  }

  /** The chat's session, set up once even when several messages arrive while it is starting. */
  private session(id: string): Promise<ChatSession> {
    const existing = this.sessions.get(id);
    if (existing) return Promise.resolve(existing);
    let starting = this.starting.get(id);
    if (!starting) {
      starting = this.makeSession(id).finally(() => this.starting.delete(id));
      this.starting.set(id, starting);
    }
    return starting;
  }

  private async makeSession(id: string): Promise<ChatSession> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    const executable = await this.deps.executable(record.provider);
    if (!executable) throw new Error(`${record.provider === 'claude' ? 'Claude Code' : 'Codex'} isn't installed. Check Your agents in Settings.`);
    const log = await this.deps.store.read(id);
    const started = log.some(entry => entry.event.type === 'session');
    const options: ChatOptions = {
      provider: record.provider, cwd: record.cwd, executable,
      ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}),
      ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}), ...(record.sandbox ? { sandbox: record.sandbox } : {}),
      // A Claude chat's id is chosen at creation; it is resumed once the CLI has started it.
      ...(started && record.providerSessionId ? { resume: record.providerSessionId } : record.provider === 'claude' ? { sessionId: record.providerSessionId } : {}),
    };
    if (this.closing) throw new Error('Hydra is quitting.');
    const session = new ChatSession(this.adapter(record.provider), options, this.deps.launch, events => void this.persist(id, events), this.deps.timings);
    this.sessions.set(id, session);
    return session;
  }

  /** Writes a chat's events to its log, keeps its index entry current, and pushes them to the window. */
  private async persist(id: string, events: ChatEvent[]): Promise<void> {
    try {
      // Written first, then pushed with its position, so the window can merge it with a log it is reading.
      const start = await this.deps.store.append(id, events);
      this.deps.push(id, events, start);
      const patch: Partial<ChatRecord> = {};
      const session = events.find((event): event is Extract<ChatEvent, { type: 'session' }> => event.type === 'session');
      if (session) patch.providerSessionId = session.providerSessionId;
      const user = events.find((event): event is Extract<ChatEvent, { type: 'user' }> => event.type === 'user');
      if (user && !this.titled.has(id)) {
        this.titled.add(id);
        const record = await this.deps.store.get(id);
        if (record?.title === 'New chat') patch.title = titleFrom(user.text);
      }
      if (session && session.providerSessionId === (await this.deps.store.get(id))?.providerSessionId) delete patch.providerSessionId;
      if (Object.keys(patch).length || events.some(event => event.type === 'done')) await this.deps.store.update(id, patch);
    } catch (error) {
      this.deps.push(id, [{ type: 'error', message: `Hydra couldn't save this chat: ${error instanceof Error ? error.message : String(error)}`, fatal: false }], -1);
    }
  }

  /** Every message checks trust first: a running chat's process can be replaced (idle, a new mode, a crash). */
  async send(id: string, text: string, images?: ChatImage[]): Promise<void> {
    if (!text.trim() && !images?.length) throw new Error('Type a message first.');
    if (this.closing) throw new Error('Hydra is quitting.');
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) {
      this.sessions.get(id)?.close();
      this.sessions.delete(id);
      throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    }
    (await this.session(id)).send(text, images);
  }

  /** Ends the chats in a folder, for when it stops being a project. */
  async closeFolder(cwd: string): Promise<void> {
    const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    for (const record of await this.deps.store.list()) {
      if (!same(record.cwd, cwd)) continue;
      this.sessions.get(record.id)?.close();
      this.sessions.delete(record.id);
    }
  }

  answer(id: string, requestId: string, answer: ChatAnswer): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error('This chat isn\'t running.');
    session.answer(requestId, answer);
  }

  stop(id: string): void { this.sessions.get(id)?.stop(); }

  /** Changes model, effort or permission mode for the chat's next turn. */
  async configure(id: string, requested: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox }): Promise<ChatRecord> {
    // An empty model or effort goes back to the CLI's default.
    const change = Object.fromEntries(Object.entries(requested).map(([key, value]) => [key, value === '' ? undefined : value])) as typeof requested;
    const record = await this.deps.store.update(id, change);
    const session = this.sessions.get(id);
    if (session) {
      if (change.model && Object.keys(change).length === 1) session.setModel(change.model);
      else session.reconfigure(change);
    }
    return record;
  }

  async remove(id: string): Promise<void> {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
    await this.deps.store.remove(id);
  }

  /** Ends every chat's process, for quit. */
  closeAll(): void {
    this.closing = true;
    for (const session of this.sessions.values()) { try { session.close(); } catch { /* keep closing the rest */ } }
    this.sessions.clear();
  }
}

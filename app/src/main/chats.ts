import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClaudeAdapter } from '../../../src/core/chat/claude';
import { CodexAdapter } from '../../../src/core/chat/codex';
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatImage, ChatOptions, ChatProvider, ClaudePermissionMode, CodexSandbox } from '../../../src/core/chat/events';
import { MAX_IMAGE_BYTES } from '../../../src/core/chat/events';
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
  /**
   * Codex's own config file, read before and after each Codex turn that may write: G1 found that write access given
   * the wrong way marks the folder trusted there, which turns on the project's own config, hooks and MCP servers.
   */
  codexConfig?(): Promise<string | undefined>;
  /** Opens a console window the user owns, running a CLI in a folder; Hydra never reads it. */
  openConsole?(title: string, executable: string, args: string[], cwd: string): Promise<{ started: boolean; error?: string }>;
  timings?: SessionTimings;
}

/** Image formats a chat accepts, by their first bytes: the declared type must match the file. */
const signatures: Record<ChatImage['mediaType'], (bytes: Buffer) => boolean> = {
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/gif': bytes => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')),
  'image/webp': bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** An attached image: a known type whose bytes match it, at most 5 MB. */
export function checkImage(image: ChatImage): void {
  const check = signatures[image.mediaType];
  if (!check || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('That image isn\'t a PNG, JPEG, GIF or WebP.');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Images can be at most 5 MB.');
  if (!check(bytes)) throw new Error('That file isn\'t the image it says it is.');
const normal = (folder: string): string => path.resolve(folder).replace(/[\\/]+$/, '').toLowerCase();
/** True when `folder` is `cwd` or a folder above it (Codex may trust the repository root rather than a subfolder). */
const covers = (folder: string, cwd: string): boolean => { const a = folder, b = normal(cwd); return b === a || b.startsWith(a + path.sep); };

/**
 * The folders Codex's config.toml marks trusted: each `[projects."<path>"]` or `[projects.'<path>']` table whose
 * `trust_level` is "trusted", as normalized paths.
 */
export function trustedProjects(toml: string): Set<string> {
  const out = new Set<string>();
  let current: string | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const table = /^\[\s*projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]$/.exec(line);
    if (table) { current = table[1] !== undefined ? table[1].replace(/\\(.)/g, '$1') : table[2]; continue; }
    if (line.startsWith('[')) { current = undefined; continue; }
    if (current && /^trust_level\s*=\s*"trusted"\s*(#.*)?$/.test(line)) out.add(normal(current));
  }
  return out;
}

export interface NewChat { cwd: string; provider: ChatProvider; model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox }

export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  /** Sessions being set up, so two quick messages share one. */
  private readonly starting = new Map<string, Promise<ChatSession>>();
  private readonly titled = new Set<string>();
  /** Codex's config as it was before each Codex chat's current turn. */
  private readonly codexBefore = new Map<string, string | undefined>();
  /** Set once the app is quitting: no chat starts after that. */
  private closing = false;

  constructor(private readonly deps: ChatManagerDeps) {}

  private adapter(provider: ChatProvider): () => ChatAdapter {
    return this.deps.adapters?.[provider] ?? (provider === 'claude' ? () => new ClaudeAdapter() : () => new CodexAdapter());
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
    // The folder may have stopped being trusted while this was starting.
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
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
      if (this.codexBefore.has(id) && events.some(event => event.type === 'done')) await this.checkCodexTrust(id);
      // A Codex turn starts when its message is shown: Codex's config is read then, to compare when it ends.
      const record = events.some(event => event.type === 'user') && this.deps.codexConfig ? await this.deps.store.get(id) : undefined;
      if (record?.provider === 'codex') this.codexBefore.set(id, await this.deps.codexConfig!().catch(() => undefined));
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
      // A chat Hydra can't record isn't shown either, so it must not keep running unseen: it is stopped.
      const session = this.sessions.get(id);
      this.sessions.delete(id);
      session?.close();
      this.deps.push(id, [{ type: 'error', message: `Hydra couldn't save this chat, so it stopped it: ${error instanceof Error ? error.message : String(error)}`, fatal: true }], -1);
    }
  }

  /** Every message checks trust first: a running chat's process can be replaced (idle, a new mode, a crash). */
  async send(id: string, text: string, images?: ChatImage[]): Promise<void> {
    if (!text.trim() && !images?.length) throw new Error('Type a message first.');
    for (const image of images ?? []) checkImage(image);
    if (this.closing) throw new Error('Hydra is quitting.');
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) {
      this.sessions.get(id)?.close();
      this.sessions.delete(id);
      throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    }
    (await this.session(id)).send(text, images);
  }

  /** Says so if a Codex turn added this folder (or a folder above it) to Codex's own trusted projects. Hydra never edits that file. */
  private async checkCodexTrust(id: string): Promise<void> {
    const before = this.codexBefore.get(id);
    this.codexBefore.delete(id);
    // Without a reading from before the turn there is nothing to compare: no notice rather than a false one.
    if (before === undefined) return;
    const after = await this.deps.codexConfig?.().catch(() => undefined);
    if (after === undefined || after === before) return;
    const record = await this.deps.store.get(id);
    if (!record) return;
    const was = trustedProjects(before);
    const added = [...trustedProjects(after)].filter(folder => !was.has(folder) && covers(folder, record.cwd));
    if (!added.length) return;
    const notice: ChatEvent[] = [{ type: 'error', message: `Codex marked ${added.length === 1 && added[0] === normal(record.cwd) ? 'this folder' : 'a folder containing this one'} as trusted in your ~/.codex/config.toml, which turns on that project's own config, hooks and MCP servers for Codex. Hydra didn't change that file; remove the entry there if you didn't mean to trust it.`, fatal: false }];
    const start = await this.deps.store.append(id, notice);
    this.deps.push(id, notice, start);
  }

  /**
   * Open in terminal: the CLI's own interactive resume of this chat, in a console window, for anything the chat pane
   * can't show. The chat's own process is ended first, so two processes never drive one session at once.
   */
  async openTerminal(id: string): Promise<{ started: boolean; error?: string }> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    const session = this.sessions.get(id);
    if (session?.busy) throw new Error('Stop the chat or let its turn end first.');
    const log = await this.deps.store.read(id);
    if (!record.providerSessionId || !log.some(entry => entry.event.type === 'session')) throw new Error('Send a message first: there is nothing to resume yet.');
    const executable = await this.deps.executable(record.provider);
    if (!executable) throw new Error(`${record.provider === 'claude' ? 'Claude Code' : 'Codex'} isn't installed. Check Your agents in Settings.`);
    if (!this.deps.openConsole) throw new Error('Hydra can\'t open a terminal here.');
    session?.close();
    this.sessions.delete(id);
    const args = record.provider === 'claude' ? ['--resume', record.providerSessionId] : ['resume', record.providerSessionId];
    return this.deps.openConsole(record.provider === 'claude' ? 'Claude Code chat' : 'Codex chat', executable, args, record.cwd);
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

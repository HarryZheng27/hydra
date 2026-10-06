import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClaudeAdapter } from '../../../src/core/chat/claude';
import { CodexAdapter } from '../../../src/core/chat/codex';
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatImage, ChatOptions, ChatProvider, ClaudePermissionMode, CodexApprovals, CodexSandbox } from '../../../src/core/chat/events';
import { claudePermissionModes } from '../../../src/core/chat/events';
import { claudeSessionIdPattern } from '../../../src/core/chat/claude';
import { cmdUnsafe, isWindowsShim } from '../../../src/core/process';
import { ChatSession, type Launch, type SessionTimings } from '../../../src/core/chat/session';
import { ChatStore, titleFrom, type ChatRecord, type LogEntry, pullRequestUrlPattern } from '../../../src/core/chat/store';
import { claudeCloudSessionIdPattern, type ClaudeCloudSession } from '../../../src/core/chat/cloud';

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
  /** A line for the app's log (HYDRA_APP_LOG). */
  log?(line: string): void;
  /** A terminal inside the window (G7's Continue here): its id, for the window to show. */
  startTerminal?(executable: string, args: string[], cwd: string): string;
  timings?: SessionTimings;
  /** The user's own CLI config file's text (Claude's settings.json, Codex's config.toml), for the composer's defaults. */
  cliConfig?(provider: ChatProvider): Promise<string | undefined>;
  /** Start a Claude chat's CLI when the chat is opened, ahead of its next message (the app sets this; tests don't). */
  warm?: boolean;
  /**
   * Claude cloud chats (G7, src/core/chat/cloud.ts): `start` runs `claude --cloud` for a chat's first message;
   * `worktree` makes (or finds) a fresh worktree of the project on a new branch, for Continue here.
   */
  /** The state of a pull request a chat opened (`gh pr view`), for the sidebar's PR icon; undefined when unknown. */
  prState?(url: string): Promise<'open' | 'merged' | 'closed' | undefined>;
  /** A short name for a Claude chat from its first message (chatTitles.ts); undefined leaves the first-line title. */
  titleChat?(message: string): Promise<string | undefined>;
  /** The same for a Codex chat, from Codex itself: nothing goes to Anthropic. */
  titleCodexChat?(message: string): Promise<string | undefined>;
  cloud?: {
    start(input: { executable: string; cwd: string; message: string; signal: AbortSignal }): Promise<ClaudeCloudSession>;
    worktree(cwd: string, chatId: string): Promise<string>;
  };
}

/**
 * What the user's own CLI settings choose when a chat doesn't: model, effort and mode, so the composer shows real values
 * rather than "default". Only these keys are read; nothing else in the file is kept.
 */
export interface ChatDefaults { model?: string; effort?: string; mode?: string; approvals?: string }
const shortValue = (value: unknown): string | undefined => (typeof value === 'string' && /^[\w.\-\[\]]{1,80}$/.test(value) ? value : undefined);
export function claudeDefaults(text: string | undefined): ChatDefaults {
  let settings: Record<string, unknown>;
  try { settings = JSON.parse(text ?? '{}') as Record<string, unknown>; } catch { return {}; }
  if (!settings || typeof settings !== 'object') return {};
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions as Record<string, unknown> : {};
  const mode = shortValue(permissions.defaultMode);
  const out: ChatDefaults = {};
  const model = shortValue(settings.model), effort = shortValue(settings.effortLevel);
  if (model) out.model = model;
  if (effort) out.effort = effort;
  // Bypass is never run (HSEC-82): a chat on these settings is stopped, so it isn't shown as the mode.
  if (mode && (claudePermissionModes as readonly string[]).includes(mode)) out.mode = mode;
  return out;
}
export function codexDefaults(text: string | undefined): ChatDefaults {
  const out: ChatDefaults = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // only the top-level keys, before the first table
    const match = /^\s*(model|model_reasoning_effort|approvals_reviewer)\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line);
    const value = match && shortValue(match[2]);
    if (!match || !value) continue;
    if (match[1] === 'model') out.model = value; else if (match[1] === 'model_reasoning_effort') out.effort = value; else out.approvals = value;
  }
  return out;
}

/** Image formats a chat accepts, by their first bytes: the declared type must match the file. */
const signatures: Record<ChatImage['mediaType'], (bytes: Buffer) => boolean> = {
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/gif': bytes => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')),
  'image/webp': bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * An attached image: a known type whose bytes match it. Claude's API caps an image at 5 MB of base64, about 3.75 MB of
 * image, and a refused image would be saved in the session and fail every later turn, so that is the limit for both
 * providers. The image is passed on re-encoded from its checked bytes, never as the page sent it.
 */
export function checkImage(image: ChatImage): ChatImage {
  const check = signatures[image.mediaType];
  if (!check || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('That image isn\'t a PNG, JPEG, GIF or WebP.');
  const bytes = Buffer.from(image.data, 'base64');
  const data = bytes.toString('base64');
  if (data.length > MAX_IMAGE_BASE64) throw new Error('Images can be at most about 3.7 MB.');
  if (!check(bytes)) throw new Error('That file isn\'t the image it says it is.');
  return { mediaType: image.mediaType, data };
}

/** Claude's limit for one image: 5 MB of base64. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

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

export interface NewChat { cwd: string; provider: ChatProvider; model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; approvals?: CodexApprovals; where?: 'cloud' }

/** Whether a tool call runs `gh pr create`: Claude's Bash takes a command string, Codex's an argument list or a string. */
export function opensPullRequest(input: unknown): boolean {
  const command = (input as { command?: unknown } | undefined)?.command;
  const text = typeof command === 'string' ? command : Array.isArray(command) ? command.filter(part => typeof part === 'string').join(' ') : '';
  return /(^|[\s;&|(])gh(\.exe)?\s+pr\s+create\b/.test(text);
}

export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  /** Sessions being set up, so two quick messages share one. */
  private readonly starting = new Map<string, Promise<ChatSession>>();
  private readonly titled = new Set<string>();
  /** Codex's config as it was before each Codex chat's current turn. */
  private readonly codexBefore = new Map<string, string | undefined>();
  /** Chats the user opened in a terminal: no message is sent until they say that window is closed. */
  private readonly inTerminal = new Set<string>();
  /** Set once the app is quitting: no chat starts after that. */
  private closing = false;
  /** The chat whose CLI was started ahead of a message; only one waits at a time. */
  private warmed: string | undefined;
  /** Chats removed while their session may still be starting. */
  private readonly removed = new Set<string>();
  /** Cloud chats whose first message is starting their cloud session. */
  /** A cloud chat whose `--cloud` is running, with what stops it (remove, quit). */
  private readonly cloudStarting = new Map<string, AbortController>();
  /** Chats with a message on its way (how many): their place can't change now. Claimed before send's first await. */
  private readonly sending = new Map<string, number>();
  /** Chats whose place (Local or Cloud) is being changed: a message waits for it. */
  private readonly placing = new Set<string>();

  /**
   * The home screen's spare: the agent the user has picked, started before there is a chat, so the first message
   * doesn't wait for Claude Code or Codex to start. One at a time; a chat made with the same choices takes it over.
   */
  private spare: { key: string; sessionId?: string; session: ChatSession; buffered: ChatEvent[][]; target?: string } | undefined;
  private spareToken = 0;

  constructor(private readonly deps: ChatManagerDeps) {}

  /** What must match for a new chat to take over the spare: folder, agent, model, effort and permissions. */
  private static spareKey(input: NewChat): string {
    return JSON.stringify([input.cwd.toLowerCase(), input.provider, input.model ?? '', input.effort ?? '',
      input.provider === 'claude' ? input.permissionMode ?? 'auto' : '', input.provider === 'codex' ? input.sandbox ?? 'read-only' : '', input.provider === 'codex' ? input.approvals ?? 'settings' : '']);
  }

  /** Ends the spare, unless a chat has taken it. */
  private dropSpare(): void {
    const spare = this.spare;
    this.spare = undefined;
    if (spare && !spare.target) { try { spare.session.close(); } catch { /* already gone */ } }
  }

  /**
   * Starts the agent the home screen has picked (Claude desktop starts it as you choose), in a trusted folder only,
   * never for a cloud chat. Picking something else replaces it; a chat warmed before is cooled, so one process waits.
   */
  async prepare(input: NewChat): Promise<void> {
    if (!this.deps.warm || this.closing || input.where === 'cloud' || !path.isAbsolute(input.cwd)) return;
    const key = ChatManager.spareKey(input);
    if (this.spare?.key === key) return;
    const token = ++this.spareToken;
    this.dropSpare();
    if (!(await this.deps.trusted(input.cwd))) return;
    const executable = await this.deps.executable(input.provider);
    if (!executable || this.closing || token !== this.spareToken) return;
    if (!(await this.deps.trusted(input.cwd)) || this.closing || token !== this.spareToken) return;
    const sessionId = input.provider === 'claude' ? randomUUID() : undefined;
    const options: ChatOptions = {
      provider: input.provider, cwd: input.cwd, executable,
      ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}),
      ...(input.provider === 'claude' ? { permissionMode: input.permissionMode ?? 'auto', sessionId } : { sandbox: input.sandbox ?? 'read-only', approvals: input.approvals ?? 'settings' }),
    };
    const spare: NonNullable<ChatManager['spare']> = { key, ...(sessionId ? { sessionId } : {}), buffered: [], session: undefined as unknown as ChatSession };
    // Until a chat takes it, what the process says (its / commands) waits here; then it goes to that chat.
    spare.session = new ChatSession(this.adapter(input.provider), options, this.deps.launch, events => { if (spare.target) void this.persist(spare.target, events); else spare.buffered.push(events); }, this.deps.timings);
    if (this.warmed) { this.sessions.get(this.warmed)?.cool(); this.warmed = undefined; }
    this.spare = spare;
    spare.session.warm();
  }

  private adapter(provider: ChatProvider): () => ChatAdapter {
    return this.deps.adapters?.[provider] ?? (provider === 'claude' ? () => new ClaudeAdapter() : () => new CodexAdapter());
  }

  /** The chats; an open pull request a chat made is checked again now and then, in the background, for its icon. */
  async list(): Promise<ChatRecord[]> {
    const chats = await this.deps.store.list();
    void this.refreshPullRequests(chats);
    return chats;
  }

  private readonly prCalls = new Map<string, Set<string>>();
  private readonly prChecked = new Map<string, number>();
  private async refreshPullRequests(chats: ChatRecord[]): Promise<void> {
    if (!this.deps.prState) return;
    for (const chat of chats) {
      if (chat.pr?.state !== 'open' || Date.now() - (this.prChecked.get(chat.id) ?? 0) < 120_000) continue;
      this.prChecked.set(chat.id, Date.now());
      const state = await this.deps.prState(chat.pr.url).catch(() => undefined);
      if (state && state !== chat.pr.state && !this.removed.has(chat.id)) await this.deps.store.update(chat.id, { pr: { url: chat.pr.url, state } }).catch(() => undefined);
    }
  }

  async create(input: NewChat): Promise<ChatRecord> {
    if (!path.isAbsolute(input.cwd)) throw new Error('A chat needs a project folder.');
    if (!(await this.deps.trusted(input.cwd))) throw new Error('Trust this folder before starting a chat in it.');
    if (input.where === 'cloud' && input.provider !== 'claude') throw new Error('Only Claude Code chats can run in the cloud for now.');
    this.adapter(input.provider);
    // The home's spare, if it was started with these same choices, becomes this chat's process.
    const old = this.spare;
    const spare = old && input.where !== 'cloud' && old.key === ChatManager.spareKey(input) ? old : undefined;
    this.spare = undefined;
    // A prepare still starting is outrun; a spare with other choices is ended.
    this.spareToken++;
    if (old && !spare) old.session.close();
    const record = await this.deps.store.create({
      provider: input.provider, cwd: input.cwd, ...(input.where === 'cloud' ? { where: 'cloud' as const } : {}),
      ...(input.provider === 'claude' ? { providerSessionId: spare?.sessionId ?? randomUUID(), permissionMode: input.permissionMode ?? 'auto' } : { sandbox: input.sandbox ?? 'read-only', approvals: input.approvals ?? 'settings' }),
      ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}),
    }).catch((error: unknown) => { if (spare) spare.session.close(); throw error; });
    if (spare) {
      if (this.closing) { spare.session.close(); return record; }
      spare.target = record.id;
      this.sessions.set(record.id, spare.session);
      this.warmed = record.id;
      for (const events of spare.buffered.splice(0)) void this.persist(record.id, events);
    }
    return record;
  }

  /** `warm: false` for an open the user doesn't see (the page catching up on a background chat). */
  async open(id: string, { warm = true }: { warm?: boolean } = {}): Promise<{ record: ChatRecord; log: LogEntry[]; running: boolean; inTerminal: boolean; defaults: ChatDefaults }> {
    const record = await this.record(id);
    const config = await this.deps.cliConfig?.(record.provider).catch(() => undefined);
    const defaults = record.provider === 'claude' ? claudeDefaults(config) : codexDefaults(config);
    const opened = { record, log: await this.deps.store.read(id), running: this.isRunning(id), inTerminal: this.inTerminal.has(id), defaults };
    if (warm) this.warm(id, record);
    return opened;
  }

  /**
   * Starts a chat's CLI as the chat opens, so its startup (Claude Code's about 10 s with the user's MCP servers and
   * hooks, Codex's app-server about 5 s) is done by the time they send. Codex's thread waits for the message. Only in a trusted folder, never while the chat is open in a terminal, and
   * one chat at a time: the one warmed before is ended if no message used it.
   */
  private warm(id: string, record: ChatRecord): void {
    // A cloud chat never runs the CLI here.
    if (record.where === 'cloud') return;
    if (!this.deps.warm || this.closing || this.inTerminal.has(id) || this.starting.has(id)) return;
    // Opening a chat ends the home's spare: one waiting process at a time.
    this.spareToken++;
    this.dropSpare();
    if (this.warmed && this.warmed !== id) this.sessions.get(this.warmed)?.cool();
    this.warmed = id;
    void this.session(id).then(session => {
      if (this.warmed === id && !this.closing && !this.inTerminal.has(id) && this.sessions.get(id) === session) session.warm();
    }).catch(() => undefined);
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
      ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}), ...(record.sandbox ? { sandbox: record.sandbox } : {}), ...(record.approvals ? { approvals: record.approvals } : {}),
      // A Claude chat's id is chosen at creation; it is resumed once the CLI has started it.
      ...(started && record.providerSessionId ? { resume: record.providerSessionId } : record.provider === 'claude' ? { sessionId: record.providerSessionId } : {}),
    };
    if (this.closing) throw new Error('Hydra is quitting.');
    // The folder may have stopped being trusted while this was starting.
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    // Quit or removal may have come during those awaits: nothing may start after either.
    if (this.closing) throw new Error('Hydra is quitting.');
    if (this.removed.has(id)) throw new Error('This chat was removed.');
    const session = new ChatSession(this.adapter(record.provider), options, this.deps.launch, events => void this.persist(id, events), this.deps.timings);
    this.sessions.set(id, session);
    return session;
  }

  /** Writes a chat's events to its log, keeps its index entry current, and pushes them to the window. */
  private async persist(id: string, given: ChatEvent[]): Promise<void> {
    // The / menu's command list comes on every start: the window gets it, the log doesn't (it would repeat each time).
    const live = given.filter(event => event.type === 'commands' || event.type === 'limits');
    if (live.length) { if (live.some(event => event.type === 'commands')) this.deps.log?.(`[chat] ${id}: ${live.reduce((sum, event) => sum + (event.type === 'commands' ? event.commands.length : 0), 0)} slash commands`); this.deps.push(id, live, -1); }
    const events = given.filter(event => event.type !== 'commands' && event.type !== 'limits');
    if (!events.length) return;
    try {
      // Written first, then pushed with its position, so the window can merge it with a log it is reading.
      const start = await this.deps.store.append(id, events);
      this.deps.push(id, events, start);
      if (this.codexBefore.has(id) && events.some(event => event.type === 'done')) await this.checkCodexTrust(id);
      // A Codex turn starts when its message is shown: Codex's config is read then, to compare when it ends.
      const record = events.some(event => event.type === 'user') && this.deps.codexConfig ? await this.deps.store.get(id) : undefined;
      if (record?.provider === 'codex') this.codexBefore.set(id, await this.deps.codexConfig!().catch(() => undefined));
      const patch: Partial<ChatRecord> = {};
      // A pull request this chat opened: its own `gh pr create`, and the link that command printed.
      for (const event of events) {
        if (event.type === 'tool-call' && opensPullRequest(event.input)) {
          const calls = this.prCalls.get(id) ?? new Set<string>();
          calls.add(event.id);
          this.prCalls.set(id, calls);
        } else if (event.type === 'tool-result' && this.prCalls.get(id)?.delete(event.id) && !event.isError) {
          const url = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/.exec(event.output)?.[0];
          if (url && pullRequestUrlPattern.test(url)) patch.pr = { url, state: 'open' };
        }
      }
      const session = events.find((event): event is Extract<ChatEvent, { type: 'session' }> => event.type === 'session');
      if (session) patch.providerSessionId = session.providerSessionId;
      // Claude left plan mode (an approved plan): the next process starts in the mode it is in now. A chat on the user's
      // own settings stays on them.
      const mode = session?.permissionMode;
      if (mode && mode !== 'plan' && (claudePermissionModes as readonly string[]).includes(mode)) {
        const current = await this.deps.store.get(id);
        if (current?.provider === 'claude' && current.permissionMode === 'plan') patch.permissionMode = mode as ClaudePermissionMode;
      }
      const user = events.find((event): event is Extract<ChatEvent, { type: 'user' }> => event.type === 'user');
      if (user && !this.titled.has(id)) {
        this.titled.add(id);
        const record = await this.deps.store.get(id);
        if (record?.title === 'New chat') {
          const provisional = patch.title = titleFrom(user.text);
          // Claude desktop names its sessions: a Claude chat asks Claude for a short name, and keeps it only if the
          // user hasn't renamed the chat meanwhile. A Codex chat asks Codex itself, so its message never goes to Anthropic.
          const namer = record.provider === 'claude' ? this.deps.titleChat : this.deps.titleCodexChat;
          if (namer) {
            void namer(user.text).then(async title => {
              if (!title || title === provisional || this.removed.has(id)) return;
              const current = await this.deps.store.get(id);
              if (current?.title !== provisional) return;
              await this.deps.store.update(id, { title });
              this.deps.push(id, [{ type: 'renamed', title }], -1);
            }).catch(() => undefined);
          }
        }
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
    const checked = images?.map(checkImage);
    if (this.closing) throw new Error('Hydra is quitting.');
    if (this.placing.has(id)) throw new Error("This chat's place is changing. Send it again in a moment.");
    this.sending.set(id, (this.sending.get(id) ?? 0) + 1);
    try { await this.sendClaimed(id, text, checked); } finally {
      const left = (this.sending.get(id) ?? 1) - 1;
      if (left) this.sending.set(id, left); else this.sending.delete(id);
    }
  }

  private async sendClaimed(id: string, text: string, checked?: ChatImage[]): Promise<void> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) {
      this.sessions.get(id)?.close();
      this.sessions.delete(id);
      throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    }
    if (this.inTerminal.has(id)) throw new Error('This chat is open in a terminal. Close that window, then choose "I closed the terminal".');
    if (record.where === 'cloud') { await this.sendCloud(id, record, text, checked); return; }
    (await this.session(id)).send(text, checked);
  }

  /**
   * Local or Cloud, chosen in the composer before a Claude chat's first message (G7). A local chat's CLI that was
   * started ahead of the message is stopped: a cloud chat never runs one here.
   */
  async setWhere(id: string, where: 'local' | 'cloud'): Promise<ChatRecord> {
    // Claimed before the first await, as send claims its message: neither can slip in during the other's awaits.
    if (this.sending.has(id) || this.placing.has(id)) throw new Error("A chat's place is chosen before its first message.");
    this.placing.add(id);
    try { return await this.placeClaimed(id, where); } finally { this.placing.delete(id); }
  }

  private async placeClaimed(id: string, where: 'local' | 'cloud'): Promise<ChatRecord> {
    const record = await this.record(id);
    if (where === (record.where ?? 'local')) return record;
    if (record.provider !== 'claude') throw new Error('Only Claude Code chats can run in the cloud for now.');
    if (this.cloudStarting.has(id) || this.sessions.get(id)?.busy || (await this.deps.store.read(id)).some(entry => entry.event.type === 'user')) throw new Error("A chat's place is chosen before its first message.");
    if (where === 'cloud') {
      if (this.warmed === id) this.warmed = undefined;
      this.sessions.get(id)?.close();
      this.sessions.delete(id);
    }
    const updated = await this.deps.store.update(id, { where: where === 'cloud' ? 'cloud' : undefined });
    if (where === 'local' && this.deps.warm) this.warm(id, updated);
    return updated;
  }

  /** A cloud chat's first message starts its session on claude.ai; after that the chat lives there (src/core/chat/cloud.ts). */
  private async sendCloud(id: string, record: ChatRecord, text: string, images?: ChatImage[]): Promise<void> {
    if (record.cloud) throw new Error('This chat runs on claude.ai. Open it there, or choose Continue here.');
    if (this.cloudStarting.has(id)) throw new Error("This chat's cloud session is starting.");
    if (images?.length) throw new Error("A cloud chat's first message can't carry images.");
    const cloud = this.deps.cloud;
    if (!cloud) throw new Error("Cloud chats aren't available here.");
    // Claimed before the first await, so a second send can't start a second session.
    const abort = new AbortController();
    this.cloudStarting.set(id, abort);
    try {
      const executable = await this.deps.executable('claude');
      if (!executable) throw new Error("Claude Code isn't installed. Check Your agents in Settings.");
      await this.persist(id, [{ type: 'user', text }]);
      try {
        const session = await cloud.start({ executable, cwd: record.cwd, message: text, signal: abort.signal });
        if (this.removed.has(id)) return;
        await this.deps.store.update(id, { cloud: { ...session, startedAt: new Date().toISOString() } });
        await this.persist(id, [{ type: 'cloud', ...session }, { type: 'done', status: 'success' }]);
      } catch (error) {
        if (this.removed.has(id)) return;
        await this.persist(id, [{ type: 'error', message: error instanceof Error ? error.message : String(error), fatal: false }, { type: 'done', status: 'error' }]);
      }
    } finally { this.cloudStarting.delete(id); }
  }

  /**
   * Continue here (G7): the cloud session's conversation in a console, `claude --teleport <id>` in a fresh worktree of
   * the project on a new branch. The session's file changes stay in the cloud: its copy has no git remote (spike S3).
   */
  async continueCloud(id: string): Promise<{ started: boolean; worktree?: string; error?: string; terminalId?: string }> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) throw new Error("This folder isn't trusted in Hydra, so the chat can't run here.");
    const sessionId = record.cloud?.sessionId;
    // The id goes on a command line: it must be the CLI's own id shape, which can't read as an option.
    if (!sessionId || !claudeCloudSessionIdPattern.test(sessionId)) throw new Error('This chat has no cloud session to continue.');
    if (!this.deps.cloud || (!this.deps.startTerminal && !this.deps.openConsole)) throw new Error("Hydra can't open a terminal here.");
    const executable = await this.deps.executable('claude');
    if (!executable) throw new Error("Claude Code isn't installed. Check Your agents in Settings.");
    const worktree = await this.deps.cloud.worktree(record.cwd, id);
    if (isWindowsShim(executable) && [executable, worktree].some(part => cmdUnsafe.test(part))) throw new Error("This folder's path has a character the CLI's launcher can't take safely.");
    // In the window when it can (a terminal under the chat), else a console of its own.
    if (this.deps.startTerminal) return { started: true, worktree, terminalId: this.deps.startTerminal(executable, ['--teleport', sessionId], worktree) };
    const result = await this.deps.openConsole!('Claude Code cloud session', executable, ['--teleport', sessionId], worktree);
    return { ...result, worktree };
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
  /** The folder the terminal panel's shell starts in: the chat's own, and only while the user trusts it. */
  async shellFolder(id: string): Promise<string> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra, so a terminal can\'t open in it.');
    return record.cwd;
  }

  async openTerminal(id: string): Promise<{ started: boolean; error?: string }> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra, so the chat can\'t run here.');
    const log = await this.deps.store.read(id);
    const sessionId = record.providerSessionId ?? '';
    if (!sessionId || !log.some(entry => entry.event.type === 'session')) throw new Error('Send a message first: there is nothing to resume yet.');
    // The id goes on a command line: it must be the provider's own id shape, and can't read as an option.
    const valid = record.provider === 'claude' ? claudeSessionIdPattern.test(sessionId) : /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(sessionId);
    if (!valid) throw new Error('This chat\'s session id isn\'t one Hydra can pass on.');
    const executable = await this.deps.executable(record.provider);
    if (!executable) throw new Error(`${record.provider === 'claude' ? 'Claude Code' : 'Codex'} isn't installed. Check Your agents in Settings.`);
    // A .cmd shim hands its arguments to cmd.exe, which reads characters like & and % itself.
    if (isWindowsShim(executable) && [executable, record.cwd].some(part => cmdUnsafe.test(part))) throw new Error('This folder\'s path has a character the CLI\'s launcher can\'t take safely.');
    if (!this.deps.openConsole) throw new Error('Hydra can\'t open a terminal here.');
    // Checked last, after every wait above: a turn running or starting now keeps the chat here.
    if (this.sessions.get(id)?.busy || this.starting.has(id)) throw new Error('Stop the chat or let its turn end first.');
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
    this.inTerminal.add(id);
    const args = record.provider === 'claude' ? ['--resume', sessionId] : ['resume', sessionId];
    const result = await this.deps.openConsole(record.provider === 'claude' ? 'Claude Code chat' : 'Codex chat', executable, args, record.cwd);
    if (!result.started) this.inTerminal.delete(id);
    return result;
  }

  /** The folder a chat may be reviewed in: its own, and only while that folder is trusted. */
  async reviewFolder(id: string): Promise<string> {
    const record = await this.record(id);
    if (!(await this.deps.trusted(record.cwd))) throw new Error('This folder isn\'t trusted in Hydra.');
    return record.cwd;
  }
  /** The user closed the terminal they opened this chat in: the chat can run here again (it resumes what they did). */
  terminalClosed(id: string): void { this.inTerminal.delete(id); }

  isInTerminal(id: string): boolean { return this.inTerminal.has(id); }


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

  /** Stops a turn, or a cloud chat's `--cloud` before it has started the session. */
  stop(id: string): void { this.cloudStarting.get(id)?.abort(); this.sessions.get(id)?.stop(); }

  /** True while a chat's turn runs, or a cloud chat's session is starting. */
  isRunning(id: string): boolean { return this.cloudStarting.has(id) || !!this.sessions.get(id)?.busy; }

  /** Changes model, effort or permission mode for the chat's next turn. */
  async configure(id: string, requested: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; approvals?: CodexApprovals }): Promise<ChatRecord> {
    // An empty model or effort goes back to the CLI's default.
    const change = Object.fromEntries(Object.entries(requested).map(([key, value]) => [key, value === '' ? undefined : value])) as typeof requested;
    const record = await this.deps.store.update(id, change);
    const session = this.sessions.get(id);
    if (session) {
      if (change.model && Object.keys(change).length === 1) session.setModel(change.model);
      else session.reconfigure(change);
    }
    // A process ended for the new settings starts again ahead of the next message.
    if (this.warmed === id) this.warm(id, record);
    return record;
  }

  /** The sidebar's Rename: one line, 1-200 characters. The first message no longer names the chat. */
  async rename(id: string, title: string): Promise<ChatRecord> {
    const clean = title.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('A chat needs a name.');
    if (clean.length > 200) throw new Error('A chat\'s name can be at most 200 characters.');
    await this.record(id);
    this.titled.add(id);
    return this.deps.store.update(id, { title: clean });
  }

  /** The sidebar's Archive and Unarchive. A chat that is working is left alone: stop it first. */
  async archive(id: string, archived: boolean): Promise<ChatRecord> {
    const record = await this.record(id);
    if (archived && this.isRunning(id)) throw new Error('This chat is working. Stop it, then archive it.');
    if (!!record.archivedAt === archived) return record;
    if (archived) {
      if (this.warmed === id) this.warmed = undefined;
      this.sessions.get(id)?.close();
      this.sessions.delete(id);
    }
    return this.deps.store.update(id, { archivedAt: archived ? new Date().toISOString() : undefined });
  }

  async remove(id: string): Promise<void> {
    this.removed.add(id);
    this.cloudStarting.get(id)?.abort();
    if (this.warmed === id) this.warmed = undefined;
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
    await this.deps.store.remove(id);
  }

  /** Ends every chat's process, for quit. */
  closeAll(): void {
    this.closing = true;
    this.dropSpare();
    for (const abort of this.cloudStarting.values()) abort.abort();
    for (const session of this.sessions.values()) { try { session.close(); } catch { /* keep closing the rest */ } }
    this.sessions.clear();
  }
}

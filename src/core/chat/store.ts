import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceAtomic } from '../atomicFile';
import { ownerOnlyProblem, restrictToOwner } from '../userHandshake';
import type { ChatEvent, ChatProvider, ClaudePermissionMode, CodexSandbox } from './events';

/**
 * Hydra's own record of each chat (docs/internal/hydra-app/G4-local-chat.md): an append-only JSONL log of ChatEvents
 * per chat, plus an index. It keeps the provider's session or thread id for resume and never parses a provider's
 * transcripts, whose format is the CLI's own. Every file is cut to the current user alone (on Windows, an access list
 * granting only your account, as handshakes are) and checked before anything is written into it.
 */
export interface ChatRecord {
  id: string;
  provider: ChatProvider;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerSessionId?: string;
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
}
export interface LogEntry { t: string; event: ChatEvent }

export const chatIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INDEX = 'index.json';
const MAX_CHATS = 5000;

export interface StoreSecurity {
  /** Cuts a file's access to the current user. */
  restrict(file: string): Promise<void>;
  /** Why a file isn't owner-only, or undefined. */
  problem(file: string): Promise<string | undefined>;
}
export const ownerOnly: StoreSecurity = { restrict: restrictToOwner, problem: ownerOnlyProblem };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown, max = 1024) => value === undefined || (typeof value === 'string' && value.length <= max);

function parseRecord(raw: unknown): ChatRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, provider, cwd, title, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || !chatIdPattern.test(id) || (provider !== 'claude' && provider !== 'codex')) return undefined;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof title !== 'string' || title.length > 200) return undefined;
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return undefined;
  for (const key of ['providerSessionId', 'model', 'effort', 'permissionMode', 'sandbox'] as const) if (!optionalString(raw[key], 200)) return undefined;
  const pick = (key: string) => (typeof raw[key] === 'string' ? { [key]: raw[key] } : {});
  return { id, provider, cwd, title, createdAt, updatedAt, ...pick('providerSessionId'), ...pick('model'), ...pick('effort'), ...pick('permissionMode'), ...pick('sandbox') } as ChatRecord;
}

/** True when a file is non-empty and its last byte isn't a newline. */
async function endsTorn(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally { await handle.close(); }
}

/** A chat title from its first message: one line, at most 80 characters. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return (line.length > 80 ? `${line.slice(0, 79)}…` : line) || 'New chat';
}

export class ChatStore {
  private queue: Promise<unknown> = Promise.resolve();
  private chats: Map<string, ChatRecord> | undefined;
  /** Logs already created and checked in this run. */
  private readonly checked = new Set<string>();

  constructor(readonly root: string, private readonly security: StoreSecurity = ownerOnly) {}

  private file(id: string): string {
    if (!chatIdPattern.test(id)) throw new Error('Not a chat id.');
    return path.join(this.root, `${id}.jsonl`);
  }

  /** Runs store changes one at a time. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ready(): Promise<Map<string, ChatRecord>> {
    if (this.chats) return this.chats;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let text: string | undefined;
    try { text = await readFile(path.join(this.root, INDEX), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const chats = new Map<string, ChatRecord>();
    if (text !== undefined) {
      const problem = await this.security.problem(path.join(this.root, INDEX));
      if (problem) throw new Error(`Hydra won't use its chat index: ${problem}`);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error('Hydra couldn\'t read its chat index.'); }
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.chats)) throw new Error('Hydra\'s chat index has an unknown shape.');
      for (const raw of parsed.chats) { const record = parseRecord(raw); if (record) chats.set(record.id, record); }
    }
    this.chats = chats;
    return chats;
  }

  /** Writes a new owner-only file: created empty, restricted and checked before its content goes in. */
  private async writePrivate(file: string, content: string): Promise<void> {
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
      await this.security.restrict(temporary);
      const problem = await this.security.problem(temporary);
      if (problem) throw new Error(`Hydra couldn't make a chat file private: ${problem}`);
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await replaceAtomic(temporary, file);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async saveIndex(chats: Map<string, ChatRecord>): Promise<void> {
    const ordered = [...chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await this.writePrivate(path.join(this.root, INDEX), `${JSON.stringify({ version: 1, chats: ordered }, null, 2)}\n`);
  }

  async list(): Promise<ChatRecord[]> {
    const chats = await this.serial(() => this.ready());
    return [...chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ChatRecord | undefined> { return (await this.serial(() => this.ready())).get(id); }

  create(input: Omit<ChatRecord, 'id' | 'createdAt' | 'updatedAt' | 'title'> & { title?: string }, now = new Date()): Promise<ChatRecord> {
    return this.serial(async () => {
      const chats = await this.ready();
      if (chats.size >= MAX_CHATS) throw new Error('Hydra keeps at most 5,000 chats; remove some first.');
      const record = parseRecord({ ...input, id: randomUUID(), title: input.title ?? 'New chat', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      if (!record) throw new Error('That chat isn\'t valid.');
      await this.writePrivate(this.file(record.id), '');
      this.checked.add(record.id);
      chats.set(record.id, record);
      try { await this.saveIndex(chats); } catch (error) { chats.delete(record.id); throw error; }
      return record;
    });
  }

  update(id: string, patch: Partial<Omit<ChatRecord, 'id' | 'provider' | 'createdAt'>>, now = new Date()): Promise<ChatRecord> {
    return this.serial(async () => {
      const chats = await this.ready();
      const current = chats.get(id);
      if (!current) throw new Error('No such chat.');
      const next = parseRecord({ ...current, ...patch, id, provider: current.provider, createdAt: current.createdAt, updatedAt: now.toISOString() });
      if (!next) throw new Error('That change isn\'t valid.');
      chats.set(id, next);
      try { await this.saveIndex(chats); } catch (error) { chats.set(id, current); throw error; }
      return next;
    });
  }

  /** Appends events to a chat's log. The log only grows; nothing in it is ever rewritten. */
  append(id: string, events: ChatEvent[], now = new Date()): Promise<void> {
    if (!events.length) return Promise.resolve();
    return this.serial(async () => {
      const chats = await this.ready();
      if (!chats.has(id)) throw new Error('No such chat.');
      const file = this.file(id);
      let prefix = '';
      if (!this.checked.has(id)) {
        const problem = await this.security.problem(file);
        if (problem) throw new Error(`Hydra won't write to this chat's log: ${problem}`);
        // A crash can leave half a line; end it, so it doesn't swallow the next entry.
        prefix = (await endsTorn(file)) ? '\n' : '';
        this.checked.add(id);
      }
      const t = now.toISOString();
      await appendFile(file, prefix + events.map(event => `${JSON.stringify({ t, event })}\n`).join(''), 'utf8');
    });
  }

  /** A chat's log. A torn last line (a crash mid-write) is skipped. */
  async read(id: string): Promise<LogEntry[]> {
    const file = this.file(id);
    await this.serial(() => this.ready());
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries: LogEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed) && typeof parsed.t === 'string' && isRecord(parsed.event) && typeof parsed.event.type === 'string') entries.push(parsed as unknown as LogEntry);
      } catch { /* a torn line from a crash */ }
    }
    return entries;
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const chats = await this.ready();
      if (!chats.delete(id)) return;
      await this.saveIndex(chats);
      await rm(this.file(id), { force: true });
      this.checked.delete(id);
    });
  }
}

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { replaceAtomic } from '../../../src/core/atomicFile';
import { themeSettings, type ThemeSetting } from '../shared/theme';
import type { AppSettings, AppState, CliProvider, Project } from '../shared/ipc';

/**
 * The app's own stores, in its user data folder (%APPDATA%\Hydra App): settings.json for preferences and
 * state.json for the sidebar and projects. Every read is schema-checked; a file that fails the check is set aside
 * and the defaults are used. Every write goes to a temporary file first and is moved into place with core's
 * replaceAtomic, so a crash never leaves half a file.
 *
 * CLI paths are machine settings: they live only here, are set only from a file picker main shows, and are never
 * read from a project or from anything a project contains.
 */
export const SETTINGS_FILE = 'settings.json';
export const STATE_FILE = 'state.json';

export const defaultSettings = (): AppSettings => ({ version: 1, theme: 'system', cliPaths: {} });
export const defaultState = (): AppState => ({ version: 1, sidebarOpen: true, projects: [] });

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const MAX_PATH = 1024;
/**
 * A fully qualified path with no control characters: on Windows a drive path (`C:\...`) or a UNC share, never a
 * drive-relative `\foo`, a `C:foo`, or a `\\?\` or `\\.\` device path.
 */
export const isAbsolutePath = (value: unknown, platform: NodeJS.Platform = process.platform): value is string => {
  if (typeof value !== 'string' || !value.length || value.length > MAX_PATH || /[\u0000-\u001f]/.test(value)) return false;
  if (platform !== 'win32') return value.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.test(value);
};

/** The name the sidebar shows: one line of 1 to 60 printable characters, trimmed; anything else isn't a name. */
export function cleanDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return name && name.length <= 60 ? name : undefined;
}

export function parseSettings(raw: unknown): AppSettings | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !onlyKeys(raw, ['version', 'theme', 'cliPaths', 'displayName', 'notifications'])) return undefined;
  if (raw.displayName !== undefined && cleanDisplayName(raw.displayName) === undefined) return undefined;
  let notifications: AppSettings['notifications'];
  if (raw.notifications !== undefined) {
    if (!isRecord(raw.notifications) || !onlyKeys(raw.notifications, ['whenAway']) || (raw.notifications.whenAway !== undefined && typeof raw.notifications.whenAway !== 'boolean')) return undefined;
    notifications = raw.notifications.whenAway === undefined ? {} : { whenAway: raw.notifications.whenAway };
  }
  if (!themeSettings.includes(raw.theme as ThemeSetting)) return undefined;
  if (!isRecord(raw.cliPaths) || !onlyKeys(raw.cliPaths, ['claude', 'codex'])) return undefined;
  const cliPaths: AppSettings['cliPaths'] = {};
  for (const provider of ['claude', 'codex'] as const) {
    const value = raw.cliPaths[provider];
    if (value === undefined) continue;
    if (!isAbsolutePath(value)) return undefined;
    cliPaths[provider] = value;
  }
  return { version: 1, theme: raw.theme as ThemeSetting, cliPaths, ...(notifications ? { notifications } : {}), ...(raw.displayName !== undefined ? { displayName: cleanDisplayName(raw.displayName)! } : {}) };
}

const MAX_PROJECTS = 500;
function parseProject(raw: unknown): Project | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ['id', 'path', 'name', 'trustedAt'])) return undefined;
  if (typeof raw.id !== 'string' || !/^[0-9a-f-]{8,64}$/.test(raw.id)) return undefined;
  if (!isAbsolutePath(raw.path)) return undefined;
  if (typeof raw.name !== 'string' || !raw.name || raw.name.length > 260) return undefined;
  if (raw.trustedAt !== undefined && (typeof raw.trustedAt !== 'string' || Number.isNaN(Date.parse(raw.trustedAt)))) return undefined;
  return { id: raw.id, path: raw.path, name: raw.name, ...(typeof raw.trustedAt === 'string' ? { trustedAt: raw.trustedAt } : {}) };
}

export function parseState(raw: unknown): AppState | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !onlyKeys(raw, ['version', 'sidebarOpen', 'projects'])) return undefined;
  if (typeof raw.sidebarOpen !== 'boolean' || !Array.isArray(raw.projects) || raw.projects.length > MAX_PROJECTS) return undefined;
  const projects: Project[] = [];
  for (const item of raw.projects) {
    const project = parseProject(item);
    if (!project || projects.some(other => other.id === project.id)) return undefined;
    projects.push(project);
  }
  return { version: 1, sidebarOpen: raw.sidebarOpen, projects };
}

/** Read errors Windows gives while antivirus, backup or sync software holds a file open for a moment. */
const transient = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function readRetrying(file: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.readFile(file, 'utf8'); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return undefined;
      if (!transient.has(code) || attempt >= 7) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 250)));
    }
  }
}

/**
 * One JSON file in user data, checked on read and replaced atomically on write. Writes run one at a time.
 *
 * The user's file is never lost: a file that fails its schema is moved aside before the defaults are used, and when
 * the file can't be read or moved aside, the store keeps the defaults for this session but refuses every write, so
 * it can't replace a file it never saw.
 */
export class JsonStore<T> {
  private loading: Promise<T> | undefined;
  private value: T | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** What went wrong at load, for the app to show. */
  problem: string | undefined;
  /** True when the file on disk couldn't be read or set aside: writes are refused so it is never overwritten. */
  readOnly = false;

  constructor(
    readonly file: string,
    private readonly parse: (raw: unknown) => T | undefined,
    private readonly defaults: () => T,
    private readonly replace: (temporary: string, destination: string) => Promise<void> = replaceAtomic,
  ) {}

  /** The current value. The file is read once; every caller shares that read. */
  load(): Promise<T> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<T> {
    const name = path.basename(this.file);
    let text: string | undefined;
    try { text = await readRetrying(this.file); } catch (error) {
      this.readOnly = true;
      this.problem = `Hydra couldn't read ${name} (${(error as NodeJS.ErrnoException).code ?? 'error'}), so it is using defaults and won't save changes until it restarts.`;
      return (this.value = this.defaults());
    }
    if (text === undefined) return (this.value = this.defaults());
    let parsed: T | undefined;
    try { parsed = this.parse(JSON.parse(text)); } catch { parsed = undefined; }
    if (parsed) return (this.value = parsed);
    const aside = `${this.file}.invalid-${Date.now()}`;
    try {
      await fs.rename(this.file, aside);
      this.problem = `${name} didn't match its schema. It was moved to ${path.basename(aside)}, and the defaults are used.`;
    } catch {
      this.readOnly = true;
      this.problem = `${name} didn't match its schema and couldn't be moved aside, so Hydra is using defaults and won't save changes until it restarts.`;
    }
    return (this.value = this.defaults());
  }

  /** Applies `change` to the current value, checks the result against the schema, and writes it. */
  update(change: (current: T) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.load();
      if (this.readOnly) throw new Error(this.problem ?? `Hydra won't overwrite ${path.basename(this.file)}.`);
      const checked = this.parse(JSON.parse(JSON.stringify(change(structuredClone(current)))));
      if (!checked) throw new Error(`Refused to write an invalid ${path.basename(this.file)}.`);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await this.replace(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
      this.value = checked;
      this.loading = Promise.resolve(checked);
      return checked;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const createSettingsStore = (userData: string): JsonStore<AppSettings> => new JsonStore(path.join(userData, SETTINGS_FILE), parseSettings, defaultSettings);
export const createStateStore = (userData: string): JsonStore<AppState> => new JsonStore(path.join(userData, STATE_FILE), parseState, defaultState);

/** The project for a folder, matched by resolved path (case-insensitively, as Windows does). */
export const projectFor = (state: AppState, folder: string): Project | undefined => {
  const resolved = path.resolve(folder).toLowerCase();
  return state.projects.find(project => path.resolve(project.path).toLowerCase() === resolved);
};

/** Adds a folder as a project, once: picking a folder that's already a project returns the state unchanged. */
export function addProject(state: AppState, folder: string): AppState {
  const resolved = path.resolve(folder);
  if (projectFor(state, resolved)) return state;
  return { ...state, projects: [...state.projects, { id: randomUUID(), path: resolved, name: path.basename(resolved) || resolved }] };
}

export const removeProject = (state: AppState, id: string): AppState => ({ ...state, projects: state.projects.filter(project => project.id !== id) });

/** Marks a project trusted: the user agreed that chats may run its own hooks and MCP servers. Only main's confirm calls this. */
export const trustProject = (state: AppState, id: string, now = new Date()): AppState =>
  ({ ...state, projects: state.projects.map(project => (project.id === id ? { ...project, trustedAt: now.toISOString() } : project)) });

export function setCliPath(settings: AppSettings, provider: CliProvider, file: string | undefined): AppSettings {
  const cliPaths = { ...settings.cliPaths };
  if (file === undefined) delete cliPaths[provider]; else cliPaths[provider] = path.resolve(file);
  return { ...settings, cliPaths };
}

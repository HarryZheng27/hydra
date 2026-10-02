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
/** An absolute Windows or POSIX path with no control characters. */
export const isAbsolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH && !/[\u0000-\u001f]/.test(value) && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) && !/^[\\/]{2}[?.][\\/]/.test(value);

export function parseSettings(raw: unknown): AppSettings | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !onlyKeys(raw, ['version', 'theme', 'cliPaths'])) return undefined;
  if (!themeSettings.includes(raw.theme as ThemeSetting)) return undefined;
  if (!isRecord(raw.cliPaths) || !onlyKeys(raw.cliPaths, ['claude', 'codex'])) return undefined;
  const cliPaths: AppSettings['cliPaths'] = {};
  for (const provider of ['claude', 'codex'] as const) {
    const value = raw.cliPaths[provider];
    if (value === undefined) continue;
    if (!isAbsolutePath(value)) return undefined;
    cliPaths[provider] = value;
  }
  return { version: 1, theme: raw.theme as ThemeSetting, cliPaths };
}

const MAX_PROJECTS = 500;
function parseProject(raw: unknown): Project | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ['id', 'path', 'name'])) return undefined;
  if (typeof raw.id !== 'string' || !/^[0-9a-f-]{8,64}$/.test(raw.id)) return undefined;
  if (!isAbsolutePath(raw.path)) return undefined;
  if (typeof raw.name !== 'string' || !raw.name || raw.name.length > 260) return undefined;
  return { id: raw.id, path: raw.path, name: raw.name };
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

/** One JSON file in user data, checked on read and replaced atomically on write. Writes run one at a time. */
export class JsonStore<T> {
  private value: T | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Why the file on disk was set aside at load, if it was. */
  problem: string | undefined;

  constructor(readonly file: string, private readonly parse: (raw: unknown) => T | undefined, private readonly defaults: () => T) {}

  async load(): Promise<T> {
    if (this.value) return this.value;
    let text: string | undefined;
    try { text = await fs.readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.problem = `Couldn't read ${path.basename(this.file)}.`;
    }
    let parsed: T | undefined;
    if (text !== undefined) {
      try { parsed = this.parse(JSON.parse(text)); } catch { parsed = undefined; }
      if (!parsed) {
        this.problem = `${path.basename(this.file)} didn't match its schema; it was set aside and the defaults are used.`;
        await fs.rename(this.file, `${this.file}.invalid-${Date.now()}`).catch(() => undefined);
      }
    }
    this.value = parsed ?? this.defaults();
    return this.value;
  }

  /** Applies `change` to the current value, checks the result against the schema, and writes it. */
  update(change: (current: T) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const next = change(structuredClone(await this.load()));
      const checked = this.parse(JSON.parse(JSON.stringify(next)));
      if (!checked) throw new Error(`Refused to write an invalid ${path.basename(this.file)}.`);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await replaceAtomic(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
      this.value = checked;
      return checked;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const createSettingsStore = (userData: string): JsonStore<AppSettings> => new JsonStore(path.join(userData, SETTINGS_FILE), parseSettings, defaultSettings);
export const createStateStore = (userData: string): JsonStore<AppState> => new JsonStore(path.join(userData, STATE_FILE), parseState, defaultState);

/** Adds a folder as a project, once: picking a folder that's already a project returns the state unchanged. */
export function addProject(state: AppState, folder: string): AppState {
  const resolved = path.resolve(folder);
  if (state.projects.some(project => path.resolve(project.path).toLowerCase() === resolved.toLowerCase())) return state;
  return { ...state, projects: [...state.projects, { id: randomUUID(), path: resolved, name: path.basename(resolved) || resolved }] };
}

export const removeProject = (state: AppState, id: string): AppState => ({ ...state, projects: state.projects.filter(project => project.id !== id) });

export function setCliPath(settings: AppSettings, provider: CliProvider, file: string | undefined): AppSettings {
  const cliPaths = { ...settings.cliPaths };
  if (file === undefined) delete cliPaths[provider]; else cliPaths[provider] = path.resolve(file);
  return { ...settings, cliPaths };
}

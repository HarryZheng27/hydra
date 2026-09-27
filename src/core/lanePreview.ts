import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultGateRuntime, type GateRuntime } from './gates';
import { validScreenshotUrl, type Gate } from './gates/config';
import { startApp, substitutePort, waitUntilReady, type AppServer } from './gates/screenshots';
import { redactText } from './redact';

/**
 * A lane's preview (Step E, docs/Hydra_Improvements_Pt_2.md): the project's dev server, started in
 * the lane's own worktree with the lane's own environment (a lane is your terminal, decision 3 of
 * Hydra_Improvements.md) on a free port, then opened in VS Code's Simple Browser. At most one
 * server per lane; two lanes never share a port.
 */
export interface PreviewConfig { command: string[]; url: string; readyTimeoutSeconds?: number }
export const defaultPreviewReadyTimeoutSeconds = 60;

/** Only the local machine, and a port Hydra can substitute in. Reuses the screenshots gate's rule. */
const validPreviewUrl = (url: string): boolean => validScreenshotUrl(url) && url.includes('{port}');

/** The project's screenshots gate, if it has one: its command and URL make the best preview, since it's already proven to boot the app. */
export function previewConfigFromGates(config: { gates: readonly Gate[] }): PreviewConfig | undefined {
  const gate = config.gates.find(candidate => candidate.type === 'screenshots');
  return gate && gate.type === 'screenshots' ? { command: gate.start, url: gate.url, readyTimeoutSeconds: gate.readyTimeoutSeconds } : undefined;
}

/** Validate `.hydra/preview.json`'s shape: a command as an argument list, and a loopback URL with `{port}`. */
export function parsePreviewConfig(value: unknown): PreviewConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('.hydra/preview.json must be an object.');
  const source = value as Record<string, unknown>;
  const command = source.command;
  if (!Array.isArray(command) || command.length < 1 || command.length > 64 || command.some(part => typeof part !== 'string' || !part || part.length > 4000 || part.includes('\0'))) {
    throw new Error('.hydra/preview.json: "command" must be a list of 1-64 strings, like ["npm", "run", "dev"].');
  }
  const url = source.url;
  if (typeof url !== 'string' || url.length > 2000 || !validPreviewUrl(url)) {
    throw new Error('.hydra/preview.json: "url" must be an http or https address on localhost or 127.0.0.1 with "{port}", like "http://127.0.0.1:{port}/".');
  }
  return { command: [...command] as string[], url };
}

const readOptional = async (file: string): Promise<string | undefined> => {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
};

/** `.hydra/preview.json`, read from the project's lead folder (never a worktree). Undefined when there is none. */
export async function loadPreviewConfig(folder: string): Promise<PreviewConfig | undefined> {
  const raw = await readOptional(path.join(folder, '.hydra', 'preview.json'));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`.hydra/preview.json isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  try { return parsePreviewConfig(parsed); }
  catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
}

/** Write `.hydra/preview.json` in the project's lead folder, from the one-time input box (extensionLanes.ts). */
export async function savePreviewConfig(folder: string, config: PreviewConfig): Promise<void> {
  await mkdir(path.join(folder, '.hydra'), { recursive: true });
  await writeFile(path.join(folder, '.hydra', 'preview.json'), `${JSON.stringify({ command: config.command, url: config.url }, null, 2)}\n`, 'utf8');
}

/** A shell-ish split for the one-time input box: `npm run dev -- --port {port}` → argv. Simple quoting only; good enough for a dev command. */
export function splitPreviewCommand(text: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) parts.push(match[1] ?? match[2] ?? match[3] ?? '');
  return parts;
}

export interface PreviewEntry { port: number; url: string; startedAt: number }

interface Running { app: AppServer; entry: PreviewEntry }

/**
 * At most one preview per lane. `start` is idempotent while one is already running for a lane (the
 * menu's "Preview app" just reopens the page); starting a *different* lane always gets its own port.
 */
export class LanePreviews {
  private readonly running = new Map<string, Running>();
  private readonly runtime: GateRuntime;
  constructor(private readonly options: {
    /** Test seams: a fake port, fetch, clock or terminate, as the screenshots gate's tests use. */
    runtime?: Partial<GateRuntime>;
    /** <storage>/lanes/preview: one capped log file per lane, `<laneId>.log`. */
    logDirectory: string;
    /** A server that exits on its own: its entry is already gone by the time this fires. */
    onExit?: (laneId: string, reason: string) => void;
    redact?: (text: string) => string;
  }) {
    this.runtime = { ...defaultGateRuntime(), ...options.runtime };
  }

  get(laneId: string): PreviewEntry | undefined { return this.running.get(laneId)?.entry; }

  logFile(laneId: string): string { return path.join(this.options.logDirectory, `${laneId}.log`); }

  /** Read the lane's preview log, redacted (5.1) for display. '' when there is none yet. */
  async readLog(laneId: string): Promise<string> {
    const raw = await readOptional(this.logFile(laneId));
    return raw === undefined ? '' : (this.options.redact ?? redactText)(raw);
  }

  /** Start the preview in `lane.worktree`, on a free port, and wait until it answers. Already running: return the same entry. */
  async start(lane: { id: string; worktree: string }, config: PreviewConfig): Promise<PreviewEntry> {
    const already = this.running.get(lane.id);
    if (already) return already.entry;
    // A second click while the server is still coming up waits for the same start, never a second server.
    const pending = this.starting.get(lane.id);
    if (pending) return pending;
    const started = this.launch(lane, config).finally(() => this.starting.delete(lane.id));
    this.starting.set(lane.id, started);
    return started;
  }
  private readonly starting = new Map<string, Promise<PreviewEntry>>();
  private async launch(lane: { id: string; worktree: string }, config: PreviewConfig): Promise<PreviewEntry> {
    const port = await this.runtime.freePort();
    const command = config.command.map(part => substitutePort(part, port));
    const url = substitutePort(config.url, port);
    await mkdir(this.options.logDirectory, { recursive: true });
    const app = await startApp(command, lane.worktree, port, this.logFile(lane.id), this.runtime);
    const timeoutMs = (config.readyTimeoutSeconds ?? defaultPreviewReadyTimeoutSeconds) * 1000;
    const ready = await waitUntilReady(url, timeoutMs, app, this.runtime);
    if (!ready.ok) { await app.stop(); throw new Error(ready.reason); }
    const entry: PreviewEntry = { port, url, startedAt: this.runtime.now() };
    this.running.set(lane.id, { app, entry });
    // A server that exits on its own (crash, or someone killed it) clears its entry and says why.
    void app.exited.then(() => {
      if (this.running.get(lane.id)?.app !== app) return; // already replaced or stopped
      this.running.delete(lane.id);
      const code = app.exitCode();
      this.options.onExit?.(lane.id, code === null ? 'The preview server stopped unexpectedly.' : `The preview server exited with code ${code}.`);
    });
    return entry;
  }

  /** Stop this lane's preview, if any. Stopping a lane that has none is a no-op. */
  async stop(laneId: string): Promise<void> {
    const current = this.running.get(laneId);
    if (!current) return;
    this.running.delete(laneId);
    await current.app.stop();
  }

  /** Stop every running preview: Stop all agents (5.3), and the window closing. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map(id => this.stop(id)));
  }
}

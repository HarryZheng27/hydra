import { randomUUID } from 'node:crypto';
import { cloudEnvironment, windowsCommandLine } from '../../../src/core/chat/cloud';
import { loadNodePty, terminalsUnavailable, type PtyLike } from '../../../src/core/lanePty';

/** What a terminal in the window hears: output, or that it ended. */
export interface TerminalMessage { id: string; data?: string; exit?: number }

type Spawn = (file: string, args: string[] | string, options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyLike;

/**
 * Terminals inside the app's window (G7's Continue here): a CLI in a pseudo-terminal, its output streamed to the window
 * and the window's keys written back. Only terminals main started exist; the window can write to, resize and close
 * those by id, and start none. Each is the CLI with fixed arguments, in a folder main chose.
 */
export class AppTerminals {
  private readonly open = new Map<string, PtyLike>();
  private readonly spawn: Spawn | undefined;

  constructor(private readonly deps: { appRoot?: string; send(message: TerminalMessage): void; spawn?: Spawn }) {
    this.spawn = deps.spawn ?? (() => {
      const pty = loadNodePty(deps.appRoot).module;
      return pty ? (pty.spawn.bind(pty) as unknown as Spawn) : undefined;
    })();
  }

  start(executable: string, args: string[], cwd: string): string {
    if (!this.spawn) throw new Error(terminalsUnavailable);
    const env = Object.fromEntries(Object.entries(cloudEnvironment(process.env)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    // On Windows the command line is quoted here, not by node-pty (windowsCommandLine says why).
    const term = this.spawn(executable, process.platform === 'win32' ? windowsCommandLine(args) : args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env });
    const id = randomUUID();
    this.open.set(id, term);
    term.onData(data => this.deps.send({ id, data }));
    term.onExit(({ exitCode }) => { this.open.delete(id); this.deps.send({ id, exit: exitCode }); });
    return id;
  }

  write(id: string, data: string): void { this.open.get(id)?.write(data); }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) return;
    try { this.open.get(id)?.resize(cols, rows); } catch { /* it has just ended */ }
  }

  close(id: string): void {
    const term = this.open.get(id);
    this.open.delete(id);
    try { term?.kill(); } catch { /* already gone */ }
  }

  /** On quit: no CLI is left running behind the window. */
  closeAll(): void { for (const id of [...this.open.keys()]) this.close(id); }
}

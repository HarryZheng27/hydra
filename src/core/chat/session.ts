import type { ChatAdapter, ChatAnswer, ChatEvent, ChatImage, ChatOptions } from './events';

/**
 * One chat's CLI process (docs/internal/hydra-app/G4-local-chat.md, G1's decisions): the process starts with the
 * first message, runs one turn at a time from a queue, and is ended after an idle timeout or when the chat closes. The
 * next message then starts a new process that resumes the provider's session. Stop asks the CLI to interrupt, and ends
 * the process if it doesn't stop in time. Malformed output or an unexpected exit ends the turn with an error; nothing
 * is retried on its own.
 */
export interface ChatProcess {
  write(line: string): void;
  /** Ends the process and everything it started. */
  kill(): void;
}
export interface ProcessHandlers { line(line: string): void; exit(code: number | null): void; error(error: Error): void }
/** Starts a CLI. The host decides how (core's processLaunch on Windows), and must never show a window. */
export type Launch = (executable: string, args: string[], cwd: string, handlers: ProcessHandlers) => ChatProcess;

/** `warmMs`: how long a process started ahead of a message waits for one. */
export interface SessionTimings { idleMs: number; stopGraceMs: number; warmMs?: number }
export const defaultTimings: SessionTimings = { idleMs: 10 * 60_000, stopGraceMs: 5_000, warmMs: 3 * 60_000 };

type Turn = { text: string; images?: ChatImage[] };

export class ChatSession {
  private process: ChatProcess | undefined;
  private started = false;
  private readonly queue: Turn[] = [];
  private turnRunning = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private providerSessionId: string | undefined;
  private closed = false;
  /** The process we ended on purpose: its exit is expected and reports nothing. */
  private retiring: ChatProcess | undefined;
  /** The options changed since the running process started: it is replaced before the next turn. */
  private stale = false;
  /** The process was started ahead of a message and hasn't run a turn yet. */
  private warmed = false;

  constructor(
    private readonly makeAdapter: () => ChatAdapter,
    private options: ChatOptions,
    private readonly launch: Launch,
    private readonly emit: (events: ChatEvent[]) => void,
    private readonly timings: SessionTimings = defaultTimings,
  ) {
    this.providerSessionId = options.resume;
  }

  private adapter: ChatAdapter | undefined;

  get busy(): boolean { return this.turnRunning || this.queue.length > 0; }
  get alive(): boolean { return !!this.process; }
  get sessionId(): string | undefined { return this.providerSessionId; }

  /**
   * Queues a message. It is sent when the turn before it ends, and its `user` event is emitted then, so each turn's
   * events follow its own message (a card shown during a turn belongs to that turn).
   */
  send(text: string, images?: ChatImage[]): void {
    if (this.closed) throw new Error('This chat is closed.');
    this.queue.push({ text, ...(images?.length ? { images } : {}) });
    this.pump();
  }

  /** Messages waiting for the current turn to end. */
  get queued(): number { return this.queue.length; }

  answer(id: string, answer: ChatAnswer): void {
    if (!this.adapter || !this.process) throw new Error('This chat isn\'t running.');
    const { lines, events } = this.adapter.answer(id, answer);
    for (const line of lines) this.process.write(line);
    this.emit(events);
  }

  /** Asks the CLI to stop the current turn; ends the process if it hasn't stopped within the grace period. */
  stop(): void {
    this.queue.length = 0;
    if (!this.turnRunning || !this.adapter || !this.process) return;
    for (const line of this.adapter.interrupt()) this.process.write(line);
    clearTimeout(this.stopTimer);
    const process = this.process;
    this.stopTimer = setTimeout(() => {
      if (this.process !== process || !this.turnRunning) return;
      this.endProcess();
      this.finishTurn([{ type: 'done', status: 'interrupted', detail: 'The CLI didn\'t stop in time, so Hydra ended it.' }]);
    }, this.timings.stopGraceMs);
  }

  /** Ends the chat's process. A later message would need a new session. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    clearTimeout(this.idleTimer);
    clearTimeout(this.stopTimer);
    if (this.turnRunning) this.finishTurn([{ type: 'done', status: 'interrupted', detail: 'The chat was closed.' }]);
    this.endProcess();
  }

  /**
   * Starts the CLI ahead of the first message, so its startup (loading the user's MCP servers and hooks) overlaps
   * their typing. Nothing is sent; a process no message reaches ends after `warmMs`. A failure here says nothing: the
   * next message starts the CLI again and reports it.
   */
  warm(): void {
    if (this.closed || this.process || this.turnRunning || this.queue.length) return;
    if (!this.spawn(true)) return;
    this.warmed = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.turnRunning && !this.queue.length) this.endProcess(); }, this.timings.warmMs ?? this.timings.idleMs);
  }

  /** Ends a process started by `warm()` that no message has used, when another chat is warmed instead. */
  cool(): void {
    if (this.warmed && this.process && !this.turnRunning && !this.queue.length) this.endProcess();
  }

  /** Switches model: in place when the CLI can, and for every later process either way. */
  setModel(model: string): void {
    this.options = { ...this.options, model };
    if (this.process && this.adapter?.setModel) for (const line of this.adapter.setModel(model)) this.process.write(line);
  }

  /** Changes model, effort or mode for the next process. The running one, if any, is ended when idle. */
  reconfigure(change: Partial<Pick<ChatOptions, 'model' | 'effort' | 'permissionMode' | 'sandbox' | 'approvals'>>): void {
    this.options = { ...this.options, ...change };
    // Mid-turn, the process finishes its turn and is replaced before anything else is sent, so a tighter
    // permission mode applies to every later message.
    if (this.turnRunning) this.stale = true; else this.endProcess();
  }

  private pump(): void {
    if (this.turnRunning || !this.queue.length || this.closed) return;
    clearTimeout(this.idleTimer);
    if (!this.process && !this.spawn()) return;
    // (spawn() reports its own failure; the message isn't shown as sent)
    const turn = this.queue.shift()!;
    this.turnRunning = true;
    this.warmed = false;
    this.emit([{ type: 'user', text: turn.text, ...(turn.images?.length ? { images: turn.images.length } : {}) }]);
    for (const line of this.adapter!.send(turn.text, turn.images)) this.process!.write(line);
  }

  private spawn(quiet = false): boolean {
    const adapter = this.makeAdapter();
    // Resume once the CLI has reported its session (Claude saves it then); a first start that died earlier starts again.
    const options: ChatOptions = this.started && this.providerSessionId
      ? { ...this.options, resume: this.providerSessionId, sessionId: undefined }
      : this.options;
    let args: string[];
    try { args = adapter.args(options); } catch (error) {
      if (quiet) return false;
      this.queue.length = 0;
      this.emit([{ type: 'error', message: error instanceof Error ? error.message : String(error), fatal: true, code: 'spawn' }, { type: 'done', status: 'error' }]);
      return false;
    }
    let process: ChatProcess;
    try {
      process = this.launch(options.executable, args, options.cwd, {
        line: line => { if (this.process === process) this.onLine(line); },
        exit: code => this.onExit(process, code),
        error: error => this.onError(process, error),
      });
    } catch (error) {
      if (quiet) return false;
      this.queue.length = 0;
      this.emit([{ type: 'error', message: `Hydra couldn't start ${options.provider === 'claude' ? 'Claude Code' : 'Codex'}: ${error instanceof Error ? error.message : String(error)}`, fatal: true, code: 'spawn' }, { type: 'done', status: 'error' }]);
      return false;
    }
    this.adapter = adapter;
    this.process = process;
    this.stale = false;
    for (const line of adapter.start(options)) process.write(line);
    return true;
  }

  private onLine(line: string): void {
    const adapter = this.adapter!;
    const { events, replies } = adapter.feed(line);
    for (const reply of replies) this.process?.write(reply);
    for (const event of events) if (event.type === 'session') { this.providerSessionId = event.providerSessionId; this.started = true; }
    const fatal = events.some(event => event.type === 'error' && event.fatal);
    const done = events.some(event => event.type === 'done');
    if (fatal) {
      // Malformed output: stop safely. The process is ended and the turn reported as failed; nothing is retried.
      this.emit(events);
      this.endProcess();
      if (this.turnRunning) this.finishTurn([{ type: 'done', status: 'error', detail: 'The CLI\'s output couldn\'t be read.' }]);
      return;
    }
    if (done) {
      // Codex keeps an interrupted command running until its app-server exits (G1), so a stopped turn ends it.
      if (adapter.endAfterInterrupt && events.some(event => event.type === 'done' && event.status === 'interrupted')) {
        this.finishTurn(events);
        this.endProcess();
        return;
      }
      this.finishTurn(events);
      return;
    }
    this.emit(events);
  }

  private finishTurn(events: ChatEvent[]): void {
    clearTimeout(this.stopTimer);
    this.turnRunning = false;
    this.emit(events);
    if (this.stale) this.endProcess();
    if (this.queue.length) { this.pump(); return; }
    clearTimeout(this.idleTimer);
    if (this.process && !this.closed) this.idleTimer = setTimeout(() => { if (!this.turnRunning && !this.queue.length) this.endProcess(); }, this.timings.idleMs);
  }

  private endProcess(): void {
    clearTimeout(this.idleTimer);
    this.warmed = false;
    // Requests the process was waiting on can't be answered any more.
    const cancelled = this.adapter?.cancelAll() ?? [];
    if (cancelled.length) this.emit(cancelled);
    const process = this.process;
    this.process = undefined;
    this.adapter = undefined;
    if (process) { this.retiring = process; process.kill(); }
  }

  private onExit(process: ChatProcess, code: number | null): void {
    if (process === this.retiring) { this.retiring = undefined; return; }
    if (process !== this.process) return;
    const cancelled = this.adapter?.cancelAll() ?? [];
    if (cancelled.length) this.emit(cancelled);
    this.process = undefined;
    this.adapter = undefined;
    if (this.turnRunning) {
      this.queue.length = 0;
      this.finishTurn([{ type: 'error', message: `The CLI ended unexpectedly (exit ${code ?? 'unknown'}). Send a message to resume the chat.`, fatal: true, code: 'exited' }, { type: 'done', status: 'error' }]);
    }
  }

  private onError(process: ChatProcess, error: Error): void {
    if (process !== this.process) return;
    this.process = undefined;
    this.adapter = undefined;
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    this.queue.length = 0;
    const events: ChatEvent[] = [{ type: 'error', message: missing ? 'The CLI isn\'t installed where Hydra looked. Check Your agents in Settings.' : `The CLI failed: ${error.message}`, fatal: true, code: missing ? 'missing-cli' : 'spawn' }];
    // Between turns (a process started ahead of a message, or an idle one) nothing is shown: the next message reports it.
    if (this.turnRunning) this.finishTurn([...events, { type: 'done', status: 'error' }]);
  }
}

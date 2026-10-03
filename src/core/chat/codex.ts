import type { ChatAdapter, ChatAnswer, ChatEvent, ChatImage, ChatOptions, ChatModel } from './events';
import { codexSandboxes } from './events';

/**
 * Codex as a chat (G1's S2 decisions): one `codex app-server` per chat, JSON-RPC over stdio.
 * - The thread always starts read-only, with approvals routed to the user (`approvalsReviewer: "user"`, so a user's
 *   own auto-review setting can't hide them); a thread that comes back otherwise stops the chat. `thread/start` with
 *   workspace-write would write the folder into the user's config.toml as trusted (G1), so write access would be asked
 *   per turn, through turn/start's `sandboxPolicy`. That route is not live-tested yet: `codexWriteVerified` keeps it off
 *   until a live check records that it neither persists trust nor fails under the Windows sandbox.
 * - Stop interrupts the turn, and then ends the app-server: G1 found an interrupted command keeps running until the
 *   app-server exits.
 * - Model and effort are checked against `model/list`: Codex accepts an unknown effort.
 * - Only the two approval requests are answered; every other server request is refused.
 */
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,79}$/;
const threadIdPattern = /^[A-Za-z0-9-]{8,80}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Whether the per-turn write route has passed a live check (scripts/app-live/codex.mjs). Off until it has. */
export const codexWriteVerified = false;

export function codexArguments(options: ChatOptions): string[] {
  if (options.sandbox === 'workspace-write' && !codexWriteVerified) throw new Error('Codex chats are read-only for now: letting Codex edit the folder hasn\'t passed its live check.');
  if (options.sandbox !== undefined && !codexSandboxes.includes(options.sandbox)) throw new Error(`Sandbox ${String(options.sandbox)} isn't allowed in a chat.`);
  if (options.model !== undefined && !modelPattern.test(options.model)) throw new Error('That model name isn\'t valid.');
  if (options.resume !== undefined && !threadIdPattern.test(options.resume)) throw new Error('That Codex thread id isn\'t valid.');
  return ['app-server', '--listen', 'stdio://'];
}

type Pending = { method: string; rpcId: number | string; decisions: string[] };
type Waiting = { text: string; images: ChatImage[] };

export class CodexAdapter implements ChatAdapter {
  readonly provider = 'codex' as const;
  private nextId = 1;
  /** Our requests waiting for a response: id -> what it was. */
  private readonly calls = new Map<number, string>();
  private readonly requests = new Map<string, Pending>();
  private options!: ChatOptions;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private running = false;
  private interrupted = false;
  /** A usage-limit error was already shown for this turn, so turn/completed's copy of it isn't. */
  private limitShown = false;
  private models: ChatModel[] | undefined;
  /** A message sent before the thread was ready: it starts the turn once the thread exists. */
  private waiting: Waiting | undefined;
  /** Commands by item id, for the approval card's description. */
  private readonly commands = new Map<string, string>();

  get idle(): boolean { return !this.running; }

  args(options: ChatOptions): string[] { return codexArguments(options); }

  private request(method: string, params?: unknown): string {
    const id = this.nextId++;
    this.calls.set(id, method);
    return JSON.stringify(params === undefined ? { id, method } : { id, method, params });
  }

  start(options: ChatOptions): string[] {
    this.options = options;
    const lines = [
      this.request('initialize', { clientInfo: { name: 'hydra-app', title: 'Hydra', version: '0' }, capabilities: { experimentalApi: false } }),
      JSON.stringify({ method: 'initialized', params: {} }),
    ];
    const thread = { cwd: options.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', ...(options.model ? { model: options.model } : {}) };
    if (options.resume) {
      this.threadId = options.resume;
      lines.push(this.request('thread/resume', { threadId: options.resume, ...thread }));
    } else {
      // A new thread checks its model and effort against the CLI's own list first.
      lines.push(this.request('model/list', {}));
      lines.push(this.request('thread/start', { ...thread, ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}) }));
    }
    return lines;
  }

  send(message: string, images: ChatImage[] = []): string[] {
    this.running = true;
    this.interrupted = false;
    if (!this.threadId || this.calls.size) { this.waiting = { text: message, images }; return []; }
    return [this.turnStart(message, images)];
  }

  private turnStart(message: string, images: ChatImage[]): string {
    const input: unknown[] = message.trim() ? [{ type: 'text', text: message, text_elements: [] }] : [];
    for (const image of images) input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    const effort = this.checkedEffort();
    // G1's shape: the thread's own root only (no extra roots, which the unelevated sandbox refuses), no temp folders.
    const write = this.options.sandbox === 'workspace-write' && codexWriteVerified
      ? { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }
      : {};
    return this.request('turn/start', { threadId: this.threadId, input, ...(this.options.model ? { model: this.options.model } : {}), ...(effort ? { effort } : {}), ...write });
  }

  /** The chosen effort if the chosen model supports it, from model/list; Codex itself accepts any. */
  private checkedEffort(): string | undefined {
    const effort = this.options.effort;
    if (!effort) return undefined;
    if (!this.models) return effort;
    const model = this.models.find(m => m.id === this.options.model) ?? this.models.find(m => m.isDefault);
    return model && !model.efforts.includes(effort) ? undefined : effort;
  }

  interrupt(): string[] {
    if (!this.running) return [];
    this.interrupted = true;
    if (this.waiting) {
      // The turn never started: it ends here.
      this.waiting = undefined;
      return [];
    }
    // Without the turn's id yet, the interrupt goes out as soon as it is known (turn/start's answer or turn/started).
    return this.threadId && this.turnId ? [this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })] : [];
  }

  /** Codex's model applies from the next turn: turn/start carries it. */
  setModel(model: string): string[] {
    if (!modelPattern.test(model)) throw new Error('That model name isn\'t valid.');
    this.options = { ...this.options, model };
    return [];
  }

  /** Codex can't stop a running command except by ending the app-server (G1), so a stopped turn ends the process. */
  readonly endAfterInterrupt = true;

  pending(): string[] { return [...this.requests.keys()]; }

  cancelAll(): ChatEvent[] {
    const events: ChatEvent[] = [...this.requests.keys()].map(id => ({ type: 'resolved', id, outcome: 'cancelled', by: 'hydra' }));
    this.requests.clear();
    return events;
  }

  feed(line: string): { events: ChatEvent[]; replies: string[] } {
    if (!line.trim()) return { events: [], replies: [] };
    let message: unknown;
    try { message = JSON.parse(line); } catch { return { events: [{ type: 'error', message: 'Codex printed something Hydra couldn\'t read, so the chat stopped.', fatal: true, code: 'malformed' }], replies: [] }; }
    if (!isRecord(message)) return { events: [{ type: 'error', message: 'Codex sent a message Hydra couldn\'t read, so the chat stopped.', fatal: true, code: 'malformed' }], replies: [] };
    if (typeof message.method === 'string' && 'id' in message) return this.serverRequest(message.method, message.id, isRecord(message.params) ? message.params : {});
    if (typeof message.method === 'string') return { events: this.notification(message.method, isRecord(message.params) ? message.params : {}), replies: [] };
    if ('id' in message) return this.response(message);
    return { events: [], replies: [] };
  }

  private response(message: Record<string, unknown>): { events: ChatEvent[]; replies: string[] } {
    const id = typeof message.id === 'number' ? message.id : NaN;
    const method = this.calls.get(id);
    this.calls.delete(id);
    if (!method) return { events: [], replies: [] };
    const result = isRecord(message.result) ? message.result : {};
    const events: ChatEvent[] = [];
    if (isRecord(message.error)) {
      const detail = text(message.error.message).slice(0, 500) || 'an error';
      events.push({ type: 'error', message: `Codex refused ${method}: ${detail}`, fatal: method === 'thread/start' || method === 'thread/resume' || method === 'initialize' });
      if (method === 'turn/start' && this.running) { this.running = false; events.push({ type: 'done', status: 'error' }); }
      return { events, replies: [] };
    }
    if (method === 'model/list' && Array.isArray(result.data)) {
      this.models = result.data.filter(isRecord).filter(model => model.hidden !== true && typeof model.id === 'string').map(model => ({
        id: String(model.id), label: text(model.displayName) || String(model.id), isDefault: model.isDefault === true,
        efforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter(isRecord).map(option => text(option.reasoningEffort)).filter(Boolean) : [],
        ...(typeof model.defaultReasoningEffort === 'string' ? { defaultEffort: model.defaultReasoningEffort } : {}),
      }));
      events.push({ type: 'models', models: this.models });
      if (this.options.model && !this.models.some(model => model.id === this.options.model)) events.push({ type: 'error', message: `Codex doesn't offer ${this.options.model}; it will use its default model.`, fatal: false });
      if (this.options.effort && this.checkedEffort() === undefined) events.push({ type: 'error', message: `That model doesn't support ${this.options.effort} effort; Codex will use its default.`, fatal: false });
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      if (!isRecord(result.thread) || typeof result.thread.id !== 'string') return { events: [{ type: 'error', message: `Codex didn't say which thread it ${method === 'thread/start' ? 'started' : 'resumed'}, so the chat stopped.`, fatal: true }], replies: [] };
      // The thread must come back exactly as asked: approvals for the user to answer, and read-only. Anything else
      // (a profile or managed setting overriding it) stops the chat before a turn can run.
      if (result.approvalsReviewer !== 'user' || !isRecord(result.sandbox) || result.sandbox.type !== 'readOnly') {
        return { events: [{ type: 'error', message: 'Codex started this chat without sending its approvals to you, or with more than read-only access, so Hydra stopped it.', fatal: true }], replies: [] };
      }
      this.threadId = result.thread.id;
      events.push({ type: 'session', providerSessionId: result.thread.id, ...(typeof result.model === 'string' ? { model: result.model } : {}), ...(typeof result.approvalPolicy === 'string' ? { permissionMode: result.approvalPolicy } : {}) });
    }
    if (method === 'turn/start' && isRecord(result.turn) && typeof result.turn.id === 'string') {
      this.turnId = result.turn.id;
      if (this.interrupted && this.running) return { events, replies: [this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })] };
    }
    const replies: string[] = [];
    // The thread is ready and nothing else is outstanding: a message sent meanwhile starts its turn now.
    if (this.waiting && this.threadId && !this.calls.size) {
      const { text: body, images } = this.waiting;
      this.waiting = undefined;
      replies.push(this.turnStart(body, images));
    }
    return { events, replies };
  }

  private notification(method: string, params: Record<string, unknown>): ChatEvent[] {
    if (params.threadId !== undefined && this.threadId && params.threadId !== this.threadId) return [];
    switch (method) {
      case 'turn/started': if (isRecord(params.turn) && typeof params.turn.id === 'string') this.turnId = params.turn.id; return [];
      // (an interrupt waiting for the turn id went out with turn/start's answer)
      case 'item/agentMessage/delta': return text(params.delta) ? [{ type: 'text', delta: text(params.delta), block: text(params.itemId) }] : [];
      case 'item/reasoning/textDelta': case 'item/reasoning/summaryTextDelta': return text(params.delta) ? [{ type: 'thinking', delta: text(params.delta), block: text(params.itemId) }] : [];
      case 'item/started': return this.itemStarted(isRecord(params.item) ? params.item : {});
      case 'item/completed': return this.itemCompleted(isRecord(params.item) ? params.item : {});
      case 'thread/tokenUsage/updated': {
        const usage = isRecord(params.tokenUsage) && isRecord(params.tokenUsage.last) ? params.tokenUsage.last : undefined;
        if (!usage) return [];
        const n = (value: unknown) => (typeof value === 'number' ? value : undefined);
        return [{ type: 'usage', inputTokens: n(usage.inputTokens), outputTokens: n(usage.outputTokens), cachedTokens: n(usage.cachedInputTokens), ...(isRecord(params.tokenUsage) && typeof params.tokenUsage.modelContextWindow === 'number' ? { contextWindow: params.tokenUsage.modelContextWindow } : {}) }];
      }
      case 'serverRequest/resolved': {
        const id = String(params.requestId);
        if (!this.requests.has(id)) return [];
        this.requests.delete(id);
        return [{ type: 'resolved', id, outcome: 'cancelled', by: 'hydra', note: 'Codex no longer needs this answer.' }];
      }
      case 'error': {
        const error = isRecord(params.error) ? params.error : {};
        const limit = error.codexErrorInfo === 'usageLimitExceeded' || (isRecord(error.codexErrorInfo) && 'usageLimitExceeded' in error.codexErrorInfo);
        // An error Codex retries by itself isn't the end of anything.
        if (params.willRetry === true) return [];
        if (limit) this.limitShown = true;
        return [{ type: 'error', message: text(error.message).slice(0, 2000) || 'Codex reported an error.', fatal: false, ...(limit ? { code: 'limit' as const } : {}) }];
      }
      case 'turn/completed': {
        if (!this.running) return [];
        const turn = isRecord(params.turn) ? params.turn : {};
        if (this.turnId && typeof turn.id === 'string' && turn.id !== this.turnId) return [];
        const status = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'error' : 'success';
        this.running = false;
        this.interrupted = false;
        this.turnId = undefined;
        const limitShown = this.limitShown;
        this.limitShown = false;
        const events: ChatEvent[] = [];
        this.commands.clear();
        if (status === 'error' && isRecord(turn.error) && text(turn.error.message) && !limitShown) events.push({ type: 'error', message: text(turn.error.message).slice(0, 2000), fatal: false });
        events.push(...this.cancelAll(), { type: 'done', status, ...(status === 'interrupted' ? { detail: 'Codex was stopped, along with any command it was running.' } : {}) });
        return events;
      }
      default: return [];
    }
  }

  private itemStarted(item: Record<string, unknown>): ChatEvent[] {
    const id = text(item.id);
    if (item.type === 'commandExecution') {
      this.commands.set(id, text(item.command));
      return [{ type: 'tool-call', id, name: 'Shell', input: { command: text(item.command), cwd: text(item.cwd) } }];
    }
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      const events: ChatEvent[] = [{ type: 'tool-call', id, name: 'Edit files', input: { files: item.changes.filter(isRecord).map(change => text(change.path)) } }];
      for (const change of item.changes.filter(isRecord)) {
        const kind = isRecord(change.kind) ? text(change.kind.type) : text(change.kind);
        events.push({ type: 'file-change', id, path: text(change.path), kind: kind === 'add' || kind === 'update' || kind === 'delete' ? kind : 'unknown', ...(typeof change.diff === 'string' ? { diff: change.diff.slice(0, 200_000) } : {}) });
      }
      return events;
    }
    if (item.type === 'mcpToolCall') return [{ type: 'tool-call', id, name: `${text(item.server)}/${text(item.tool)}`, input: item.arguments ?? {} }];
    if (item.type === 'webSearch') return [{ type: 'tool-call', id, name: 'Web search', input: { query: text(item.query) } }];
    return [];
  }

  private itemCompleted(item: Record<string, unknown>): ChatEvent[] {
    const id = text(item.id);
    if (item.type === 'commandExecution') {
      const status = text(item.status);
      const output = text(item.aggregatedOutput) || (status === 'declined' ? 'Declined.' : '');
      return [{ type: 'tool-result', id, output: output.slice(0, 100_000), isError: status === 'failed' || status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0) }];
    }
    if (item.type === 'fileChange') return [{ type: 'tool-result', id, output: text(item.status) === 'completed' ? 'Applied.' : `Not applied (${text(item.status) || 'unknown'}).`, isError: text(item.status) !== 'completed' }];
    if (item.type === 'mcpToolCall' || item.type === 'webSearch') return [{ type: 'tool-result', id, output: JSON.stringify(item.result ?? item.error ?? '').slice(0, 100_000), isError: !!item.error }];
    return [];
  }

  private serverRequest(method: string, rpcId: unknown, params: Record<string, unknown>): { events: ChatEvent[]; replies: string[] } {
    if (typeof rpcId !== 'number' && typeof rpcId !== 'string') return { events: [], replies: [] };
    const id = String(rpcId);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const command = method.startsWith('item/command');
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions.map(d => (typeof d === 'string' ? d : isRecord(d) ? Object.keys(d)[0] ?? '' : '')).filter(Boolean) : ['accept', 'acceptForSession', 'decline'];
      this.requests.set(id, { method, rpcId, decisions });
      const input = command ? { command: text(params.command), cwd: text(params.cwd) } : { item: text(params.itemId), ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}) };
      return {
        events: [{
          type: 'approval', id, kind: command ? 'command' : 'file', tool: command ? 'Shell' : 'Edit files', input,
          ...(typeof params.reason === 'string' ? { description: params.reason } : command ? { description: this.commands.get(text(params.itemId)) ?? '' } : {}),
          // G1 saw acceptForSession work even where availableDecisions didn't list it (it covers repeated commands,
          // not a second patch), so it is always offered.
          choices: ['allow', 'allow-session', 'deny'],
        }],
        replies: [],
      };
    }
    // Questions, elicitations and anything else: refused, never answered by default (G1).
    return {
      events: [{ type: 'error', message: `Codex asked for something Hydra doesn't handle (${method.slice(0, 60)}); it was refused.`, fatal: false, code: 'unknown-request' }],
      replies: [JSON.stringify({ id: rpcId, error: { code: -32601, message: `Hydra doesn't handle ${method}.` } })],
    };
  }

  answer(id: string, answer: ChatAnswer): { lines: string[]; events: ChatEvent[] } {
    const pending = this.requests.get(id);
    if (!pending) throw new Error('That request is no longer waiting for an answer.');
    if (answer.kind !== 'approval') throw new Error('Codex only asks for approvals.');
    if (answer.updatedInput !== undefined) throw new Error('Codex requests can\'t be edited.');
    const decision = answer.decision === 'allow' ? 'accept' : answer.decision === 'allow-session' ? 'acceptForSession' : 'decline';
    this.requests.delete(id);
    return { lines: [JSON.stringify({ id: pending.rpcId, result: { decision } })], events: [{ type: 'resolved', id, outcome: decision === 'decline' ? 'denied' : 'allowed', by: 'user' }] };
  }
}

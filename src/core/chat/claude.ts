import type { ChatAdapter, ChatAnswer, ChatEvent, ChatImage, ChatOptions, ChatQuestion } from './events';
import { claudePermissionModes } from './events';

/**
 * Claude Code as a chat (G1's route A): `claude -p` with stream-json both ways and `--permission-prompt-tool stdio`,
 * so every permission prompt, question and plan approval arrives as a `control_request` `can_use_tool` on stdout and
 * is answered with a `control_response` on stdin. Nothing here reads Claude's transcripts on disk.
 */
export const claudeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Extra arguments (live checks only): plain strings, no line breaks. */
export function extraArguments(options: ChatOptions): string[] {
  const extra = options.extraArgs ?? [];
  if (!extra.every(arg => typeof arg === 'string' && !/[\r\n\u0000]/.test(arg))) throw new Error('An extra argument isn\'t allowed.');
  return extra;
}

export function claudeArguments(options: ChatOptions): string[] {
  const id = options.resume ?? options.sessionId;
  if (!id || !claudeSessionIdPattern.test(id)) throw new Error('A Claude chat needs a valid session id.');
  const mode = options.permissionMode ?? 'default';
  if (!claudePermissionModes.includes(mode)) throw new Error(`Permission mode ${String(mode)} isn't allowed in a chat.`);
  if (options.model !== undefined && !modelPattern.test(options.model)) throw new Error('That model name isn\'t valid.');
  if (options.effort !== undefined && !efforts.includes(options.effort)) throw new Error('That effort isn\'t valid.');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(options.resume ? ['--resume', id] : ['--session-id', id]),
    // What Claude still asks about comes to Hydra's cards; `settings` lets the user's own mode decide what that is.
    '--permission-prompt-tool', 'stdio', ...(mode === 'settings' ? [] : ['--permission-mode', mode]),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--effort', options.effort] : []),
    ...extraArguments(options),
  ];
}

/**
 * A chat on "your settings" passes no mode, so the user's or a project's settings could put Claude in bypass
 * permissions; Hydra never runs a chat that way (HSEC-82). Claude says its mode before any turn: the chat stops then.
 */
const refusedMode = (mode: unknown): boolean => mode === 'bypassPermissions';
const bypassRefused: ChatEvent = { type: 'error', message: 'Claude Code started in bypass permissions mode (from your settings or this project\'s), which Hydra doesn\'t run. Pick another mode for this chat, or change that setting.', fatal: true };

type Pending = { kind: 'approval' | 'question' | 'plan'; requestId: string; input: Record<string, unknown> };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Tool results arrive as a string or as content blocks; only their text is kept. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => (isRecord(block) && block.type === 'text' ? text(block.text) : isRecord(block) && block.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  return '';
}

function parseQuestions(input: Record<string, unknown>): ChatQuestion[] | undefined {
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 8) return undefined;
  // A question without options can't be answered from a card.
  const questions: ChatQuestion[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.question !== 'string' || !Array.isArray(raw.options)) return undefined;
    const options = raw.options.filter(isRecord).map(option => ({ label: text(option.label), ...(typeof option.description === 'string' ? { description: option.description } : {}) })).filter(option => option.label);
    if (!options.length) return undefined;
    questions.push({ question: raw.question, ...(typeof raw.header === 'string' ? { header: raw.header } : {}), multiSelect: raw.multiSelect === true, options });
  }
  return questions;
}

/** A list of command or skill names from Claude Code's init: short plain names only, internal ones (__x) left out. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][\w:.-]{0,63}$/i.test(name)))].slice(0, 400);
}

export class ClaudeAdapter implements ChatAdapter {
  readonly provider = 'claude' as const;
  private readonly requests = new Map<string, Pending>();
  private controlCounter = 0;
  private running = false;
  private interrupted = false;
  private messageId = 'm0';
  /** Claude's total_cost_usd counts up within one process; each turn reports its own share. */
  private costSoFar = 0;
  /** The latest request's whole prompt (input plus cache read and written): how full the context is. A turn's result sums every request, so it can't say. */
  private contextTokens: number | undefined;
  /** Tool calls already reported, so the same tool_use in a later assistant message isn't reported twice. */
  private readonly toolCalls = new Set<string>();

  get idle(): boolean { return !this.running; }

  args(options: ChatOptions): string[] { return claudeArguments(options); }

  start(): string[] { return [this.control({ subtype: 'initialize' })]; }

  send(message: string, images: ChatImage[] = []): string[] {
    this.running = true;
    this.interrupted = false;
    const content = images.length
      // G1's live check sent the text first, then the image; that is the order it proved.
      ? [...(message.trim() ? [{ type: 'text', text: message }] : []), ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }))]
      : message;
    return [JSON.stringify({ type: 'user', message: { role: 'user', content } })];
  }

  interrupt(): string[] {
    if (!this.running) return [];
    this.interrupted = true;
    return [this.control({ subtype: 'interrupt' })];
  }

  pending(): string[] { return [...this.requests.keys()]; }

  /** Claude's own set_model control request: the running process switches for its next turn. */
  setModel(model: string): string[] {
    if (!modelPattern.test(model)) throw new Error('That model name isn\'t valid.');
    return [this.control({ subtype: 'set_model', model })];
  }

  private control(request: Record<string, unknown>): string {
    return JSON.stringify({ type: 'control_request', request_id: `hydra-${++this.controlCounter}`, request });
  }

  private respond(requestId: string, response: Record<string, unknown>): string {
    return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  feed(line: string): { events: ChatEvent[]; replies: string[] } {
    if (!line.trim()) return { events: [], replies: [] };
    let message: unknown;
    try { message = JSON.parse(line); } catch { return { events: [{ type: 'error', message: 'Claude Code printed something Hydra couldn\'t read, so the chat stopped.', fatal: true, code: 'malformed' }], replies: [] }; }
    if (!isRecord(message) || typeof message.type !== 'string') return { events: [{ type: 'error', message: 'Claude Code sent a message Hydra couldn\'t read, so the chat stopped.', fatal: true, code: 'malformed' }], replies: [] };
    switch (message.type) {
      case 'system': return { events: this.system(message), replies: [] };
      case 'stream_event': return { events: this.stream(message), replies: [] };
      case 'assistant': return { events: this.assistant(message), replies: [] };
      case 'user': return { events: this.toolResults(message), replies: [] };
      case 'result': return { events: this.result(message), replies: [] };
      case 'control_request': return this.controlRequest(message);
      case 'control_response': return { events: this.controlResponse(message), replies: [] };
      default: return { events: [], replies: [] };
    }
  }

  private system(message: Record<string, unknown>): ChatEvent[] {
    if ((message.subtype === 'status' || message.subtype === 'init') && refusedMode(message.permissionMode)) return [bypassRefused];
    // Approving a plan switches Claude out of plan mode (G1); the chat follows, so a later process doesn't go back to it.
    if (message.subtype === 'status' && typeof message.permissionMode === 'string' && typeof message.session_id === 'string') {
      return [{ type: 'session', providerSessionId: message.session_id, permissionMode: message.permissionMode }];
    }
    if (message.subtype === 'init' && typeof message.session_id === 'string') {
      const commands = names(message.slash_commands), skills = names(message.skills);
      return [{ type: 'session', providerSessionId: message.session_id, ...(typeof message.model === 'string' ? { model: message.model } : {}), ...(typeof message.permissionMode === 'string' ? { permissionMode: message.permissionMode } : {}), ...(commands.length ? { commands } : {}), ...(skills.length ? { skills } : {}) }];
    }
    return [];
  }

  private stream(message: Record<string, unknown>): ChatEvent[] {
    // Subagent output (parent_tool_use_id set) is summarized by its tool call, not streamed into the reply.
    if (message.parent_tool_use_id) return [];
    const event = message.event;
    if (isRecord(event) && event.type === 'message_start' && isRecord(event.message) && typeof event.message.id === 'string') this.messageId = event.message.id;
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) return [];
    // Every message numbers its blocks from 0, so a block is named by its message too.
    const block = `${this.messageId}:${String(event.index ?? 0)}`;
    if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text) return [{ type: 'text', delta: event.delta.text, block }];
    if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string' && event.delta.thinking) return [{ type: 'thinking', delta: event.delta.thinking, block }];
    return [];
  }

  private assistant(message: Record<string, unknown>): ChatEvent[] {
    if (message.parent_tool_use_id || !isRecord(message.message) || !Array.isArray(message.message.content)) return [];
    const used = isRecord(message.message.usage) ? message.message.usage : undefined;
    if (used) {
      const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
      const total = count(used.input_tokens) + count(used.cache_read_input_tokens) + count(used.cache_creation_input_tokens);
      if (total > 0) this.contextTokens = total;
    }
    const events: ChatEvent[] = [];
    // A reply Claude Code makes itself (/model, /effort) has no stream events: its text comes only here.
    if (message.message.model === '<synthetic>') {
      for (const [index, block] of message.message.content.entries()) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text) events.push({ type: 'text', delta: block.text, block: `${text(message.uuid) || this.messageId}:synthetic:${index}` });
      }
      return events;
    }
    for (const block of message.message.content) {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string' || this.toolCalls.has(block.id)) continue;
      this.toolCalls.add(block.id);
      events.push({ type: 'tool-call', id: block.id, name: block.name, input: block.input ?? {} });
      const input = isRecord(block.input) ? block.input : {};
      if ((block.name === 'Write' || block.name === 'Edit' || block.name === 'MultiEdit' || block.name === 'NotebookEdit') && typeof (input.file_path ?? input.notebook_path) === 'string') {
        events.push({ type: 'file-change', id: block.id, path: String(input.file_path ?? input.notebook_path), kind: block.name === 'Write' ? 'unknown' : 'update' });
      }
    }
    return events;
  }

  private toolResults(message: Record<string, unknown>): ChatEvent[] {
    if (message.parent_tool_use_id || !isRecord(message.message) || !Array.isArray(message.message.content)) return [];
    return message.message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      .map(block => ({ type: 'tool-result', id: String(block.tool_use_id), output: resultText(block.content).slice(0, 100_000), isError: block.is_error === true }));
  }

  private result(message: Record<string, unknown>): ChatEvent[] {
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    const total = number(message.total_cost_usd);
    const cost = total !== undefined ? Math.max(0, total - this.costSoFar) : undefined;
    if (total !== undefined) this.costSoFar = Math.max(this.costSoFar, total);
    // One message can produce more than one result (G1). Only a result that can be this turn's end ends it:
    // - none is running: a late result for a turn already over;
    // - queued_turn_count > 0: the CLI still holds a message of ours, so this result is for an earlier one;
    // - a request is waiting and Hydra didn't interrupt: the CLI is blocked on it, so this isn't the end either.
    if (!this.running || (number(message.queued_turn_count) ?? 0) > 0 || (this.requests.size > 0 && !this.interrupted)) return [];
    const usage = isRecord(message.usage) ? message.usage : {};
    const events: ChatEvent[] = [];
    const cached = (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0);
    events.push({
      type: 'usage', inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), ...(cached ? { cachedTokens: cached } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(this.contextTokens !== undefined ? { contextTokens: this.contextTokens } : {}),
    });
    const interrupted = this.interrupted && message.subtype === 'error_during_execution';
    const failed = !interrupted && (message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success'));
    if (failed) {
      const detail = typeof message.result === 'string' ? message.result : String(message.subtype ?? 'error');
      events.push({ type: 'error', message: detail.slice(0, 2000), fatal: false, ...(/usage limit|hit your limit/i.test(detail) ? { code: 'limit' as const } : {}) });
    }
    events.push({ type: 'done', status: interrupted ? 'interrupted' : failed ? 'error' : 'success' });
    this.running = false;
    this.interrupted = false;
    // A turn that ended leaves nothing to answer: the CLI won't wait on those requests any more.
    events.push(...this.cancelAll());
    return events;
  }

  /** Every pending request, marked cancelled: the CLI won't wait on them any more. */
  cancelAll(): ChatEvent[] {
    const events: ChatEvent[] = [...this.requests.keys()].map(id => ({ type: 'resolved', id, outcome: 'cancelled', by: 'hydra' }));
    this.requests.clear();
    return events;
  }

  private controlRequest(message: Record<string, unknown>): { events: ChatEvent[]; replies: string[] } {
    const requestId = typeof message.request_id === 'string' && message.request_id.length <= 200 ? message.request_id : undefined;
    const request = isRecord(message.request) ? message.request : {};
    if (!requestId) return { events: [{ type: 'error', message: 'Claude Code sent a request without an id; it was ignored.', fatal: false, code: 'unknown-request' }], replies: [] };
    if (request.subtype !== 'can_use_tool') {
      // Hydra answers only permission prompts. Anything else is refused, never allowed by default.
      const reply = JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Hydra doesn't handle ${text(request.subtype) || 'this request'}.` } });
      return { events: [{ type: 'error', message: `Claude Code asked for something Hydra doesn't handle (${text(request.subtype).slice(0, 60) || 'unknown'}); it was refused.`, fatal: false, code: 'unknown-request' }], replies: [reply] };
    }
    const tool = text(request.tool_name);
    const input = isRecord(request.input) ? request.input : {};
    if (!tool) return this.refuse(requestId, 'a permission prompt without a tool name');
    if (tool === 'AskUserQuestion') {
      const questions = parseQuestions(input);
      if (!questions) return this.refuse(requestId, 'questions Hydra couldn\'t read');
      this.requests.set(requestId, { kind: 'question', requestId, input });
      return { events: [{ type: 'question', id: requestId, questions }], replies: [] };
    }
    if (tool === 'ExitPlanMode') {
      if (typeof input.plan !== 'string') return this.refuse(requestId, 'a plan without text');
      this.requests.set(requestId, { kind: 'plan', requestId, input });
      return { events: [{ type: 'plan', id: requestId, plan: input.plan }], replies: [] };
    }
    this.requests.set(requestId, { kind: 'approval', requestId, input });
    return {
      events: [{ type: 'approval', id: requestId, kind: 'tool', tool, input, ...(typeof request.description === 'string' ? { description: request.description } : {}), choices: ['allow', 'deny', 'edit'] }],
      replies: [],
    };
  }

  /** Denies a request Hydra can't show, and says so in the chat. */
  private refuse(requestId: string, what: string): { events: ChatEvent[]; replies: string[] } {
    return {
      events: [
        { type: 'error', message: `Claude Code sent ${what}; Hydra denied it.`, fatal: false, code: 'unknown-request' },
        { type: 'resolved', id: requestId, outcome: 'denied', by: 'hydra', note: what },
      ],
      replies: [this.respond(requestId, { behavior: 'deny', message: 'Hydra could not show this request to the user, so it was denied.' })],
    };
  }

  private controlResponse(message: Record<string, unknown>): ChatEvent[] {
    const response = isRecord(message.response) ? message.response : {};
    if (response.subtype === 'error') return [{ type: 'error', message: `Claude Code refused a request: ${text(response.error).slice(0, 300)}`, fatal: false }];
    // initialize's reply comes before any turn and names the mode Claude is in (G1).
    if (isRecord(response.response) && refusedMode(response.response.current_permission_mode)) return [bypassRefused];
    // It also lists every slash command, with its description, for the / menu, before the user has sent anything.
    if (isRecord(response.response) && Array.isArray(response.response.commands)) {
      const commands = response.response.commands.filter(isRecord).flatMap(command => {
        const name = text(command.name);
        if (!/^[a-z0-9][\w:.-]{0,63}$/i.test(name)) return [];
        const description = text(command.description).slice(0, 300), argumentHint = text(command.argumentHint).slice(0, 100);
        return [{ name, ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}) }];
      }).slice(0, 400);
      if (commands.length) return [{ type: 'commands', commands }];
    }
    return [];
  }

  answer(id: string, answer: ChatAnswer): { lines: string[]; events: ChatEvent[] } {
    const pending = this.requests.get(id);
    if (!pending) throw new Error('That request is no longer waiting for an answer.');
    if (answer.kind !== pending.kind) throw new Error(`That answer doesn't fit a ${pending.kind} request.`);
    let response: Record<string, unknown>;
    let outcome: 'allowed' | 'denied' | 'answered';
    if (answer.kind === 'approval') {
      if (answer.decision === 'deny') { response = { behavior: 'deny', message: answer.message || 'The user denied this.' }; outcome = 'denied'; }
      else {
        if (answer.updatedInput !== undefined && !isRecord(answer.updatedInput)) throw new Error('An edited input must be an object.');
        response = { behavior: 'allow', updatedInput: answer.updatedInput ?? pending.input };
        outcome = 'allowed';
      }
    } else if (answer.kind === 'question') {
      response = { behavior: 'allow', updatedInput: { ...pending.input, answers: answer.answers } };
      outcome = 'answered';
    } else {
      response = answer.approve
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: answer.feedback ? `Feedback from the user: ${answer.feedback}` : 'The user did not approve this plan.' };
      outcome = answer.approve ? 'allowed' : 'denied';
    }
    this.requests.delete(id);
    return { lines: [this.respond(id, response)], events: [{ type: 'resolved', id, outcome, by: 'user' }] };
  }
}

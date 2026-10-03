/**
 * The Hydra app's chat model (docs/internal/hydra-app/G4-local-chat.md): one event stream for both providers, so the
 * renderer, the store and Hydra's own logic never read a provider's protocol. Adapters (claude.ts, codex.ts) turn
 * each CLI's output into these events; nothing here imports a host.
 */
export type ChatProvider = 'claude' | 'codex';

/** One event in a chat. `turn` counts the user's messages, from 1. */
export type ChatEvent =
  /** The provider's own session (Claude) or thread (Codex) id, kept for resume. */
  | { type: 'session'; providerSessionId: string; model?: string; permissionMode?: string }
  /** What the user sent. */
  | { type: 'user'; text: string; images?: number }
  /** A piece of the assistant's reply, as it streams. `block` groups deltas of one reply block. */
  | { type: 'text'; delta: string; block: string }
  | { type: 'thinking'; delta: string; block: string }
  /** A tool the model called, with its full input once known. */
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; output: string; isError: boolean }
  /** A file the agent changed or proposes to change. */
  | { type: 'file-change'; id: string; path: string; kind: 'add' | 'update' | 'delete' | 'unknown'; diff?: string }
  /** The CLI asks before a tool runs. Drawn only from the CLI's own structured request, never from text. */
  | { type: 'approval'; id: string; kind: 'tool' | 'command' | 'file'; tool: string; input: unknown; description?: string; choices: ApprovalChoice[] }
  /** The CLI asks the user questions (Claude's AskUserQuestion). */
  | { type: 'question'; id: string; questions: ChatQuestion[] }
  /** The CLI asks to leave plan mode with this plan (Claude's ExitPlanMode). */
  | { type: 'plan'; id: string; plan: string }
  /** A request was answered, by the user or by Hydra's own refusal. */
  | { type: 'resolved'; id: string; outcome: 'allowed' | 'denied' | 'answered' | 'cancelled'; by: 'user' | 'hydra'; note?: string }
  /** The models the CLI offers (Codex's model/list), for the composer and for checking model and effort. */
  | { type: 'models'; models: ChatModel[] }
  /** Token use and cost for a turn, as the provider reports them. */
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number; contextWindow?: number }
  | { type: 'error'; message: string; fatal: boolean; code?: 'malformed' | 'unknown-request' | 'exited' | 'limit' | 'missing-cli' | 'spawn' }
  /** A turn ended. */
  | { type: 'done'; status: 'success' | 'interrupted' | 'error'; detail?: string };

export type ApprovalChoice = 'allow' | 'allow-session' | 'deny' | 'edit';

export interface ChatModel { id: string; label: string; isDefault: boolean; efforts: string[]; defaultEffort?: string }

export interface ChatQuestion { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }

/** How the user answered a request. */
export type ChatAnswer =
  | { kind: 'approval'; decision: 'allow' | 'allow-session' | 'deny'; updatedInput?: unknown; message?: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'plan'; approve: boolean; feedback?: string };

/**
 * The permission modes a chat may use. `settings` passes no mode, so Claude Code follows the user's own settings
 * (their `defaultMode` and rules), as it does outside Hydra. Bypass is excluded.
 */
export const claudePermissionModes = ['settings', 'auto', 'default', 'acceptEdits', 'plan'] as const;
export type ClaudePermissionMode = typeof claudePermissionModes[number];
export const codexSandboxes = ['read-only', 'workspace-write'] as const;
export type CodexSandbox = typeof codexSandboxes[number];
/**
 * Who answers a Codex chat's approvals: `settings` leaves it to the user's own Codex config (its approval policy and
 * reviewer, such as Codex's auto-review); `ask` sends every one to the user in Hydra.
 */
export const codexApprovalModes = ['settings', 'ask'] as const;
export type CodexApprovals = typeof codexApprovalModes[number];

/** What a chat is started with. Model and effort are checked against what the CLI offers before use. */
export interface ChatOptions {
  provider: ChatProvider;
  cwd: string;
  executable: string;
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
  /** Codex only; `ask` when unset. */
  approvals?: CodexApprovals;
  /** Set to resume: the provider's session or thread id from the store. */
  resume?: string;
  /** Claude only: the session id to start a new chat with. */
  sessionId?: string;
  /**
   * Extra CLI arguments, for the live checks' isolation from the user's own setup (scripts/app-live/chat.mjs). The
   * app never sets them, and no IPC payload can.
   */
  extraArgs?: string[];
}

/** An image the user attached: PNG, JPEG, GIF or WebP, base64, at most 5 MB decoded. */
export interface ChatImage { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A provider adapter: the CLI's arguments, and the translation between its protocol and ChatEvents. */
export interface ChatAdapter {
  readonly provider: ChatProvider;
  /** The command-line arguments that start the CLI for these options. */
  args(options: ChatOptions): string[];
  /** Lines to write when the process starts (before any user message). */
  start(options: ChatOptions): string[];
  /** Lines that send one user message. */
  send(text: string, images?: ChatImage[]): string[];
  /** One line of the CLI's output: the events it means, and any lines to write back at once. */
  feed(line: string): { events: ChatEvent[]; replies: string[] };
  /** Lines that answer a pending request; throws if the id isn't pending or the answer doesn't fit it. */
  answer(id: string, answer: ChatAnswer): { lines: string[]; events: ChatEvent[] };
  /** Lines that ask the CLI to stop the current turn. */
  interrupt(): string[];
  /** Lines that switch the running process to another model, when the CLI can do that in place. */
  setModel?(model: string): string[];
  /** True when stopping a turn must also end the process (Codex: an interrupted command keeps running otherwise). */
  readonly endAfterInterrupt?: boolean;
  /** Requests still waiting for an answer. */
  pending(): string[];
  /** Marks every pending request cancelled, for when the process goes away. */
  cancelAll(): ChatEvent[];
  /** True once the CLI has said a turn is over and none is running. */
  readonly idle: boolean;
}

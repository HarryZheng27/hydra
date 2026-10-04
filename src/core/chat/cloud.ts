/**
 * Claude cloud chats (G7): what `claude --cloud` needs and prints, from spike S3 (docs/internal/hydra-app/G7-cloud.md,
 * fixtures in tests/fixtures/app/claude-cloud).
 * - It refuses a pipe, so it runs in a pseudo-terminal, which answers the terminal queries a real one would.
 * - In a folder Claude Code hasn't trusted, its own trust prompt comes first. Hydra answers it only for a folder the
 *   user trusted in Hydra, which already told them chats there run Claude Code with the project's settings.
 * - It uploads the folder's tracked files as they are on disk (uncommitted edits too; untracked and ignored files
 *   not), prints three lines and exits: the session's title, its claude.ai/code link, and `claude --teleport <id>`.
 * - After that the CLI reports nothing, and the session's copy has no git remote: its file changes stay in the cloud.
 * No vscode or electron import: the app passes a pseudo-terminal in (node-pty), tests a stand-in.
 */
import { cmdUnsafe, isWindowsShim } from '../process';

export interface ClaudeCloudSession { sessionId: string; title: string; url: string }

/** A Claude cloud session id as the CLI prints it, which also goes on a command line (`--teleport <id>`). */
export const claudeCloudSessionIdPattern = /^session_[A-Za-z0-9]{10,64}$/;
/** Longest first message Hydra passes to `--cloud`. */
export const maxCloudMessage = 20_000;

/** Readable lines from a terminal capture: cursor moves become spaces and line breaks, other escapes are dropped. */
export function renderTerminal(raw: string): string {
  return raw
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Math.min(Number(n || 1), 400)))
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .split(/\r?\n|\r/).map(line => line.trimEnd()).filter(line => line.trim() && !/^[◐◑◒◓◯\s]+$/.test(line)).join('\n');
}

/**
 * The session `--cloud` created, from its rendered output: the title line, the link and the teleport line must all
 * be there and agree on one id, and the link must be claude.ai/code's own. Anything else is undefined.
 */
export function parseClaudeCloudStart(text: string): ClaudeCloudSession | undefined {
  const title = /^\s*Created cloud session:\s*(.+?)\s*$/m.exec(text)?.[1];
  const url = /^\s*View:\s*(https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)(?:\?[A-Za-z0-9=&_.-]*)?)\s*$/m.exec(text);
  const teleport = /^\s*Resume with:\s*claude --teleport\s+(session_[A-Za-z0-9]+)\s*$/m.exec(text)?.[1];
  if (!title || !url || !teleport || url[2] !== teleport || !claudeCloudSessionIdPattern.test(teleport)) return undefined;
  return { sessionId: teleport, title: title.slice(0, 200), url: `https://claude.ai/code/${teleport}` };
}

/**
 * The CLI's environment: the user's own, as for a local chat, without another Claude Code session's markers
 * (CLAUDECODE, CLAUDE_CODE_*), which turn the CLI's transcript saving off, or Electron's run-as-node switch.
 */
export function cloudEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, TERM: 'xterm-256color' };
}

export interface PseudoTerminal {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}
export type SpawnPseudoTerminal = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name: string }) => PseudoTerminal;

export interface StartClaudeCloudOptions {
  executable: string;
  cwd: string;
  message: string;
  spawn: SpawnPseudoTerminal;
  env?: NodeJS.ProcessEnv;
  /** Answer Claude Code's own folder-trust prompt: only for a folder the user trusted in Hydra. */
  answerTrust: boolean;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Stops the CLI: the chat was removed or the app is quitting. */
  signal?: AbortSignal;
}

/**
 * One Windows command line for these arguments, each quoted the way the CLI's C runtime splits them back: a pseudo-
 * terminal takes this string as is. node-pty's own joining leaves an argument that starts and ends with `"` unquoted,
 * so a message like `"x" --add-dir C:\ "y"` would reach the CLI as options.
 */
export function windowsCommandLine(args: string[]): string {
  return args.map(arg => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`).join(' ');
}

/** The trust prompt's "Yes" line, with the cursor moves a terminal draws spaces with. */
const trustPrompt = /Yes,(?:\s|\x1b\[\d*C)*I(?:\s|\x1b\[\d*C)*trust(?:\s|\x1b\[\d*C)*this(?:\s|\x1b\[\d*C)*folder/;

/** Starts a Claude cloud session for this message and resolves with it, or rejects with what the CLI said. */
export function startClaudeCloud(options: StartClaudeCloudOptions): Promise<ClaudeCloudSession> {
  const message = options.message.trim();
  if (!message) return Promise.reject(new Error('Type a message first.'));
  if (message.length > maxCloudMessage) return Promise.reject(new Error(`A cloud chat's first message can be at most ${maxCloudMessage} characters.`));
  // The message follows --cloud on a command line: it must not read as an option.
  if (message.startsWith('-')) return Promise.reject(new Error('A cloud chat\'s first message can\'t start with "-".'));
  // An npm .cmd shim hands the command line to cmd.exe, which reads " % ^ & | < > ! and line breaks as syntax.
  if (isWindowsShim(options.executable, options.platform) && cmdUnsafe.test(message)) return Promise.reject(new Error('Claude Code is installed as a .cmd launcher here, so a cloud chat\'s first message can\'t contain " % ^ & | < > ! or line breaks. Install the native claude.exe, or reword it.'));
  return new Promise((resolve, reject) => {
    let raw = '', trustAnswered = false, settled = false;
    const term = options.spawn(options.executable, ['--cloud', message], {
      cwd: options.cwd, env: cloudEnvironment(options.env ?? process.env), cols: 160, rows: 50, name: 'xterm-256color',
    });
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = renderTerminal(raw);
      const session = parseClaudeCloudStart(text);
      if (session) { resolve(session); return; }
      const said = text.split('\n').filter(line => !/^[\s─-]+$/.test(line)).slice(-4).join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      reject(error ?? new Error(said ? `Claude Code didn't start a cloud session: ${said}` : 'Claude Code didn\'t start a cloud session.'));
    };
    // Settled before the kill, so the reason isn't lost to the exit the kill causes.
    const stop = (reason: string) => { settle(new Error(reason)); try { term.kill(); } catch { /* already gone */ } };
    const timer = setTimeout(() => stop('Claude Code took too long to start the cloud session.'), options.timeoutMs ?? 90_000);
    term.onData(data => {
      raw += data;
      if (raw.length > 512 * 1024) raw = raw.slice(-256 * 1024);
      // The queries a terminal answers: its version, device attributes and the cursor's position.
      if (data.includes('\x1b[>0q')) term.write('\x1bP>|xterm(388)\x1b\\');
      if (/\x1b\[0?c/.test(data)) term.write('\x1b[?62;22c');
      if (data.includes('\x1b[6n')) term.write('\x1b[1;1R');
      if (!trustAnswered && trustPrompt.test(raw)) {
        trustAnswered = true;
        if (!options.answerTrust) { stop('Claude Code asks whether to trust this folder, and Hydra hasn\'t trusted it.'); return; }
        // The prompt's cursor starts on "No, exit": down, then Enter.
        setTimeout(() => term.write('\x1b[B'), 300);
        setTimeout(() => term.write('\r'), 800);
      }
    });
    term.onExit(() => settle());
    if (options.signal?.aborted) stop('Stopped before the cloud session started.');
    else options.signal?.addEventListener('abort', () => stop('Stopped before the cloud session started.'), { once: true });
  });
}

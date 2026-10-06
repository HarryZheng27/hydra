import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { currentWindowsUser, ownerOnlyProblem } from '../../../src/core/userHandshake';
import { argumentProblem, terminalServerName, terminalTools } from '../shared/terminalTools';
import type { ShellTabs } from './shellTabs';

const MAX_BODY = 64 * 1024;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The folder for the config files: its access list is cut to the current user, and new files inherit that. */
export async function restrictDirectoryToOwner(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') return;
  const user = await currentWindowsUser();
  await new Promise<void>((resolve, reject) => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${user.sid}:(OI)(CI)F`], { windowsHide: true, timeout: 15_000 }, error => (error ? reject(error) : resolve()));
  });
}

export interface AgentTerminalDeps {
  tabs: Pick<ShellTabs, 'run' | 'read' | 'tabsFor' | 'stop'>;
  /** Where each chat process's --mcp-config file is written. */
  dir: string;
  /** The server script (dist/hydra-terminal-mcp.cjs) and the executable that runs it as Node (ELECTRON_RUN_AS_NODE=1). */
  script: string;
  executable: string;
  /** Cuts a folder to the current user, and says why it isn't (undefined when it is); replaceable in tests. */
  security?: { restrict(dir: string): Promise<void>; problem(dir: string): Promise<string | undefined> };
  log?(line: string): void;
}

/** What a Claude chat's process is given: the arguments that connect it, and the end of its token. */
export interface AgentTerminalGrant { args: string[]; release(): void }

/**
 * Lets a Claude chat open, read, list and stop tabs in its own chat's terminal panel (docs/THREAT_MODEL.md, HSEC-104).
 * One 127.0.0.1 endpoint on a random port; each chat process gets its own random token, written only into an owner-only
 * --mcp-config file that is deleted when the process ends. The endpoint maps a token to its chat and nothing else: no
 * argument names a chat, so a call can only reach that chat's tabs.
 */
export class AgentTerminal {
  private server: http.Server | undefined;
  private port = 0;
  /** sha256 of each live token, to the chat it was minted for (resolved at call time: a warmed chat has no id yet). */
  private readonly tokens = new Map<string, () => string | undefined>();

  constructor(private readonly deps: AgentTerminalDeps) {}

  /** Prepares the config folder and starts listening. Throws (so no chat gets the tools) if the folder can't be made private. */
  async start(): Promise<void> {
    const security = this.deps.security ?? { restrict: restrictDirectoryToOwner, problem: ownerOnlyProblem };
    await security.restrict(this.deps.dir);
    const problem = await security.problem(this.deps.dir);
    if (problem) throw new Error(`Hydra won't give chats terminal tools: the config folder isn't private (${problem})`);
    // Files left by a run that was killed: no process of an earlier run is still using one.
    for (const name of readdirSync(this.deps.dir)) if (name.endsWith('.json')) rmSync(path.join(this.deps.dir, name), { force: true });
    const server = http.createServer((request, response) => this.serve(request, response));
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  /** A token and config file for one Claude chat process, or undefined when the endpoint isn't running. Synchronous: it runs as the process starts. */
  grant(chat: () => string | undefined): AgentTerminalGrant | undefined {
    if (!this.server) return undefined;
    const token = randomBytes(32).toString('hex');
    const file = path.join(this.deps.dir, `${randomUUID()}.json`);
    const config = { mcpServers: { [terminalServerName]: { command: this.deps.executable, args: [this.deps.script], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_TERMINAL_PORT: String(this.port), HYDRA_TERMINAL_TOKEN: token } } } };
    writeFileSync(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    const key = sha256(token);
    this.tokens.set(key, chat);
    return { args: ['--mcp-config', file], release: () => { this.tokens.delete(key); rmSync(file, { force: true }); } };
  }

  /** The port the endpoint listens on (127.0.0.1). */
  get address(): number { return this.port; }

  /** On quit: no token works and no config file is left. */
  stop(): void {
    this.tokens.clear();
    try { this.server?.close(); this.server?.closeAllConnections(); } catch { /* already closed */ }
    this.server = undefined;
    try { for (const name of readdirSync(this.deps.dir)) if (name.endsWith('.json')) rmSync(path.join(this.deps.dir, name), { force: true }); } catch { /* the folder is gone */ }
  }

  private reply(response: http.ServerResponse, status: number, body: object): void {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  private serve(request: http.IncomingMessage, response: http.ServerResponse): void {
    // Only the local server script calls this: a page in a browser (DNS rebinding, a cross-site POST) has the wrong Host or no token.
    if (request.headers.host !== `127.0.0.1:${this.port}`) { this.reply(response, 403, { ok: false, error: 'Refused.' }); return; }
    const auth = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? '');
    const chat = auth ? this.tokens.get(sha256(auth[1]!)) : undefined;
    if (request.method !== 'POST' || request.url !== '/call' || !chat) { this.reply(response, 401, { ok: false, error: 'Refused.' }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { this.reply(response, 413, { ok: false, error: 'Too large.' }); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BODY) return;
      void this.call(chat(), Buffer.concat(chunks).toString('utf8')).then(
        result => this.reply(response, 200, { ok: true, result }),
        (error: unknown) => this.reply(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  }

  /** One tool call from a chat's process; `chatId` is the chat its token was minted for. */
  private async call(chatId: string | undefined, body: string): Promise<string> {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error('The call wasn\'t valid JSON.'); }
    const { tool: name, arguments: args = {} } = (parsed && typeof parsed === 'object' ? parsed : {}) as { tool?: unknown; arguments?: unknown };
    const tool = terminalTools.find(candidate => candidate.name === name);
    if (!tool) throw new Error('Unknown terminal tool.');
    if (!chatId) throw new Error('This chat isn\'t ready for terminal tabs yet. Send it a message first.');
    const problem = argumentProblem(tool, args);
    if (problem) throw new Error(problem);
    const given = args as Record<string, unknown>;
    this.deps.log?.(`agent terminal: ${tool.name}`);
    switch (tool.name) {
      case 'run_in_terminal': return JSON.stringify(await this.deps.tabs.run(chatId, given.command, given.title));
      case 'read_terminal': return this.deps.tabs.read(chatId, given.tab_id, given.lines, given.wait_for_output_ms);
      case 'list_terminal_tabs': return JSON.stringify(this.deps.tabs.tabsFor(chatId));
      case 'stop_terminal_tab': return this.deps.tabs.stop(chatId, given.tab_id);
      default: throw new Error('Unknown terminal tool.');
    }
  }
}

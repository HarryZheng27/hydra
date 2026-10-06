// Entry point for dist/hydra-terminal-mcp.cjs: the stdio MCP server one Claude chat in the app starts (run by the app's
// executable with ELECTRON_RUN_AS_NODE=1, from the --mcp-config file main wrote for that chat's process). It lists the
// terminal tools and forwards each call, with the chat's own token, to main's 127.0.0.1 endpoint. Framing is the same as
// Hydra's other bridge (newline-delimited JSON-RPC); nothing here finds anything on disk: port and token come in the env.
import http from 'node:http';
import { terminalServerName, terminalTools } from '../shared/terminalTools';

declare const HYDRA_VERSION: string;
type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

const port = Number(process.env.HYDRA_TERMINAL_PORT);
const token = process.env.HYDRA_TERMINAL_TOKEN ?? '';
const text = (value: string, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

function forward(tool: string, args: unknown, signal: AbortSignal): Promise<{ ok: boolean; result?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port <= 0 || !token) { resolve({ ok: false, error: 'This chat was started without a terminal connection.' }); return; }
    const body = JSON.stringify({ tool, arguments: args });
    const request = http.request({ host: '127.0.0.1', port, path: '/call', method: 'POST', signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({ ok: false, error: 'Hydra answered with something unreadable.' }); } });
    });
    request.on('error', reject);
    request.end(body);
  });
}

const inflight = new Map<string | number, AbortController>();
async function handle(message: Message): Promise<object | undefined> {
  const { id, method, params = {} } = message;
  if (method === 'notifications/cancelled') { inflight.get(params.requestId as string | number)?.abort(); return undefined; }
  if (id === undefined || !method) return undefined;
  const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: terminalServerName, title: 'Hydra terminal', version: typeof HYDRA_VERSION === 'string' ? HYDRA_VERSION : '0.0.0' } });
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools: terminalTools });
  if (method === 'tools/call') {
    const name = String(params.name || '');
    if (!terminalTools.some(tool => tool.name === name)) return result(text(`Unknown terminal tool ${name}.`, true));
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const reply = await forward(name, params.arguments ?? {}, controller.signal);
      return result(reply.ok ? text(reply.result ?? 'ok') : text(reply.error || 'Hydra refused the call.', true));
    } catch (error) {
      return result(text(controller.signal.aborted ? 'Cancelled.' : `Hydra is not reachable: ${error instanceof Error ? error.message : String(error)}.`, true));
    } finally { inflight.delete(id); }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message: Message;
    try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
    void handle(message).then(reply => { if (reply) process.stdout.write(JSON.stringify(reply) + '\n'); });
  }
});
process.stdin.on('end', () => { for (const controller of inflight.values()) controller.abort(); setTimeout(() => process.exit(0), 50).unref?.(); });

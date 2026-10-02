// A stand-in stdio MCP server for the G1 Claude live check (scripts/app-live/claude.mjs).
// Tools: `echo` (a plain MCP tool for route A approvals) and `approve` (route B's
// --permission-prompt-tool). Every start and call is appended to --log as one JSON line,
// so the live check can tell what the CLI sent and when the server started.
// Usage: node stub-mcp.mjs --name <server> --log <file> [--approve allow|deny] [--root <scratch repo>]
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { confinementProblem } from './common.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const name = option('--name', 'g1stub');
const logFile = option('--log');
const approve = option('--approve', 'allow');
const root = option('--root');
const log = entry => { if (logFile) appendFileSync(logFile, JSON.stringify({ server: name, ...entry }) + '\n'); };
log({ event: 'start', pid: process.pid });

const tools = [
  { name: 'echo', description: 'Echoes the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'approve', description: 'Decides whether a tool call may run.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } });
  if (method === 'tools/list') return reply(id, { tools });
  if (method === 'tools/call') {
    log({ event: 'call', tool: params?.name, arguments: params?.arguments, meta: params?._meta });
    if (params?.name === 'echo') return reply(id, { content: [{ type: 'text', text: `echo: ${params.arguments?.text ?? ''}` }] });
    if (params?.name === 'approve') {
      const args = params.arguments ?? {};
      // For AskUserQuestion, try to pass answers the way route A does (first option of each question).
      const input = args.tool_name === 'AskUserQuestion' && Array.isArray(args.input?.questions)
        ? { ...args.input, answers: Object.fromEntries(args.input.questions.map(q => [q.question, q.options?.[0]?.label ?? ''])) }
        : args.input ?? {};
      // With --root, an allow only stands inside the scratch repository, as on route A.
      const problem = approve === 'allow' && root ? confinementProblem(root, args.tool_name, input) : undefined;
      if (problem) log({ event: 'confined', tool: args.tool_name, problem });
      const decision = approve === 'allow' && !problem ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: problem ? `Only work inside the scratch repository is allowed: ${problem}.` : 'Denied by the G1 stub approve tool.' };
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
    }
    return fail(id, -32602, `Unknown tool ${params?.name}`);
  }
  if (id !== undefined && method) return method === 'ping' ? reply(id, {}) : fail(id, -32601, `Unsupported method ${method}`);
});
process.stdin.on('end', () => { log({ event: 'exit' }); process.exit(0); });

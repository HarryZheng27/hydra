// S4 item 3: stand-in for dist/hydra-mcp.cjs. Run as `ELECTRON_RUN_AS_NODE=1 <exe> bridge.cjs`.
// Reads newline-delimited JSON-RPC from stdin and answers each request on stdout, like an MCP stdio server.
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const result = msg.method === 'ping'
    ? {
        pong: msg.params,
        electron: process.versions.electron,
        node: process.versions.node,
        // In run-as-node mode require('electron') is the npm-style path string, not the API.
        electronModuleType: (() => { try { return typeof require('electron'); } catch (e) { return 'throws: ' + e.message; } })(),
        nodeOptionsEnv: process.env.NODE_OPTIONS || null,
        nodeOptionsApplied: globalThis.__S4_NODE_OPTIONS_PRELOADED === true,
        execArgv: process.execArgv,
        inspectorUrl: require('node:inspector').url() || null,
        scriptInsideAsar: __filename.includes('.asar'),
      }
    : null;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  if (msg.method === 'shutdown') process.exit(0);
});
rl.on('close', () => process.exit(0));

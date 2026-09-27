import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
// The webview may only load resources from dist/, so the mark ships beside the bundle.
await mkdir('dist', { recursive: true });
await copyFile('hydra-logo.png', 'dist/hydra-logo.png');
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: true }),
  build({ entryPoints: ['webview/index.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/webview.js', minify: true }),
  // The stdio MCP bridge Claude Code and Codex start for Hydra helper actions.
  build({ entryPoints: ['src/hydraMcp.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/hydra-mcp.cjs', define: { HYDRA_VERSION: JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version) } }),
  // The `hydra` command's own commands (status, plan, heads, stop, resume, report); the app's bin/hydra launcher runs it.
  build({ entryPoints: ['src/hydraCli.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/hydra-cli.cjs', define: { HYDRA_VERSION: JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version) } }),
  // Claude Code's StopFailure hook: tells Hydra's windows a chat hit its usage limit.
  build({ entryPoints: ['src/hydraLimitHook.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/hydra-limit-hook.cjs' }),
  // Run by the Windows uninstaller: removes this install's entries from Claude Code's and Codex's settings.
  build({ entryPoints: ['src/uninstall.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/hydra-uninstall.cjs' }),
  build({ entryPoints: ['tests/smoke.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/smoke.cjs' })
]);

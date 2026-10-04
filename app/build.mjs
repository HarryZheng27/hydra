// Builds the Hydra app into dist/: main (Node), preload (sandboxed) and renderer (browser).
// Imports from ../src/core, ../src/host and ../webview are bundled in; the root package's own dependencies resolve
// from the root node_modules, so CI runs the root `npm ci` first.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
// One React for the app and anything it bundles from ../webview.
const alias = { react: path.join(here, 'node_modules', 'react'), 'react-dom': path.join(here, 'node_modules', 'react-dom') };
const define = { HYDRA_APP_VERSION: JSON.stringify(pkg.version) };
// Hydra's programs carry Hydra's own version (the root package's), as the IDE's do.
const hydraDefine = { HYDRA_VERSION: JSON.stringify(JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8')).version) };

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'renderer'), { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(here, 'src/main/main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: path.join(dist, 'main.cjs'), sourcemap: true, define, logLevel: 'warning' }),
  // A sandboxed preload may only require electron and a few Node built-ins, so it is one self-contained file.
  build({ entryPoints: [path.join(here, 'src/preload/preload.ts')], bundle: true, platform: 'browser', format: 'cjs', target: 'chrome140', external: ['electron'], outfile: path.join(dist, 'preload.cjs'), logLevel: 'warning' }),
  // Hydra Settings' window (G5): the IDE's settings page, given G2's window.hydraBridge.
  build({ entryPoints: [path.join(here, 'src/preload/settingsPreload.ts')], bundle: true, platform: 'browser', format: 'cjs', target: 'chrome140', external: ['electron'], outfile: path.join(dist, 'settings-preload.cjs'), logLevel: 'warning' }),
  // Monaco's CSS comes out as renderer.css beside it. Its icon font is emitted too, but the CSP (default-src 'none', no font-src) never
  // loads it: styles.css hides the codicons, which only Monaco's diff host would show.
  build({ entryPoints: [path.join(here, 'src/renderer/index.tsx')], bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', outfile: path.join(dist, 'renderer', 'renderer.js'), minify: true, alias, define: { ...define, 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'file' }, assetNames: '[name]', logLevel: 'warning' }),
  // Hydra's own programs, as the IDE builds them (scripts/build.mjs), run by the app's executable with
  // ELECTRON_RUN_AS_NODE=1: a chat's MCP bridge, the `hydra` command, Claude's usage-limit hook, and the uninstaller's
  // cleanup of this install's Claude Code and Codex entries (app/installer/hydra-app-uninstall.iss).
  ...[['hydraMcp.ts', 'hydra-mcp.cjs'], ['hydraCli.ts', 'hydra-cli.cjs'], ['hydraLimitHook.ts', 'hydra-limit-hook.cjs'], ['uninstall.ts', 'hydra-uninstall.cjs']].map(([entry, out]) =>
    build({ entryPoints: [path.join(here, '..', 'src', entry)], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: path.join(dist, out), define: hydraDefine, logLevel: 'warning' })),
  build({ entryPoints: { 'editor.worker': path.join(here, 'src/renderer/editor.worker.ts') }, bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', outdir: path.join(dist, 'renderer'), minify: true, logLevel: 'warning' }),
]);
for (const file of ['index.html', 'styles.css']) await copyFile(path.join(here, 'src/renderer', file), path.join(dist, 'renderer', file));
// The window's and taskbar's icon: the Hydra logo, not Electron's.
await copyFile(path.join(here, '..', 'hydra-logo.png'), path.join(dist, 'icon.png'));

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

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'renderer'), { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(here, 'src/main/main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: path.join(dist, 'main.cjs'), sourcemap: true, define, logLevel: 'warning' }),
  // A sandboxed preload may only require electron and a few Node built-ins, so it is one self-contained file.
  build({ entryPoints: [path.join(here, 'src/preload/preload.ts')], bundle: true, platform: 'browser', format: 'cjs', target: 'chrome140', external: ['electron'], outfile: path.join(dist, 'preload.cjs'), logLevel: 'warning' }),
  build({ entryPoints: [path.join(here, 'src/renderer/index.tsx')], bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', outfile: path.join(dist, 'renderer', 'renderer.js'), minify: true, alias, define: { ...define, 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' }),
]);
for (const file of ['index.html', 'styles.css']) await copyFile(path.join(here, 'src/renderer', file), path.join(dist, 'renderer', file));

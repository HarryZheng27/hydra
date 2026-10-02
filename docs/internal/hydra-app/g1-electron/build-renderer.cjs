// Bundle the spike renderer and Monaco's worker with esbuild (borrowed read-only from the Hydra repo's node_modules,
// as the app's own build will use esbuild too). Output: app/renderer/.
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require(path.join(process.env.USERPROFILE, 'Documents', 'hydra', 'node_modules', 'esbuild'));
const src = path.join(__dirname, 'renderer-src');
const out = path.join(__dirname, 'app', 'renderer');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, minify: true, nodePaths: [path.join(__dirname, 'node_modules')], logLevel: 'warning', legalComments: 'none', target: 'chrome130' };
(async () => {
  await esbuild.build({ ...common, entryPoints: { renderer: path.join(src, 'renderer.js') }, outdir: out, format: 'iife', loader: { '.ttf': 'file' }, assetNames: '[name]' });
  await esbuild.build({ ...common, entryPoints: { 'editor.worker': path.join(src, 'editor.worker.js') }, outdir: out, format: 'iife' });
  for (const f of ['index.html', 'page.css', 'blank.html']) fs.copyFileSync(path.join(src, f), path.join(out, f));
  for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
})().catch(e => { console.error(e); process.exit(1); });

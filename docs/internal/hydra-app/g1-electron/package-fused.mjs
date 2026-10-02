// S4 items 2-3: build a packaged, fused copy of the spike app, the way the app's release build would.
//   build/fused-<ver>/Hydra.exe + resources/app.asar (node-pty native files unpacked) + embedded ASAR integrity + fuses.
// Usage: node package-fused.mjs <electron package dir name, e.g. electron44>
// Uses @electron/asar and resedit read-only from the Hydra repo's node_modules (same versions the IDE probe uses),
// and @electron/fuses from this spike's node_modules. Never touches the stock Electron binary: it is copied first.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoModules = path.join(process.env.USERPROFILE, 'Documents', 'hydra', 'node_modules');
const require = createRequire(import.meta.url);
const { createPackageWithOptions, getRawHeader } = await import(pathToFileURL(path.join(repoModules, '@electron', 'asar', 'lib', 'asar.js')).href);
const { NtExecutable, NtExecutableResource } = await import(pathToFileURL(path.join(repoModules, 'resedit', 'dist', 'index.js')).href);
const { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } = require('@electron/fuses');

const pkg = process.argv[2] || 'electron44';
const dist = path.join(here, 'node_modules', pkg, 'dist');
const version = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim();
const out = path.join(here, 'build', `fused-${version}`);
const stage = path.join(here, 'build', `stage-${version}`);
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(stage, { recursive: true, force: true });

// 1. Runtime: hard-link every file except the executable (copied, because we patch it) and default_app.asar (dropped).
function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) linkTree(a, b);
    else if (entry.name === 'default_app.asar') continue;
    else if (entry.name === 'electron.exe') fs.copyFileSync(a, path.join(to, 'Hydra.exe'));
    else fs.linkSync(a, b);
  }
}
linkTree(dist, out);

// 2. Stage the app: main, bridge, renderer bundle, and node-pty (win32-x64 prebuilds only).
fs.mkdirSync(stage, { recursive: true });
for (const f of ['main.cjs', 'bridge.cjs', 'package.json']) fs.copyFileSync(path.join(here, 'app', f), path.join(stage, f));
fs.cpSync(path.join(here, 'app', 'renderer'), path.join(stage, 'renderer'), { recursive: true });
const ptySrc = path.join(here, 'node_modules', 'node-pty');
const ptyDst = path.join(stage, 'node_modules', 'node-pty');
for (const part of ['package.json', 'lib', 'build', 'prebuilds/win32-x64']) fs.cpSync(path.join(ptySrc, part), path.join(ptyDst, part), { recursive: true, filter: s => !/\.(pdb|map|test\.js)$/.test(s) && !s.includes(`${path.sep}lib${path.sep}shared${path.sep}test`) });

// 3. app.asar with native files unpacked (matchBase glob, as the IDE probe notes).
const resources = path.join(out, 'resources');
const archive = path.join(resources, 'app.asar');
await createPackageWithOptions(stage, archive, { dot: true, unpack: '*.{node,dll,exe}' });
const raw = getRawHeader(archive);
const headerHash = createHash('sha256').update(Buffer.from(raw.headerString, 'utf8')).digest('hex');
const unpacked = [];
(function walk(dir, rel) {
  for (const [name, e] of Object.entries(dir.files || {})) {
    const child = rel ? `${rel}/${name}` : name;
    if (e.files) walk(e, child); else if (e.unpacked) unpacked.push(child);
  }
})(raw.header, '');
// A loose copy of the bridge outside the archive, like the IDE's dist/hydra-mcp.cjs in its extension folder.
fs.copyFileSync(path.join(here, 'app', 'bridge.cjs'), path.join(resources, 'bridge.cjs'));

// 4. Embedded integrity resource (same format as scripts/desktop-asar-compatibility-probe.mjs).
const exePath = path.join(out, 'Hydra.exe');
const exe = NtExecutable.from(fs.readFileSync(exePath));
const res = NtExecutableResource.from(exe);
const integrity = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'sha256', value: headerHash }]), 'utf8');
const lang = res.entries[0];
res.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', bin: integrity.buffer.slice(integrity.byteOffset, integrity.byteOffset + integrity.byteLength), lang: lang?.lang ?? 0, codepage: lang?.codepage ?? 1252 });
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));

// 5. Fuses: the set recommended for the app.
const fuses = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: true, // required: hydra-mcp.cjs, hydraCli, the limit hook and pack gates run as ELECTRON_RUN_AS_NODE=1 <exe>
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};
await flipFuses(exePath, fuses);
const wire = await getCurrentFuseWire(exePath);
const named = Object.fromEntries(Object.entries(FuseV1Options).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, wire[v] === 49 ? 'on' : wire[v] === 48 ? 'off' : String(wire[v])]));
console.log(JSON.stringify({ version, out: path.relative(here, out), archiveBytes: fs.statSync(archive).size, headerSha256: headerHash, unpacked, fuses: named }, null, 2));

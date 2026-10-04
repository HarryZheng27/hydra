// Packages the built app (dist/, `npm run build`) for Windows x64, the way G1 proved it (docs/internal/hydra-app/G1-spikes.md, S4):
//   out/Hydra-win32-x64/  Hydra.exe (Electron, renamed, with Hydra's icon and version) + resources/app.asar
//                         (node-pty's native files unpacked) + resources/packs, with the ASAR integrity resource and G1's fuses.
//   out/installer/HydraAppSetup.exe  with --installer: app/installer/hydra-app.iss compiled over the package.
// The stock Electron in node_modules is never changed: its files are copied first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXE, APP_FUSES, NODE_PTY_PARTS, UNPACK, excluded, previewNumber, releaseChannel, releaseVersion, versionStrings, installerDefinitions } from './packageConfig.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.dirname(here);
export const repoRoot = path.dirname(appDir);
const out = path.join(appDir, 'out');
export const packageDir = path.join(out, 'Hydra-win32-x64');
export const installerDir = path.join(out, 'installer');

function copyTree(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (skip(source, entry)) continue;
    if (entry.isDirectory()) copyTree(source, target, skip);
    else if (entry.isFile()) fs.copyFileSync(source, target);
    else throw new Error(`Refusing to package ${source}: not a plain file or folder.`);
  }
}
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function packageApp(channel) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const version = releaseVersion(pkg.version);
  // A stable app updates itself by comparing its version with the release tag's, so it must carry Hydra's own version:
  // otherwise it would be offered every release, and its installer refused as a downgrade, forever.
  const hydraVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  if (channel === 'stable' && version !== hydraVersion) throw new Error(`A stable app must have Hydra's version: app/package.json has ${version}, package.json has ${hydraVersion}.`);
  const dist = path.join(appDir, 'dist');
  for (const file of ['main.cjs', 'preload.cjs', 'hydra-mcp.cjs', 'hydra-uninstall.cjs', 'renderer/index.html']) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`dist/${file} is missing: run npm run build first.`);
  }
  const require = createRequire(path.join(appDir, 'package.json'));
  const electronDir = path.dirname(require.resolve('electron/package.json'));
  const electronDist = path.join(electronDir, 'dist');
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('Electron for Windows x64 is missing: run npm ci in app/.');
  const rootRequire = createRequire(path.join(repoRoot, 'package.json'));
  const asar = rootRequire('@electron/asar');
  const { NtExecutable, NtExecutableResource, Resource, Data } = await rootRequire('resedit/cjs').load();
  const { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } = rootRequire('@electron/fuses');

  fs.rmSync(out, { recursive: true, force: true });
  // 1. Electron's runtime, renamed, without its default app.
  copyTree(electronDist, packageDir, (source, entry) => entry.isFile() && entry.name === 'default_app.asar');
  fs.renameSync(path.join(packageDir, 'electron.exe'), path.join(packageDir, EXE));

  // 2. The app's files: a minimal manifest, dist/, and node-pty.
  const stage = path.join(out, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, description: pkg.description, version, license: pkg.license, main: pkg.main, hydraChannel: channel }, null, 2) + '\n');
  copyTree(dist, path.join(stage, 'dist'), source => excluded(source));
  const pty = path.dirname(require.resolve('node-pty/package.json'));
  for (const part of NODE_PTY_PARTS) {
    const source = path.join(pty, part), target = path.join(stage, 'node_modules', 'node-pty', part);
    if (fs.statSync(source).isDirectory()) copyTree(source, target, file => excluded(file));
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
  }
  const resources = path.join(packageDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  await asar.createPackageWithOptions(stage, archive, { dot: true, unpack: UNPACK });
  fs.rmSync(stage, { recursive: true, force: true });
  // The built-in packs, which startup.ts finds two folders above dist/ (resources\app.asar\dist -> resources).
  copyTree(path.join(repoRoot, 'packs'), path.join(resources, 'packs'));

  // 3. Hydra.exe: icon, version, and the archive's integrity hash.
  const icons = path.join(out, 'icons');
  fs.mkdirSync(icons, { recursive: true });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'desktop-icons.ps1'), '-LogoPath', path.join(repoRoot, 'hydra-logo.png'), '-ResourceDirectory', icons], { stdio: 'ignore', windowsHide: true });
  const icon = path.join(icons, 'hydra.ico');
  fs.renameSync(path.join(icons, 'code.ico'), icon);
  const exePath = path.join(packageDir, EXE);
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(fs.readFileSync(icon));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error('Electron\'s executable has no icon to replace.');
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, iconFile.icons.map(item => item.data));
  const [info] = Resource.VersionInfo.fromEntries(res.entries);
  const parts = version.split('.').map(Number);
  info.setFileVersion(parts[0], parts[1], parts[2], 0);
  info.setProductVersion(parts[0], parts[1], parts[2], 0);
  for (const language of info.getAllLanguagesForStringValues()) info.setStringValues(language, versionStrings(version));
  info.outputToResourceEntries(res.entries);
  const header = asar.getRawHeader(archive);
  const integrity = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'sha256', value: sha256(Buffer.from(header.headerString, 'utf8')) }]), 'utf8');
  const lang = res.entries[0];
  res.entries = res.entries.filter(entry => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR'));
  res.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', bin: integrity.buffer.slice(integrity.byteOffset, integrity.byteOffset + integrity.byteLength), lang: lang?.lang ?? 1033, codepage: lang?.codepage ?? 1200 });
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  // 4. Fuses, then read them back.
  await flipFuses(exePath, { version: FuseVersion.V1, ...Object.fromEntries(Object.entries(APP_FUSES).map(([name, value]) => [FuseV1Options[name], value])) });
  const wire = await getCurrentFuseWire(exePath);
  for (const [name, value] of Object.entries(APP_FUSES)) {
    if (wire[FuseV1Options[name]] !== (value ? 49 : 48)) throw new Error(`Fuse ${name} isn't ${value ? 'on' : 'off'} in the packaged Hydra.exe.`);
  }
  console.log(`Packaged Hydra ${version}: ${path.relative(appDir, packageDir)}`);
  return { version, icon };
}

function isccPath() {
  const candidates = [process.env.HYDRA_ISCC, path.join(appDir, 'node_modules', 'innosetup', 'bin', 'ISCC.exe')].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Inno Setup\'s ISCC.exe is missing: run npm ci in app/.');
  return found;
}

function buildInstaller({ version, preview, icon }, outputDir = installerDir) {
  const definitions = installerDefinitions({ version, preview, sourceDir: packageDir, outputDir, setupIcon: icon });
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync(isccPath(), ['/Q', ...Object.entries(definitions).map(([key, value]) => `/D${key}=${value}`), path.join(appDir, 'installer', 'hydra-app.iss')], { stdio: 'inherit', windowsHide: true });
  const setup = path.join(outputDir, 'HydraAppSetup.exe');
  const bytes = fs.readFileSync(setup);
  if (bytes.length < 1024 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('HydraAppSetup.exe is missing or invalid.');
  console.log(`Built ${path.relative(appDir, setup)} (${(bytes.length / 1048576).toFixed(1)} MB, SHA-256 ${sha256(bytes)})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Packaging the app needs Windows x64.');
  // --channel=stable: a stable release, which updates itself (app/src/main/updates.ts). Anything else is a preview, which never does.
  const channel = releaseChannel(process.argv.find(arg => arg.startsWith('--channel='))?.slice('--channel='.length));
  // --preview=<n>: an app preview's installer, version x.y.z.n (app-preview.yml). A stable release never is one.
  const preview = previewNumber(process.argv.find(arg => arg.startsWith('--preview='))?.slice('--preview='.length));
  if (preview !== undefined && channel === 'stable') throw new Error('A stable package is never a preview.');
  const packaged = await packageApp(channel);
  if (process.argv.includes('--installer')) buildInstaller({ ...packaged, preview });
  // --prior=<x.y.z>: the same package as an older release, for the installer test's update case (scripts/app-installer-test.ps1).
  const prior = process.argv.find(arg => arg.startsWith('--prior='))?.slice('--prior='.length);
  if (prior) buildInstaller({ ...packaged, version: prior, preview: undefined }, path.join(out, 'installer-prior'));
}

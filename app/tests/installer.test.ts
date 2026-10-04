import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error: a plain .mjs module without types, the one app/scripts/package.mjs packages with.
import { APP_FUSES, NODE_PTY_PARTS, UNPACK, excluded, installerDefinitions, releaseChannel, releaseVersion, versionStrings } from '../scripts/packageConfig.mjs';

const appDir = path.join(__dirname, '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n');
const iss = read(appDir, 'installer', 'hydra-app.iss');
const uninstallIss = read(appDir, 'installer', 'hydra-app-uninstall.iss');
const ideProduct = JSON.parse(read(appDir, '..', 'desktop', 'product.json')) as Record<string, string>;
const define = (name: string): string | undefined => new RegExp(`^#define ${name} "([^"]*)"`, 'm').exec(iss)?.[1];

test('the packaged app gets G1\'s fuses: RunAsNode for the bridge, no NODE_OPTIONS or inspect flags, and only its integrity-checked archive', () => {
  assert.deepEqual({ ...APP_FUSES }, {
    RunAsNode: true,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false,
  });
  // The package script reads each fuse back and fails unless it matches.
  const script = read(appDir, 'scripts', 'package.mjs');
  assert.match(script, /await flipFuses\(exePath/);
  assert.match(script, /getCurrentFuseWire\(exePath\)[\s\S]*throw new Error\(`Fuse \$\{name\}/);
  assert.match(script, /type: 'INTEGRITY', id: 'ELECTRONASAR'/);
});

test('the packaged app ships node-pty\'s Windows prebuilds unpacked, and no debug symbols or source maps', () => {
  assert.deepEqual([...NODE_PTY_PARTS], ['package.json', 'LICENSE', 'lib', 'prebuilds/win32-x64']);
  assert.equal(UNPACK, '*.{node,dll,exe}');
  for (const file of ['dist\\main.cjs.map', 'prebuilds\\win32-x64\\pty.pdb', 'node-pty\\lib\\shared\\test\\x.js', 'node-pty/lib/unixTerminal.test.js']) assert.equal(excluded(file), true, file);
  for (const file of ['dist\\main.cjs', 'prebuilds\\win32-x64\\pty.node', 'prebuilds\\win32-x64\\conpty\\OpenConsole.exe', 'node-pty\\lib\\index.js']) assert.equal(excluded(file), false, file);
});

test('the app\'s installer version is a stable x.y.z release, carried into Hydra.exe', () => {
  assert.equal(releaseVersion('0.28.0'), '0.28.0');
  for (const bad of ['0.28.0-app.1', '0.28', '01.2.3', '65536.0.0', '1.2.3";x']) assert.throws(() => releaseVersion(bad), /stable x\.y\.z/, bad);
  assert.deepEqual(installerDefinitions({ version: '1.2.3', sourceDir: 's', outputDir: 'o', setupIcon: 'i' }), { Version: '1.2.3', RawVersion: '1.2.3', SourceDir: 's', OutputDir: 'o', SetupIcon: 'i' });
  assert.equal(versionStrings('1.2.3').ProductName, 'Hydra');
  assert.equal(versionStrings('1.2.3').OriginalFilename, 'Hydra.exe');
});

test('the app\'s installer is per user with no admin prompt, under its own AppId, folder and AppUserModelId, never the IDE\'s', () => {
  assert.match(iss, /^PrivilegesRequired=lowest$/m);
  assert.doesNotMatch(iss, /PrivilegesRequiredOverridesAllowed/);
  assert.match(iss, /^DefaultDirName=\{userpf\}\\Hydra App$/m);
  assert.match(iss, /^OutputBaseFilename=HydraAppSetup$/m);
  assert.equal(define('AppUserId'), 'Hydra.App');
  assert.notEqual(define('AppUserId'), ideProduct.win32AppUserModelId);
  const ideIds = [ideProduct.win32x64AppId, ideProduct.win32arm64AppId, ideProduct.win32x64UserAppId, ideProduct.win32arm64UserAppId];
  for (const name of ['AppId', 'IncompatibleTargetAppId']) {
    assert.match(define(name) ?? '', /^\{\{[0-9A-F-]{36}\}$/, name);
    assert.ok(!ideIds.includes(define(name)!), `${name} must not be the IDE's`);
  }
  assert.equal(define('IdeUserAppId'), ideProduct.win32x64UserAppId);
  assert.equal(define('IdeSystemAppId'), ideProduct.win32x64AppId);
  assert.equal(define('NameLong'), 'Hydra');
  // Inno's Restart Manager never closes anything; the installer checks for a running Hydra.exe itself.
  assert.match(iss, /^CloseApplications=no$/m);
  assert.match(iss, /function PrepareToInstall[\s\S]*?Result := HydraCheckInstall\(\);\n {2}if Result <> '' then Exit;\n {2}if HydraAppInUse\(\) then/);
  assert.match(iss, /function InitializeUninstall[\s\S]*?if HydraAppInUse\(\) then/);
  // In use means Hydra.exe or any of node-pty's unpacked programs a lane runs, never just the app's window.
  for (const file of ['{#ExeBasename}.exe', "'pty.node'", "'conpty.node'", "'winpty.dll'", "'winpty-agent.exe'", "'conpty\\conpty.dll'", "'conpty\\OpenConsole.exe'"]) assert.ok(iss.includes(file), file);
  assert.match(iss, /Result := Error = 32;/);
  // The IDE's update switch and install checks, shared, not copied.
  assert.match(iss, /#include "\.\.\\\.\.\\desktop\\hydra-update-mode\.iss"/);
  assert.match(iss, /Result := not \(\(HydraUpdateSwitchState\(\) < 0\) or HydraHasSwitch\('\/UPDATE'\) or not HydraUpdateArgumentsValid\(\)\);/);
});

test('the app\'s shortcuts are "Hydra" and never replace or remove a Hydra.lnk that opens something else', () => {
  const icons = iss.slice(iss.indexOf('[Icons]'), iss.indexOf('[Run]')).split(/\r?\n/).filter(line => line.startsWith('Name:'));
  assert.equal(icons.length, 2);
  for (const line of icons) {
    assert.match(line, /Name: "\{auto(programs|desktop)\}\\\{#NameLong\}"; Filename: "\{app\}\\\{#ExeBasename\}\.exe"; AppUserModelID: "\{#AppUserId\}"/);
    assert.match(line, /Check: HydraAppMayWriteShortcut\(/);
  }
  assert.match(iss, /Name: "desktopicon";[^\n]*Flags: unchecked/);
  // The only shortcut it deletes is its own desktop one, checked by target.
  assert.equal((iss.match(/DeleteFile\(/g) ?? []).length, 1);
  assert.match(iss, /if FileExists\(Desktop\) and \(CompareText\(HydraShortcutTarget\(Desktop\), ExpandConstant\('\{app\}\\\{#ExeBasename\}\.exe'\)\) = 0\) then\n\s*if DeleteFile\(Desktop\)/);
});

test('the app\'s uninstall removes only its own connector entries, and data only when asked, keeping the shared storage while the IDE is installed', () => {
  assert.match(iss, /#include "hydra-app-uninstall\.iss"/);
  assert.match(iss, /procedure CurUninstallStepChanged\(CurUninstallStep: TUninstallStep\);\nbegin\n {2}HydraAppUninstallCleanup\(CurUninstallStep\);/);
  // The IDE's own helper, run from inside the archive as Node, with this install's folder.
  assert.ok(uninstallIss.includes(`'" "' + Archive + '\\dist\\hydra-uninstall.cjs" --app "' + App + '"'`));
  assert.match(uninstallIss, /set "ELECTRON_RUN_AS_NODE=1"/);
  // The cleanup ran Hydra.exe: uninstall waits for Windows to let go of it before removing files.
  assert.match(uninstallIss, /ewWaitUntilTerminated, ResultCode\) then[\s\S]*?if HydraAppInUse\(\) then Log\(/);
  assert.ok(iss.indexOf('function HydraAppInUse') < iss.indexOf('#include "hydra-app-uninstall.iss"'), 'the uninstall include uses it');
  assert.match(read(appDir, 'build.mjs'), /\['uninstall\.ts', 'hydra-uninstall\.cjs'\]/);
  assert.match(uninstallIss, /HydraHasExactSwitch\('\/HYDRAREMOVEDATA'\)/);
  assert.match(uninstallIss, /MB_YESNO or MB_DEFBUTTON2\) = IDYES/);
  const removed = [...uninstallIss.matchAll(/^ +(?:else\s+)?HydraAppRemoveDataFolder\(([^;]*)\);/gm)].map(match => match[1]);
  assert.deepEqual(removed, ["ExpandConstant('{userappdata}'), ['Hydra App']", "ExpandConstant('{userappdata}'), ['Hydra', 'User', 'globalStorage', 'nico-dunlap.hydra-agent-manager']"]);
  assert.match(uninstallIss, /if HydraIdeInstalled\(\) then\n\s*Log\('Hydra: Hydra IDE is installed; its shared Hydra storage is kept\.'\)\n\s*else\n\s*HydraAppRemoveDataFolder/);
  assert.equal((uninstallIss.match(/DelTree\(/g) ?? []).length, 1);
  // Every folder on the way is checked: a junction or link anywhere is refused, never followed.
  assert.match(uninstallIss, /for I := 0 to GetArrayLength\(Parts\) - 1 do begin[\s\S]*?if not HydraAppRealDirectory\(Path\) then begin/);
  assert.match(uninstallIss, /\(FindRec\.Attributes and \$400\) = 0/);
});

test('a packaged app is a preview, which never updates itself, unless it is built as a stable release', () => {
  assert.equal(releaseChannel(undefined), 'preview');
  assert.equal(releaseChannel('preview'), 'preview');
  assert.equal(releaseChannel('stable'), 'stable');
  for (const bad of ['', 'Stable', 'beta', 'stable ']) assert.throws(() => releaseChannel(bad), /Unknown channel/, bad);
  assert.match(read(appDir, 'scripts', 'package.mjs'), /main: pkg\.main, hydraChannel: channel \}/);
  assert.match(read(appDir, 'src', 'main', 'startup.ts'), /'package\.json'\), 'utf8'\)\)\.hydraChannel/);
});

test('the app\'s version follows Hydra\'s: app/package.json and its lock carry the root package.json\'s version', () => {
  const root = JSON.parse(read(appDir, '..', 'package.json')) as { version: string };
  const app = JSON.parse(read(appDir, 'package.json')) as { version: string };
  const lock = JSON.parse(read(appDir, 'package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
  assert.equal(app.version, root.version, 'bump app/package.json with the root version (docs/Releases.md)');
  assert.equal(lock.version, root.version);
  assert.equal(lock.packages['']?.version, root.version);
  assert.equal(releaseVersion(app.version), app.version, 'a stable x.y.z, which the installer needs');
});

test('a stable package must carry Hydra\'s own version, or it would be offered every release', () => {
  assert.match(read(appDir, 'scripts', 'package.mjs'), /if \(channel === 'stable' && version !== hydraVersion\) throw new Error/);
});

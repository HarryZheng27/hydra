import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { stageWatermarks, verifyWatermarks } from './desktop-watermark.mjs';
const execute = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.desktop');
const source = path.join(cache, 'code-oss');
const output = path.join(cache, 'VSCode-win32-x64');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const pin = await readJson(path.join(root, 'desktop', 'upstream.json'));
const brand = await readJson(path.join(root, 'desktop', 'product.json'));

export function installedUpdateTrust(value) {
  const refuse = () => { throw new Error('Installed desktop update trust configuration is invalid.'); };
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.getPrototypeOf(object) === Object.prototype && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  const base = ['schemaVersion', 'status', 'product', 'channel', 'target'];
  if (!exact(value, value?.status === 'disabled' ? base : [...base, 'origin', 'keyId', 'publicKeyPem', 'authenticodeSigners'])) refuse();
  if (value.schemaVersion !== 1 || value.product !== 'Hydra' || value.channel !== 'stable' || !exact(value.target, ['platform', 'architecture', 'installTarget']) || value.target.platform !== 'win32' || value.target.architecture !== 'x64' || value.target.installTarget !== 'user') refuse();
  if (value.status === 'disabled') return value;
  if (value.status !== 'enabled') refuse();
  if (typeof value.origin !== 'string' || value.origin.length > 255) refuse();
  let origin;
  try { origin = new URL(value.origin); } catch { refuse(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || isIP(origin.hostname) || !origin.hostname.includes('.') || origin.hostname.endsWith('.localhost')) refuse();
  if (typeof value.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.keyId) || typeof value.publicKeyPem !== 'string' || value.publicKeyPem.length > 4096) refuse();
  try {
    const key = createPublicKey(value.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }) !== value.publicKeyPem) refuse();
  } catch { refuse(); }
  if (!Array.isArray(value.authenticodeSigners) || value.authenticodeSigners.length < 1 || value.authenticodeSigners.length > 3 || value.authenticodeSigners.some(signer => !exact(signer, ['subject', 'thumbprint']) || typeof signer.subject !== 'string' || signer.subject.length < 3 || signer.subject.length > 512 || signer.subject.trim() !== signer.subject || /[\x00-\x1f]/.test(signer.subject) || typeof signer.thumbprint !== 'string' || !/^[A-F0-9]{40}$/.test(signer.thumbprint)) || new Set(value.authenticodeSigners.map(signer => signer.thumbprint)).size !== value.authenticodeSigners.length) refuse();
  return value;
}

/**
 * Hydra installs extensions from Open VSX only. Microsoft's marketplace terms
 * restrict it to Microsoft's own products, so upstream's gallery is always
 * dropped, and the one Hydra's product config names is accepted only when every
 * URL in it points at open-vsx.org. Anything else fails the build rather than
 * shipping an editor that talks to an unexpected extension source.
 */
const openVsxGalleryKeys = ['serviceUrl', 'extensionUrlTemplate', 'resourceUrlTemplate', 'controlUrl', 'nlsBaseUrl'];
export function openVsxGallery(value) {
  const refuse = reason => { throw new Error(`Extension gallery must be Open VSX: ${reason}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('missing gallery configuration');
  const keys = Object.keys(value);
  if (keys.length !== openVsxGalleryKeys.length || !openVsxGalleryKeys.every(key => keys.includes(key))) refuse(`expected exactly ${openVsxGalleryKeys.join(', ')}`);
  for (const key of openVsxGalleryKeys) {
    const url = value[key];
    if (typeof url !== 'string') refuse(`${key} is not a string`);
    // An empty control or NLS URL disables that optional lookup; the three
    // endpoints that actually fetch extensions are never allowed to be empty.
    if (!url) { if (key === 'controlUrl' || key === 'nlsBaseUrl') continue; refuse(`${key} is empty`); }
    let parsed;
    try { parsed = new URL(url.replaceAll(/\{[a-z]+\}/g, 'x')); } catch { refuse(`${key} is not a URL`); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'open-vsx.org' || parsed.username || parsed.password) refuse(`${key} does not point at https://open-vsx.org`);
  }
  return { ...value };
}
export function brandedProduct(upstream, version) {
  // Keep upstream MIT notices and shape; replace the application's identity.
  installedUpdateTrust(brand.hydraUpdateTrust);
  const result = { ...upstream, ...brand, hydraVersion: version };
  delete result.extensionsGallery;
  if (brand.extensionsGallery) result.extensionsGallery = openVsxGallery(brand.extensionsGallery);
  delete result.updateUrl;
  return result;
}
export function brandedElectronMain(text) {
  if (text.includes('initializeHydraUpdateTrust')) throw new Error('Pinned Electron main changed: Hydra trust hook already exists.');
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned Electron main changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce("import { CodeApplication } from './app.js';",
    "import { CodeApplication } from './app.js';\nimport { initializeHydraUpdateTrust } from './hydraUpdateTrust.js';");
  replaceOnce('await this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);',
    'await this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);\n\t\t\t\ttry { initializeHydraUpdateTrust(productService); } catch { console.error("Hydra updates disabled: invalid installed trust."); }');
  return text;
}
export function brandedElectronApp(text) {
  if (text.includes('HydraUpdateService')) throw new Error('Pinned Electron app changed: Hydra update service already exists.');
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned Electron app changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce("import { Win32UpdateService } from '../../platform/update/electron-main/updateService.win32.js';",
    "import { HydraUpdateService } from './hydraUpdateService.js';");
  replaceOnce('services.set(IUpdateService, new SyncDescriptor(Win32UpdateService));',
    'services.set(IUpdateService, new SyncDescriptor(HydraUpdateService));');
  return text;
}
export const hydraMainUpdateModules = Object.freeze([
  'atomicFile.ts', 'desktopUpdateFeed.ts', 'desktopSignedUpdate.ts',
  'desktopUpdateJournal.ts', 'desktopUpdateStaging.ts', 'desktopUpdateOperation.ts',
  'desktopUpdateCheck.ts', 'desktopUpdateDownloadConsent.ts', 'desktopInstallIdentity.ts'
]);
export async function stageHydraMainUpdatePrimitives(destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of hydraMainUpdateModules) {
    await fs.copyFile(path.join(root, 'src', 'core', name), path.join(destination, name));
  }
}
export function isolatedEditorTypes(upstream, declaration, typeRoots) {
  // A nested checkout otherwise finds Hydra's older @types/vscode through
  // ancestor node_modules, even with typeRoots set. Resolve imports to the
  // editor's own API declarations; keep all upstream checking enabled.
  //
  // typeRoots is passed only where the upstream config has no explicit "types"
  // list. src/tsconfig.json pins one, and that alone excludes ancestor @types.
  // Forcing typeRoots there would additionally make every "types" entry resolve
  // under that single root, which drops the scoped @webgpu/types package and
  // leaves the editor's GPU renderer without its WebGPU globals (28 errors).
  return { ...upstream, compilerOptions: { ...upstream.compilerOptions,
    ...(typeRoots ? { typeRoots: upstream.compilerOptions?.typeRoots ?? typeRoots } : {}),
    paths: { ...upstream.compilerOptions?.paths, vscode: [declaration] } } };
}
/** Hydra's Inno Setup includes, copied next to the pinned code.iss that brandedInstaller includes them from. */
export const installerIncludes = ['hydra-update-mode.iss', 'hydra-uninstall.iss', 'hydra-wizard.iss', 'hydra-shortcuts.iss'];
export const hydraUninstallDelete = [
  ...['resources', 'locales', 'tools', 'policies'].map(name => `Type: filesandordirs; Name: "{app}\\${name}"`),
  ...['*.dll', '*.pak', '*.bin', 'icudtl.dat', 'LICENSES.chromium.html', 'vk_swiftshader_icd.json', '{#ExeBasename}.VisualElementsManifest.xml'].map(name => `Type: files; Name: "{app}\\${name}"`)
].join('\n');
export function brandedInstaller(text) {
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned installer changed: ${before}`);
    text = text.replace(before, after);
  };
  const replacements = new Map([
    ['AppPublisher=Microsoft Corporation', 'AppPublisher=Nico Dunlap'],
    ['AppPublisherURL=https://code.visualstudio.com/', 'AppPublisherURL=https://github.com/ndunl075/hydra'],
    ['AppSupportURL=https://code.visualstudio.com/', 'AppSupportURL=https://github.com/ndunl075/hydra/issues'],
    ['AppUpdatesURL=https://code.visualstudio.com/', 'AppUpdatesURL=https://github.com/ndunl075/hydra/releases'],
    ['OutputBaseFilename=VSCodeSetup', 'OutputBaseFilename=HydraSetup']
  ]);
  for (const [before, after] of replacements) {
    replaceOnce(before, after);
  }
  replaceOnce('CloseApplications=force', 'CloseApplications=no\nRestartApplications=no');
  // The IDE is "Hydra IDE" (product.json's nameLong): its Start Menu folder
  // moves to the new name instead of keeping an upgrade's old "Hydra" folder.
  // Each install writes a fresh uninstall log, so an uninstall never deletes a
  // shortcut an earlier version made, such as Hydra.lnk, which is now the
  // Hydra app's (desktop/hydra-shortcuts.iss). "new" would not do: it leaves
  // the old log and adds a second uninstaller beside it.
  replaceOnce('DefaultGroupName={#NameLong}', 'DefaultGroupName={#NameLong}\nUsePreviousGroup=no\nUninstallLogMode=overwrite');
  // A fresh log no longer lists files only an earlier version installed. So that
  // uninstalling still empties the install folder (a leftover folder makes a
  // later install refuse it), it also removes what the installer puts there:
  // its folders and Electron's runtime files, never unins000.* or anything else.
  replaceOnce('[UninstallDelete]\n', `[UninstallDelete]\n${hydraUninstallDelete}\n`);
  // hydra-wizard.iss defines InitializeWizard; a pinned installer with its own would be a duplicate.
  if (/procedure\s+InitializeWizard\s*\(/i.test(text)) throw new Error('Pinned installer changed: it defines InitializeWizard; merge hydra-wizard.iss into it.');
  replaceOnce('[Code]\nfunction IsBackgroundUpdate(): Boolean;', '[Code]\n#include "hydra-update-mode.iss"\n#include "hydra-wizard.iss"\n#include "hydra-shortcuts.iss"\nfunction IsBackgroundUpdate(): Boolean;');
  replaceOnce('  Result := True;\n\n  #if "user" == InstallTarget',
    `  Result := True;
  if (HydraUpdateSwitchState() < 0) or HydraHasSwitch('/UPDATE') or not HydraUpdateArgumentsValid() then begin
    Result := False;
    Exit;
  end;

  #if "user" == InstallTarget`);
  replaceOnce('function PrepareToInstall(var NeedsRestart: Boolean): String;\nbegin\n  if IsNotBackgroundUpdate() then',
    `function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := HydraCheckInstall();
  if Result <> '' then Exit;
  HydraRememberOldShortcuts();
  if IsHydraUpdate() then begin
    if CheckForMutexes('{#AppMutex},{#TunnelMutex},{#TunnelServiceMutex}') then
      Result := 'Stop all Hydra application and tunnel processes before updating.';
    Exit;
  end;
  if IsNotBackgroundUpdate() then`);
  replaceOnce('Result := not (IsBackgroundUpdate() and FileExists(Path));',
    'Result := not ((IsBackgroundUpdate() or IsHydraUpdate()) and FileExists(Path));');
  replaceOnce('function ShouldRunAfterUpdate(): Boolean;\nbegin\n  if IsBackgroundUpdate() then',
    'function ShouldRunAfterUpdate(): Boolean;\nbegin\n  if IsHydraUpdate() then\n    Result := False\n  else if IsBackgroundUpdate() then');
  replaceOnce('function WizardNotSilent(): Boolean;\nbegin\n  Result := not WizardSilent();',
    'function WizardNotSilent(): Boolean;\nbegin\n  Result := not WizardSilent() and not IsHydraUpdate();');
  replaceOnce('    end else begin\n      if IsVersionedUpdate() then begin',
    '    end else if not IsHydraUpdate() then begin\n      if IsVersionedUpdate() then begin');
  replaceOnce('    if ShouldRestartTunnelService then', '    if ShouldRestartTunnelService and not IsHydraUpdate() then');
  replaceOnce('  if CurStep = ssPostInstall then\n  begin\n    LogContextMenuInstallState();',
    '  if CurStep = ssPostInstall then\n  begin\n    HydraReplaceOldShortcuts();\n    LogContextMenuInstallState();');
  // Uninstall cleanup (desktop/hydra-uninstall.iss) runs first at every uninstall
  // step, before upstream's early exit for steps other than usUninstall.
  const uninstallStep = 'procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);\nvar\n  Path: string;\n  VSCodePath: string;\n  Parts: TArrayOfString;\n  NewPath: string;\n  i: Integer;\nbegin\n';
  replaceOnce(uninstallStep, `#include "hydra-uninstall.iss"\n${uninstallStep}  HydraUninstallCleanup(CurUninstallStep);\n`);
  if (!/Name: "desktopicon";[^\r\n]*Flags: unchecked/.test(text) || !/Tasks: desktopicon/.test(text)) throw new Error('Installer desktop-shortcut checkbox contract changed.');
  const deleteSection = '[InstallDelete]';
  if (text.split(deleteSection).length !== 2) throw new Error('Pinned installer delete section changed.');
  // A future explicit repair may opt out of the shortcut; update mode leaves
  // existing task choices and shortcuts untouched.
  text = text.replace(deleteSection, `${deleteSection}\nType: files; Name: "{autodesktop}\\{#NameLong}.lnk"; Tasks: not desktopicon; Check: ShouldUpdateShortcut(ExpandConstant('{autodesktop}\\{#NameLong}.lnk'))`);
  text = text.replace('If you would like to install VS Code for all users in this system, download the System Installer instead from https://code.visualstudio.com.', 'Hydra currently provides a per-user installer. Restart setup without administrator privileges to install it for your account.');
  return text;
}
export function installerVersionSource(text, version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || match.slice(1, 4).some(part => Number(part) > 65535)) throw new Error('Hydra version is invalid for a Windows installer.');
  const replacements = new Map([
    ['Version: pkg.version,', `Version: ${JSON.stringify(version)},`],
    ["RawVersion: pkg.version.replace(/-\\w+$/, ''),", `RawVersion: ${JSON.stringify(match.slice(1, 4).join('.'))},`]
  ]);
  for (const [before, after] of replacements) {
    if (text.split(before).length !== 2) throw new Error(`Pinned installer version contract changed: ${before}`);
    text = text.replace(before, after);
  }
  return text;
}
export function installerInventorySource(text, inventoryScript, upstreamCommit) {
  if (typeof upstreamCommit !== 'string' || !/^[a-f0-9]{40}$/.test(upstreamCommit))
    throw new Error('Pinned upstream inventory commit is invalid.');
  const anchor = "fs.writeFileSync(productJsonPath, JSON.stringify(productJson, undefined, '\\t'));";
  if (text.split(anchor).length !== 2 || text.includes('HydraInstalledInventory.json'))
    throw new Error('Pinned installer inventory hook changed.');
  const hook = `${anchor}
		if (arch === 'x64' && target === 'user') {
			cp.execFileSync(process.execPath, [${JSON.stringify(inventoryScript)}, 'generate',
				'--source', sourcePath, '--product', productJsonPath, '--inno', issPath,
				'--inventory', path.join(outputPath, 'HydraInstalledInventory.json'),
				'--version', String(productJson.hydraVersion),
				'--source-commit', process.env.HYDRA_SOURCE_COMMIT || '', '--upstream-commit', ${JSON.stringify(upstreamCommit)}], { stdio: 'inherit' });
		}`;
  return text.replace(anchor, hook);
}
export function windowsExecutableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || match.slice(1, 4).some(part => Number(part) > 65535)) throw new Error('Hydra version is invalid for a Windows executable.');
  return {
    'file-version': match.slice(1, 4).join('.'),
    'product-version': match.slice(1, 4).join('.'),
    'version-string': { ProductName: 'Hydra', ProductVersion: version, FileVersion: version, CompanyName: 'Nico Dunlap', OriginalFilename: 'Hydra.exe' }
  };
}
async function git(args) { return (await execute('git', args, { cwd: source, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
async function contained(directory) {
  const canonicalRoot = await fs.realpath(root), canonical = await fs.realpath(directory);
  const relative = path.relative(path.join(canonicalRoot, '.desktop'), canonical);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Desktop build directory escapes Hydra workspace.');
  return canonical;
}
async function run(command, args, cwd, extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit', env: { ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      npm_config_cache: path.join(cache, 'npm-cache'), npm_config_devdir: path.join(cache, 'node-gyp-cache'), ...extraEnv } });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed: ${code ?? signal}`)));
  });
}
async function npm(args, cwd, extraEnv) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await fs.access(cli);
  await run(process.execPath, [cli, ...args], cwd, extraEnv);
}
export function brandedThemeStartup(text) {
  const constructor = /new ThemeConfiguration\(configurationService, hostColorService, isNewUser\d*\);/g;
  const migration = 'await this.migrateAutoDetectColorScheme();';
  const newUser = /\t*const isNewUser\d* = this\.storageService\.isNew\(StorageScope\.APPLICATION\);\n/g;
  if ([...text.matchAll(constructor)].length !== 1 || text.split(migration).length !== 2 || [...text.matchAll(newUser)].length !== 1) throw new Error('Pinned theme startup contract changed.');
  text = text.replace(constructor, 'new ThemeConfiguration(configurationService, hostColorService, false);')
    .replace(migration, '// Hydra honors its dark default without writing a system-theme preference for new users.')
    .replace(newUser, '');
  // Dropping the call and the isNewUser read orphans the migration helper, and
  // the vendored tsconfig sets noUnusedLocals, so the method must go too. Its
  // dependencies (userDataInitializationService, ConfigurationTarget,
  // DETECT_COLOR_SCHEME) all have other callers, so nothing else is orphaned.
  const docStart = "\t/**\n\t * For new users who haven't explicitly configured `window.autoDetectColorScheme`,";
  const signature = '\tprivate async migrateAutoDetectColorScheme(): Promise<void> {';
  const close = '\n\t}\n';
  const start = text.indexOf(docStart);
  if (start < 0 || text.split(docStart).length !== 2 || text.split(signature).length !== 2) throw new Error('Pinned theme migration helper changed.');
  const end = text.indexOf(close, text.indexOf(signature, start));
  if (end < 0) throw new Error('Pinned theme migration helper is unterminated.');
  return text.slice(0, start) + text.slice(end + close.length);
}
export function brandedEditorGroupWatermark(text) {
  if (text.includes('renderHydraStartSurface')) throw new Error('Pinned watermark changed: Hydra start surface already exists.');
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned watermark changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce(
    "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';",
    "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';\nimport { ICommandService } from '../../../../platform/commands/common/commands.js';\nimport { IProductService } from '../../../../platform/product/common/productService.js';\nimport { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';\nimport { IHostService } from '../../../services/host/browser/host.js';\nimport { renderHydraStartSurface } from './hydraStartSurface.js';");
  replaceOnce(
    '\t\t@IStorageService private readonly storageService: IStorageService\n\t) {',
    '\t\t@IStorageService private readonly storageService: IStorageService,\n\t\t@ICommandService private readonly commandService: ICommandService,\n\t\t@IWorkspacesService private readonly workspacesService: IWorkspacesService,\n\t\t@IHostService private readonly hostService: IHostService,\n\t\t@IProductService private readonly productService: IProductService\n\t) {');
  const originalRender = '\tprivate render(): void {\n' +
    '\t\tthis.enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);\n\n' +
    '\t\tclearNode(this.shortcuts);\n' +
    '\t\tthis.transientDisposables.clear();\n\n' +
    '\t\tif (!this.enabled) {\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n\n' +
    '\t\tconst entries = this.filterEntries(this.workbenchState !== WorkbenchState.EMPTY ? workspaceEntries : emptyWindowEntries);\n' +
    '\t\tif (entries.length < EditorGroupWatermark.MINIMUM_ENTRIES) {\n' +
    '\t\t\tconst additionalEntries = this.filterEntries(otherEntries);\n' +
    '\t\t\tshuffle(additionalEntries);\n' +
    '\t\t\tentries.push(...additionalEntries.slice(0, EditorGroupWatermark.MINIMUM_ENTRIES - entries.length));\n' +
    '\t\t}\n\n' +
    "\t\tconst box = append(this.shortcuts, $('.watermark-box'));\n\n" +
    '\t\tconst update = () => {\n' +
    '\t\t\tclearNode(box);\n' +
    '\t\t\tthis.keybindingLabels.clear();\n\n' +
    '\t\t\tfor (const entry of entries) {\n' +
    '\t\t\t\tconst keys = this.keybindingService.lookupKeybinding(entry.id);\n' +
    '\t\t\t\tif (!keys) {\n' +
    '\t\t\t\t\tcontinue;\n' +
    '\t\t\t\t}\n\n' +
    "\t\t\t\tconst dl = append(box, $('dl'));\n" +
    "\t\t\t\tconst dt = append(dl, $('dt'));\n" +
    '\t\t\t\tdt.textContent = entry.text;\n\n' +
    "\t\t\t\tconst dd = append(dl, $('dd'));\n\n" +
    '\t\t\t\tconst label = this.keybindingLabels.add(new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles }));\n' +
    '\t\t\t\tlabel.set(keys);\n' +
    '\t\t\t}\n' +
    '\t\t};\n\n' +
    '\t\tupdate();\n' +
    '\t\tthis.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));\n' +
    '\t}';
  // Only the fully empty workbench (no folder or workspace at all) gets the
  // Cursor-style start surface. An empty group inside an already-open project
  // falls through to upstream's greyed-out letterpress mark and keybinding
  // tips, so none of the upstream watermark machinery becomes dead code.
  const emptyBranch = '\n\t\t// The fully empty workbench (no folder or workspace at all) gets the\n' +
    '\t\t// Cursor-style start surface, ignoring the tips setting; an empty group\n' +
    "\t\t// inside an open project keeps upstream's letterpress mark and tips.\n" +
    '\t\tif (this.workbenchState === WorkbenchState.EMPTY) {\n' +
    '\t\t\trenderHydraStartSurface(this.shortcuts, this.commandService, this.workspacesService, this.hostService, this.productService);\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n';
  const renderAnchor = '\t\tthis.transientDisposables.clear();\n';
  if (originalRender.split(renderAnchor).length !== 2) throw new Error('Pinned watermark changed: render disposable reset.');
  // The empty branch returns early, so the entry ternary's EMPTY arm is now
  // unreachable and tsgo rejects the narrowed comparison; select the workspace
  // entries directly. emptyWindowEntries stays live via the cachedWhen loop.
  const entryTernary = '\t\tconst entries = this.filterEntries(this.workbenchState !== WorkbenchState.EMPTY ? workspaceEntries : emptyWindowEntries);\n';
  if (originalRender.split(entryTernary).length !== 2) throw new Error('Pinned watermark changed: entry selection.');
  replaceOnce(originalRender, originalRender
    .replace(renderAnchor, renderAnchor + emptyBranch)
    .replace(entryTernary, '\t\tconst entries = this.filterEntries(workspaceEntries);\n'));
  return text;
}
export function brandedGettingStartedContent(text) {
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned getting-started content changed: ${before}`);
    text = text.replace(before, after);
  };
  const hydraCategory = `\t{
\t\tid: 'HydraSetup',
\t\ttitle: localize('gettingStarted.hydraSetup.title', "Get started with Hydra"),
\t\tdescription: localize('gettingStarted.hydraSetup.description', "Connect a provider, open a project, and start your first agent task"),
\t\tisFeatured: true,
\t\ticon: setupIcon,
\t\twalkthroughPageTitle: localize('gettingStarted.hydraSetup.walkthroughPageTitle', 'Setup Hydra'),
\t\tcontent: {
\t\t\ttype: 'steps',
\t\t\tsteps: [
\t\t\t\t{
\t\t\t\t\tid: 'hydraConnectProvider',
\t\t\t\t\ttitle: localize('gettingStarted.hydraConnectProvider.title', "Connect Claude or Codex"),
\t\t\t\t\tdescription: localize('gettingStarted.hydraConnectProvider.description.interpolated', "Hydra runs the official Claude Code and Codex CLIs. Connect the one you use.\\n{0}", Button(localize('gettingStarted.hydraConnectProvider.button', "Provider Accounts"), 'command:hydra.openAccounts')),
\t\t\t\t\tmedia: { type: 'markdown', path: 'empty' },
\t\t\t\t},
\t\t\t\t{
\t\t\t\t\tid: 'hydraOpenProject',
\t\t\t\t\ttitle: localize('gettingStarted.hydraOpenProject.title', "Open a project"),
\t\t\t\t\tdescription: localize('gettingStarted.hydraOpenProject.description.interpolated', "Open a folder or clone a repository to start working.\\n{0}", Button(localize('gettingStarted.hydraOpenProject.button', "Open Folder"), 'command:workbench.action.files.openFolder')),
\t\t\t\t\tmedia: { type: 'markdown', path: 'empty' },
\t\t\t\t},
\t\t\t\t{
\t\t\t\t\tid: 'hydraWatchHeads',
\t\t\t\t\ttitle: localize('gettingStarted.hydraWatchHeads.title', "Watch your Hydra heads"),
\t\t\t\t\tdescription: localize('gettingStarted.hydraWatchHeads.description.interpolated', "Ask Claude Code or Codex for something big: it splits the work across Hydra heads, each in its own worktree. Watch them in the Agents view.\\n{0}", Button(localize('gettingStarted.hydraWatchHeads.button', "Open Agents View"), 'command:hydra.openAgents')),
\t\t\t\t\tmedia: { type: 'markdown', path: 'empty' },
\t\t\t\t}
\t\t\t]
\t\t}
\t},

\t{
\t\tid: 'Setup',`;
  replaceOnce("export const walkthroughs: GettingStartedWalkthroughContent = [\n\t{\n\t\tid: 'Setup',", `export const walkthroughs: GettingStartedWalkthroughContent = [\n${hydraCategory}`);
  replaceOnce(
    "\t\tid: 'Setup',\n\t\ttitle: localize('gettingStarted.setup.title', \"Get started with VS Code\"),\n\t\tdescription: localize('gettingStarted.setup.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: true,",
    "\t\tid: 'Setup',\n\t\ttitle: localize('gettingStarted.setup.title', \"Get started with VS Code\"),\n\t\tdescription: localize('gettingStarted.setup.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: false,");
  replaceOnce(
    "\t\tid: 'SetupWeb',\n\t\ttitle: localize('gettingStarted.setupWeb.title', \"Get Started with VS Code for the Web\"),\n\t\tdescription: localize('gettingStarted.setupWeb.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: true,",
    "\t\tid: 'SetupWeb',\n\t\ttitle: localize('gettingStarted.setupWeb.title', \"Get Started with VS Code for the Web\"),\n\t\tdescription: localize('gettingStarted.setupWeb.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: false,");
  return text;
}
export function brandedSidebarTitleBar(text) {
  // With the activity bar on top, upstream draws the sidebar's view icons in a
  // header above a separate "EXPLORER" title row, so the sidebar opens with two
  // stacked bars. The title position puts the icons in that title row instead,
  // with the view actions beside them: one bar, as the auxiliary bar already
  // renders by default. The sidebar's own options anticipate this position (its
  // context menu adds the Views submenu for it), so no other code changes.
  const before = '\t\t\tcase ActivityBarPosition.TOP: return CompositeBarPosition.TOP;';
  if (text.split(before).length !== 2 || !text.includes('protected getCompositeBarPosition(): CompositeBarPosition {')) throw new Error('Pinned sidebar composite bar position changed.');
  return text.replace(before, '\t\t\tcase ActivityBarPosition.TOP: return CompositeBarPosition.TITLE;');
}
// The active view icon sits on a rounded pill rather than an underline. The pill
// is drawn on each icon's active-item-indicator, which already sits behind the
// icon, and never on the icon label itself: extension icons such as Hydra's are
// CSS masks over the label's background, so painting that background would turn
// the icon into a solid block. Upstream sets `background: none !important` on
// title-bar icon labels, which is one more reason to leave the label alone.
const hydraSidebarCss = `
/* Hydra: rounded pill for the active sidebar view icon. */
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-item.icon .action-label { position: relative; z-index: 1; }
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-item.icon .active-item-indicator::before { content: '' !important; position: absolute !important; top: 4.5px !important; left: 50% !important; width: 26px !important; height: 26px !important; margin-left: -13px !important; border: 0 !important; border-radius: 6px !important; background: transparent; }
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-item.icon.checked .active-item-indicator::before { background: var(--vscode-toolbar-activeBackground, rgba(255, 255, 255, 0.12)) !important; }
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-item.icon:not(.checked):hover .active-item-indicator::before { background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.07)) !important; }
`;
// File and folder icons in sidebar trees are drawn a little smaller than
// upstream's 16px, centred in the same slot, so rows keep their alignment.
const hydraSidebarIconCss = `
/* Hydra: slightly smaller file icons in sidebar trees. */
.monaco-workbench .part.sidebar .monaco-list .monaco-icon-label::before { background-size: 14px !important; background-position: center center !important; }
/* Hydra: sidebar chrome as in Cursor. Section header buttons (New File, Refresh...)
   take the section title's dimmed colour, brightening on hover; the section and
   folder chevrons are compact and bold, and folder chevrons use the text colour. */
.monaco-workbench .part.sidebar .pane-header .actions .action-label.codicon { color: inherit !important; }
.monaco-workbench .part.sidebar .pane-header .actions .action-label.codicon:hover { color: var(--vscode-icon-foreground) !important; }
.monaco-workbench .part.sidebar .pane-header > .twisty-container.codicon::before { font-size: 11px !important; -webkit-text-stroke: 0.4px currentColor; }
.monaco-workbench .part.sidebar .monaco-tl-twistie.codicon { color: var(--vscode-foreground); }
.monaco-workbench .part.sidebar .monaco-tl-twistie.codicon::before { font-size: 11px; -webkit-text-stroke: 0.4px currentColor; }
/* Hydra: no maximize button on the chat side bar; the Claude Code and Codex panels stay the size you set.
   It lives in the side bar's global actions toolbar, not its title actions. */
.monaco-workbench .part.auxiliarybar .action-item:has(> .codicon-auxiliarybar-maximize) { display: none !important; }
/* Hydra: the view icons at the top of the sidebar (Explorer, Search...) sit centred
   on Cursor's 32px pitch, and the overflow button is a chevron rather than "...". */
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container { flex: 1 1 auto; display: flex; justify-content: center; }
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-item { padding: 0 6px !important; }
.monaco-workbench .part.sidebar.pane-composite-part > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-label.codicon-more::before { content: '\\eab4'; }
`;
export function brandedSidebarCss(text) {
  if (text.includes('Hydra: rounded pill')) throw new Error('Pinned sidebar stylesheet already has Hydra styles.');
  if (!text.includes('.monaco-workbench .part.sidebar')) throw new Error('Pinned sidebar stylesheet changed.');
  return `${text}\n${hydraSidebarCss}${hydraSidebarIconCss}`;
}
// The custom title bar is a little taller than upstream's 35px, so its buttons have room above them rather than
// sitting close to the window's top edge. It's one constant, which the main process also uses for the Windows
// minimise/maximise/close overlay, so those buttons stay centred alongside Hydra's own.
export const hydraTitlebarHeight = 41;
export function brandedTitlebarHeight(text) {
  const before = 'export const DEFAULT_CUSTOM_TITLEBAR_HEIGHT = 35; // includes space for command center';
  if (text.split(before).length !== 2) throw new Error('Pinned title bar height changed.');
  return text.replace(before, `export const DEFAULT_CUSTOM_TITLEBAR_HEIGHT = ${hydraTitlebarHeight}; // Hydra: includes space for command center, with room above the buttons`);
}
// The app icon at the top left of the title bar is Hydra's logo, not Code - OSS's.
export function brandedTitlebarIcon(text) {
  const before = '.window-appicon:not(.codicon) {\n\tbackground-image: url(\'../../../media/code-icon.svg\');\n\tbackground-repeat: no-repeat;\n\tbackground-position: center center;\n\tbackground-size: 16px;\n}';
  if (text.split(before).length !== 2) throw new Error('Pinned title bar app icon changed.');
  return text.replace(before, '.window-appicon:not(.codicon) {\n\tbackground-image: url(\'./hydra-logo.png\');\n\tbackground-repeat: no-repeat;\n\tbackground-position: calc(50% + 2px) center;\n\tbackground-size: 18px;\n}');
}
// Agent chat panels stay where they are, as in Cursor, which registers its chat
// views with `canMoveView: false` and its chat container with `rejectAddedViews`.
// The Claude Code, Codex and Hydra views can't be dragged out, their containers
// accept no other views, and a container can't be dragged to another part of
// the window (so no drop zones light up over the editor or Explorer). Reordering
// icons within one bar still works.
export const lockedAgentExtensions = ['anthropic.claude-code', 'openai.chatgpt', 'nico-dunlap.hydra-agent-manager'];
const replaceOnceIn = (label, text, before, after) => {
  if (text.split(before).length !== 2) throw new Error(`Pinned ${label} changed: ${before.trim().slice(0, 80)}`);
  return text.replace(before, () => after);
};
export function lockedAgentViewsCommon(text) {
  if (text.includes('isHydraLockedAgentExtension')) throw new Error('Pinned views.ts already has Hydra\'s panel lock.');
  if (!text.includes('\nexport interface ViewContainer extends IViewContainerDescriptor { }') || !text.includes('\treadonly extensionId?: ExtensionIdentifier;')) throw new Error('Pinned views.ts ViewContainer changed.');
  return `${text}
// Hydra: agent chat panels are locked in place (scripts/desktop.mjs).
const hydraLockedAgentExtensions: ReadonlySet<string> = new Set(${JSON.stringify(lockedAgentExtensions).replace(/"/g, '\'')});
export function isHydraLockedAgentExtension(id: string | undefined): boolean { return !!id && hydraLockedAgentExtensions.has(id.toLowerCase()); }
export function isHydraLockedViewContainer(container: ViewContainer | undefined): boolean { return isHydraLockedAgentExtension(container?.extensionId?.value); }
`;
}
export function lockedAgentViewsExtensionPoint(text) {
  const label = 'viewsExtensionPoint.ts';
  text = replaceOnceIn(label, text, ', ViewContainerLocation } from \'../../common/views.js\';', ', ViewContainerLocation, isHydraLockedAgentExtension } from \'../../common/views.js\';');
  text = replaceOnceIn(label, text, '\t\t\t\t\t\tcanMoveView: viewContainer?.id !== REMOTE,', '\t\t\t\t\t\tcanMoveView: viewContainer?.id !== REMOTE && !isHydraLockedAgentExtension(extension.description.identifier.value),');
  return replaceOnceIn(label, text, '\t\t\t\thideIfEmpty: true,\n\t\t\t\torder,\n\t\t\t\ticon,\n\t\t\t}, location);', '\t\t\t\thideIfEmpty: true,\n\t\t\t\trejectAddedViews: isHydraLockedAgentExtension(extensionId?.value),\n\t\t\t\torder,\n\t\t\t\ticon,\n\t\t\t}, location);');
}
export function lockedAgentCompositeBar(text) {
  const label = 'compositeBar.ts';
  text = replaceOnceIn(label, text, 'import { ViewContainerLocation, IViewDescriptorService } from \'../../common/views.js\';', 'import { ViewContainerLocation, IViewDescriptorService, isHydraLockedViewContainer } from \'../../common/views.js\';');
  return replaceOnceIn(label, text, '\t\t\t\treturn dragData.id !== targetCompositeId;\n\t\t\t}\n\n\t\t\treturn true;', '\t\t\t\treturn dragData.id !== targetCompositeId;\n\t\t\t}\n\n\t\t\t// Hydra: an agent chat panel never moves to another part of the window.\n\t\t\treturn !isHydraLockedViewContainer(currentContainer);');
}
export function lockedAgentViewDescriptorService(text) {
  const label = 'viewDescriptorService.ts';
  text = replaceOnceIn(label, text, ', VIEWS_LOG_ID, VIEWS_LOG_NAME, WindowVisibility } from \'../../../common/views.js\';', ', VIEWS_LOG_ID, VIEWS_LOG_NAME, WindowVisibility, isHydraLockedViewContainer } from \'../../../common/views.js\';');
  return replaceOnceIn(label, text,
    '\tmoveViewContainerToLocation(viewContainer: ViewContainer, location: ViewContainerLocation, requestedIndex?: number, reason?: string): void {\n\t\tif (!this.canMoveViews()) {\n\t\t\treturn;\n\t\t}',
    '\tmoveViewContainerToLocation(viewContainer: ViewContainer, location: ViewContainerLocation, requestedIndex?: number, reason?: string): void {\n\t\tif (!this.canMoveViews()) {\n\t\t\treturn;\n\t\t}\n\t\t// Hydra: dragging never moves an agent chat panel to another part of the window.\n\t\tif (reason === \'dnd\' && isHydraLockedViewContainer(viewContainer) && this.getViewContainerLocation(viewContainer) !== location) {\n\t\t\treturn;\n\t\t}');
}
export function lockedAgentViewPaneContainer(text) {
  const label = 'viewPaneContainer.ts';
  text = replaceOnceIn(label, text, ', ViewContainer, ViewContainerLocation, ViewVisibilityState } from \'../../../common/views.js\';', ', ViewContainer, ViewContainerLocation, ViewVisibilityState, isHydraLockedViewContainer } from \'../../../common/views.js\';');
  const before = 'dropData.type === \'composite\' && dropData.id !== this.viewContainer.id && !this.viewContainer.rejectAddedViews)';
  if (text.split(before).length !== 3) throw new Error('Pinned viewPaneContainer.ts composite drop changed.');
  return text.split(before).join('dropData.type === \'composite\' && dropData.id !== this.viewContainer.id && !this.viewContainer.rejectAddedViews && !isHydraLockedViewContainer(this.viewDescriptorService.getViewContainerById(dropData.id) ?? undefined))');
}
export function brandedStartupPage(text) {
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned startup page changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce(
    "import { IWorkspaceContextService, UNKNOWN_EMPTY_WINDOW_WORKSPACE, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';",
    "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';");
  const originalMethod = '\tprivate tryOpenWalkthroughForFolder(): boolean {\n' +
    '\t\tconst toRestore = this.storageService.get(restoreWalkthroughsConfigurationKey, StorageScope.PROFILE);\n' +
    '\t\tif (!toRestore) {\n' +
    '\t\t\treturn false;\n' +
    '\t\t}\n' +
    '\t\telse {\n' +
    '\t\t\tconst restoreData: RestoreWalkthroughsConfigurationValue = JSON.parse(toRestore);\n' +
    '\t\t\tconst currentWorkspace = this.contextService.getWorkspace();\n' +
    '\t\t\tif (restoreData.folder === UNKNOWN_EMPTY_WINDOW_WORKSPACE.id || restoreData.folder === currentWorkspace.folders[0].uri.toString()) {\n' +
    '\t\t\t\tconst options: GettingStartedEditorOptions = { selectedCategory: restoreData.category, selectedStep: restoreData.step, pinned: false, preserveFocus: this.shouldPreserveFocus() };\n' +
    '\t\t\t\tthis.editorService.openEditor({\n' +
    '\t\t\t\t\tresource: GettingStartedInput.RESOURCE,\n' +
    '\t\t\t\t\toptions\n' +
    '\t\t\t\t});\n' +
    '\t\t\t\tthis.storageService.remove(restoreWalkthroughsConfigurationKey, StorageScope.PROFILE);\n' +
    '\t\t\t\treturn true;\n' +
    '\t\t\t}\n' +
    '\t\t}\n' +
    '\t\treturn false;\n' +
    '\t}';
  const newMethod = '\tprivate tryOpenWalkthroughForFolder(): boolean {\n' +
    '\t\t// Hydra: never auto-reopen a walkthrough over the start surface.\n' +
    '\t\treturn false;\n' +
    '\t}';
  replaceOnce(originalMethod, newMethod);
  return text;
}
// An extension's walkthrough never opens the Welcome page by itself when the extension is installed (upstream's
// workbench.welcomePage.walkthroughs.openOnInstall): Hydra installs Claude Code and Codex on its first run, and
// each would otherwise open it over the project. Walkthroughs stay one click away under Help.
export function brandedWalkthroughAutoOpen(text) {
  const before = "if (hadLastFoucs && sectionToOpen && this.configurationService.getValue<string>('workbench.welcomePage.walkthroughs.openOnInstall') && startupEditor !== 'agentSessionsWelcomePage') {";
  if (text.split(before).length !== 2) throw new Error('Pinned walkthrough auto-open changed.');
  return text.replace(before, "if (false /* Hydra: an installed extension's walkthrough never opens by itself */ && hadLastFoucs && sectionToOpen && startupEditor !== 'agentSessionsWelcomePage') {");
}
const hydraStartSurfaceCss = `
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts:has(.hydra-start-surface) {
	display: block !important;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark:has(.hydra-start-surface) .letterpress {
	display: none;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 20px;
	width: 100%;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-title-row {
	display: flex;
	align-items: center;
	gap: 12px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-logo {
	width: 40px;
	height: 40px;
	background-image: url('./hydra-logo.png');
	background-size: contain;
	background-position: center;
	background-repeat: no-repeat;
	flex-shrink: 0;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-title {
	font-size: 26px;
	font-weight: 600;
	color: var(--vscode-foreground);
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-actions {
	display: grid;
	grid-template-columns: repeat(2, minmax(220px, 1fr));
	gap: 12px;
	width: 100%;
	max-width: 460px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-card {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 14px 16px;
	border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
	border-radius: 5px;
	background-color: var(--vscode-editorWidget-background);
	color: var(--vscode-foreground);
	font-size: 13px;
	cursor: pointer;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-card:hover {
	background-color: var(--vscode-list-hoverBackground);
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-card .codicon {
	color: inherit !important;
	font-size: 18px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recents {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	width: 100%;
	max-width: 460px;
	gap: 6px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recents-title {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 2px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recents-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 8px;
	border: none;
	border-radius: 4px;
	background-color: transparent;
	color: var(--vscode-foreground);
	text-align: left;
	cursor: pointer;
	overflow: hidden;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item:hover {
	background-color: var(--vscode-list-hoverBackground);
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item .codicon {
	color: var(--vscode-descriptionForeground) !important;
	flex-shrink: 0;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item-text {
	display: flex;
	flex: 1;
	justify-content: space-between;
	align-items: baseline;
	gap: 12px;
	overflow: hidden;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item-label {
	font-size: 13px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex-shrink: 0;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item-path {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-container {
	--editor-group-tab-height: 19px !important;
}
`;
// Hydra's own notifications (desktop/workbench/hydraNotices.ts) and the title bar's Agent Manager | Editor switch
// (desktop/workbench/hydraModeSwitch.ts). They ride along with the watermark styles, which sit next to hydra-logo.png.
export const hydraChromeCss = `
.monaco-workbench .hydra-notices {
	position: absolute;
	right: 12px;
	bottom: calc(var(--status-bar-height, 22px) + 12px);
	z-index: 2545;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 8px;
	pointer-events: none;
}

.monaco-workbench .hydra-notices:empty {
	display: none;
}

.monaco-workbench .hydra-notice {
	pointer-events: auto;
	box-sizing: border-box;
	width: 360px;
	max-width: calc(100vw - 24px);
	padding: 12px 14px;
	border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, rgba(128, 128, 128, 0.35)));
	border-left: 3px solid var(--vscode-textLink-foreground, #3FA266);
	border-radius: 10px;
	background-color: var(--vscode-editorWidget-background);
	color: var(--vscode-foreground);
	box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
	font-size: 13px;
	line-height: 1.45;
	animation: hydra-notice-in 160ms ease-out;
}

.monaco-workbench .hydra-notice:focus {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -1px;
}

.monaco-workbench .hydra-notice.hydra-notice-warning {
	border-left-color: var(--vscode-editorWarning-foreground, #D2943E);
}

.monaco-workbench .hydra-notice.hydra-notice-error {
	border-left-color: var(--vscode-editorError-foreground, #E34671);
}

.monaco-workbench .hydra-notice.leaving {
	opacity: 0;
	transform: translateY(6px);
	transition: opacity 160ms ease-in, transform 160ms ease-in;
}

.monaco-workbench .hydra-notice-head {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 4px;
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
}

.monaco-workbench .hydra-notice-mark {
	width: 14px;
	height: 14px;
	background-image: url('./hydra-logo.png');
	background-repeat: no-repeat;
	background-position: center;
	background-size: contain;
}

.monaco-workbench .hydra-notice-brand {
	flex: 1;
}

.monaco-workbench .hydra-notice-close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	padding: 0;
	border: 0;
	border-radius: 4px;
	background: transparent;
	color: var(--vscode-icon-foreground);
	cursor: pointer;
}

.monaco-workbench .hydra-notice-close:hover {
	background-color: var(--vscode-toolbar-hoverBackground);
}

.monaco-workbench .hydra-notice-message {
	overflow-wrap: anywhere;
	white-space: pre-wrap;
}

.monaco-workbench .hydra-notice-detail {
	margin-top: 4px;
	color: var(--vscode-descriptionForeground);
	font-size: 12px;
	overflow-wrap: anywhere;
	white-space: pre-wrap;
}

.monaco-workbench .hydra-notice-progress {
	position: relative;
	height: 3px;
	margin-top: 10px;
	overflow: hidden;
	border-radius: 2px;
	background-color: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.25));
}

.monaco-workbench .hydra-notice-progress-bar {
	height: 100%;
	border-radius: 2px;
	background-color: var(--vscode-textLink-foreground, #3FA266);
	transition: width 200ms ease-out;
}

.monaco-workbench .hydra-notice-progress.indeterminate .hydra-notice-progress-bar {
	width: 30%;
	animation: hydra-notice-progress 1.2s ease-in-out infinite;
}

.monaco-workbench .hydra-notice-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 10px;
}

.monaco-workbench .hydra-notice-action,
.monaco-workbench .hydra-mode-switch-option {
	font-family: inherit;
	cursor: pointer;
}

.monaco-workbench .hydra-notice-action {
	padding: 4px 12px;
	border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
	border-radius: 6px;
	background-color: var(--vscode-button-secondaryBackground, transparent);
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	font-size: 12px;
}

.monaco-workbench .hydra-notice-action.primary {
	border-color: transparent;
	background-color: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}

.monaco-workbench .hydra-notice-action:hover {
	background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
}

.monaco-workbench .hydra-notice-action.primary:hover {
	background-color: var(--vscode-button-hoverBackground);
}

.monaco-workbench .hydra-notice-action:focus-visible,
.monaco-workbench .hydra-notice-close:focus-visible,
.monaco-workbench .hydra-mode-switch-option:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 1px;
}

@keyframes hydra-notice-in {
	from { opacity: 0; transform: translateY(8px); }
	to { opacity: 1; transform: none; }
}

@keyframes hydra-notice-progress {
	from { transform: translateX(-100%); }
	to { transform: translateX(340%); }
}

.monaco-workbench .part.titlebar .hydra-mode-switch-bar {
	display: flex;
	align-items: center;
	gap: 6px;
	margin: 0 8px;
	position: relative;
	z-index: 2500;
	-webkit-app-region: no-drag;
}

.monaco-workbench .part.titlebar .hydra-mode-switch-bar[hidden],
.monaco-workbench .part.titlebar .hydra-agents-panel-toggle[hidden] {
	display: none;
}

.monaco-workbench .part.titlebar .hydra-agents-panel-toggle {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	padding: 0;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--vscode-titleBar-activeForeground, var(--vscode-foreground));
	cursor: pointer;
	opacity: 0.7;
}

.monaco-workbench .part.titlebar .hydra-agents-panel-toggle:hover {
	background-color: var(--vscode-toolbar-hoverBackground);
	opacity: 1;
}

.monaco-workbench .part.titlebar .hydra-agents-panel-toggle.checked {
	opacity: 1;
}

.monaco-workbench .part.titlebar .hydra-agents-panel-toggle:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 1px;
}

.monaco-workbench .part.titlebar .hydra-mode-switch {
	display: flex;
	align-items: center;
	height: 24px;
	padding: 2px;
	gap: 2px;
	border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
	border-radius: 7px;
	/* Above the title bar's drag region, like upstream's own title bar controls. */
	position: relative;
	z-index: 2500;
	-webkit-app-region: no-drag;
}

.monaco-workbench .part.titlebar .hydra-mode-switch[hidden] {
	display: none;
}

.monaco-workbench .part.titlebar .hydra-mode-switch-option {
	height: 100%;
	padding: 0 10px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--vscode-titleBar-activeForeground, var(--vscode-foreground));
	font-size: 12px;
	opacity: 0.7;
}

.monaco-workbench .part.titlebar .hydra-mode-switch-option:hover {
	background-color: var(--vscode-toolbar-hoverBackground);
	opacity: 1;
}

.monaco-workbench .part.titlebar .hydra-mode-switch-option.checked {
	background-color: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
	.monaco-workbench .hydra-notice,
	.monaco-workbench .hydra-notice.leaving,
	.monaco-workbench .hydra-notice-progress-bar,
	.monaco-workbench .hydra-notice-progress.indeterminate .hydra-notice-progress-bar {
		animation: none;
		transition: none;
	}
}
`;
export function brandedWatermarkLayout(text) {
  const container = '\tmax-width: 272px;';
  const logo = '\tmax-width: 256px;';
  if (text.split(container).length !== 2 || text.split(logo).length !== 2) throw new Error('Pinned watermark layout contract changed.');
  if (text.includes('.hydra-start-surface')) throw new Error('Pinned watermark layout already has Hydra start surface styles.');
  // Native group sizing still constrains narrow/split editors; only the full empty editor grows.
  const sized = text.replace(container, '\twidth: 100%;\n\tmax-width: 380px;').replace(logo, '\tmax-width: 360px;');
  return `${sized}\n${hydraStartSurfaceCss}${hydraChromeCss}`;
}
export function brandedNativeThemeStartup(text) {
  const method = /(isAutoDetectColorScheme\(\)(?:: boolean)? \{)\s*if \(Setting\.DETECT_COLOR_SCHEME\.getValue\(this\.configurationService\)\) \{[\s\S]*?return false;\s*\}/g;
  const matches = [...text.matchAll(method)];
  if (matches.length !== 1 || !matches[0][0].includes('this.stateService.getItem(THEME_STORAGE_KEY)') || !matches[0][0].includes('userValue')) throw new Error('Pinned native theme startup contract changed.');
  return text.replace(method, '$1\n    return Setting.DETECT_COLOR_SCHEME.getValue(this.configurationService);\n  }');
}
// O8b (docs/Heads.md, "Scripts and CI"): the app's bin/hydra launcher (the editor's own `code`-style launcher, named
// after applicationName) also carries the `hydra` command. These first words go to the built-in extension's
// dist/hydra-cli.cjs; anything else opens the editor exactly as before (`hydra .`, `hydra file.ts`).
export const hydraCliCommands = Object.freeze(['status', 'plan', 'heads', 'stop', 'resume', 'report', 'close']);
const hydraCliScript = ['resources', 'app', 'extensions', 'hydra-agent-manager', 'dist', 'hydra-cli.cjs'];
/** resources/win32/bin/code.cmd, which the build renames to bin\hydra.cmd. */
export function brandedLauncherCmd(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const dispatch = [
    'set ELECTRON_RUN_AS_NODE=1',
    'rem Hydra: its own commands go to the Hydra extension\'s CLI; anything else opens the editor.',
    `for %%C in (${hydraCliCommands.join(' ')}) do if /I "%~1"=="%%C" goto hydracli`,
  ].join(eol);
  const cli = [
    'endlocal',
    'goto :eof',
    ':hydracli',
    `"%~dp0..\\@@NAME@@.exe" "%~dp0..\\${hydraCliScript.join('\\')}" %*`,
    'exit /b %ERRORLEVEL%',
  ].join(eol);
  // prepare() reads the pinned file through git(), which trims it: `endlocal` may be its very last word.
  return `${replaceOnceIn('Windows launcher', replaceOnceIn('Windows launcher', text, 'set ELECTRON_RUN_AS_NODE=1', dispatch), 'endlocal', cli).trimEnd()}${eol}`;
}
/** resources/win32/bin/code.sh, which the build renames to bin/hydra (Git Bash, and anything else with sh). */
export function brandedLauncherSh(text) {
  const anchor = 'ELECTRON="$VSCODE_PATH/$NAME.exe"\n';
  const dispatch = [
    anchor.trimEnd(),
    '# Hydra: its own commands go to the Hydra extension\'s CLI; anything else opens the editor.',
    'case "$1" in',
    `\t${hydraCliCommands.join('|')})`,
    `\t\tHYDRA_CLI="$VSCODE_PATH/${hydraCliScript.join('/')}"`,
    '\t\tif [ -x "$(command -v cygpath)" ]; then HYDRA_CLI=$(cygpath -m "$HYDRA_CLI"); elif [ -x "$(command -v wslpath)" ]; then HYDRA_CLI=$(wslpath -m "$HYDRA_CLI"); fi',
    '\t\tELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$HYDRA_CLI" "$@"',
    '\t\texit $?',
    '\t\t;;',
    'esac',
    '',
  ].join('\n');
  return replaceOnceIn('shell launcher', text, anchor, dispatch);
}
/** The built bin/hydra.cmd and bin/hydra still hand Hydra's commands to the CLI. */
export function verifyLaunchers(cmd, sh) {
  if (!cmd.includes(`goto hydracli`) || !cmd.includes(hydraCliScript.join('\\')) || !cmd.includes('resources\\app\\out\\cli.js')) throw new Error('bin\\hydra.cmd does not dispatch the hydra command.');
  if (!sh.includes(`${hydraCliCommands.join('|')})`) || !sh.includes(hydraCliScript.join('/')) || !sh.includes('resources/app/out/cli.js')) throw new Error('bin/hydra does not dispatch the hydra command.');
}
export async function prepare() {
  await fs.mkdir(cache, { recursive: true });
  await contained(cache);
  try { await fs.access(source); }
  catch { await run('git', ['clone', '--depth', '1', '--branch', pin.tag, '--single-branch', pin.repository, source], root); }
  await contained(source);
  if (await git(['rev-parse', 'HEAD']) !== pin.commit || await fs.realpath(await git(['rev-parse', '--show-toplevel'])) !== await fs.realpath(source)) throw new Error('Unexpected editor source checkout. Use the exact desktop/upstream.json pin.');
  const manifest = await readJson(path.join(root, 'package.json'));
  const desktopMain = await git(['show', `${pin.commit}:src/vs/workbench/workbench.desktop.main.ts`]);
  const desktopExport = "export { main } from './electron-browser/desktop.main.js';";
  if (desktopMain.split(desktopExport).length !== 2) throw new Error('Pinned desktop entrypoint changed.');
  for (const file of ['hydraProfile.ts', 'hydraNotices.ts', 'hydraModeSwitch.ts']) await fs.copyFile(path.join(root, 'desktop', 'workbench', file), path.join(source, 'src', 'vs', 'workbench', file));
    await fs.writeFile(path.join(source, 'src', 'vs', 'workbench', 'workbench.desktop.main.ts'), desktopMain.replace(desktopExport, `import './hydraProfile.js';\n\n${desktopExport}`));
    const electronMainPath = 'src/vs/code/electron-main/main.ts';
    await fs.copyFile(path.join(root, 'desktop', 'main', 'hydraUpdateTrust.ts'), path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraUpdateTrust.ts'));
    await fs.writeFile(path.join(source, electronMainPath), brandedElectronMain(await git(['show', `${pin.commit}:${electronMainPath}`])));
    await stageHydraMainUpdatePrimitives(path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraUpdate'));
    const electronAppPath = 'src/vs/code/electron-main/app.ts';
    await fs.copyFile(path.join(root, 'desktop', 'main', 'hydraUpdateService.ts'), path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraUpdateService.ts'));
    await fs.copyFile(path.join(root, 'desktop', 'main', 'hydraInstallIdentity.ts'), path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraInstallIdentity.ts'));
    await fs.writeFile(path.join(source, electronAppPath), brandedElectronApp(await git(['show', `${pin.commit}:${electronAppPath}`])));
  const themeStartupPath = 'src/vs/workbench/services/themes/browser/workbenchThemeService.ts';
  await fs.writeFile(path.join(source, themeStartupPath), brandedThemeStartup(await git(['show', `${pin.commit}:${themeStartupPath}`])));
  const nativeThemePath = 'src/vs/platform/theme/electron-main/themeMainServiceImpl.ts';
  await fs.writeFile(path.join(source, nativeThemePath), brandedNativeThemeStartup(await git(['show', `${pin.commit}:${nativeThemePath}`])));
  for (const [configPath, declaration, typeRoots] of [
    ['src/tsconfig.base.json', './vscode-dts/vscode.d.ts', null],
    ['extensions/tsconfig.base.json', '../src/vscode-dts/vscode.d.ts', ['./node_modules/@types', '../node_modules/@types']]
  ]) {
    const config = JSON.parse(await git(['show', `${pin.commit}:${configPath}`]));
    await fs.writeFile(path.join(source, configPath), JSON.stringify(isolatedEditorTypes(config, declaration, typeRoots), null, 2) + '\n');
  }
  const original = JSON.parse(await git(['show', `${pin.commit}:product.json`]));
  await fs.writeFile(path.join(source, 'product.json'), JSON.stringify(brandedProduct(original, manifest.version), null, 2) + '\n');
  const installer = await git(['show', `${pin.commit}:build/win32/code.iss`]);
  for (const name of installerIncludes) await fs.copyFile(path.join(root, 'desktop', name), path.join(source, 'build', 'win32', name));
  await fs.writeFile(path.join(source, 'build', 'win32', 'code.iss'), brandedInstaller(installer));
  await fs.writeFile(path.join(source, 'resources', 'win32', 'bin', 'code.cmd'), brandedLauncherCmd(await git(['show', `${pin.commit}:resources/win32/bin/code.cmd`])));
  await fs.writeFile(path.join(source, 'resources', 'win32', 'bin', 'code.sh'), brandedLauncherSh(await git(['show', `${pin.commit}:resources/win32/bin/code.sh`])));
  const electron = await git(['show', `${pin.commit}:build/lib/electron.ts`]);
  if (!electron.includes("companyName: 'Microsoft Corporation'")) throw new Error('Pinned executable publisher metadata changed.');
  await fs.writeFile(path.join(source, 'build', 'lib', 'electron.ts'), electron.replace("companyName: 'Microsoft Corporation'", "companyName: 'Nico Dunlap'"));
  const watermarkMediaDir = path.join(source, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media');
  await stageWatermarks(watermarkMediaDir, await fs.readFile(path.join(root, 'hydra-logo.png')));
  // The letterpress SVGs above are a deliberately near-invisible background
  // texture (6-12% opacity); the start surface's small header mark needs the
  // real, crisp logo instead.
  await fs.copyFile(path.join(root, 'hydra-logo.png'), path.join(watermarkMediaDir, 'hydra-logo.png'));
  const watermarkCss = 'src/vs/workbench/browser/parts/editor/media/editorgroupview.css';
  await fs.writeFile(path.join(source, watermarkCss), brandedWatermarkLayout(await git(['show', `${pin.commit}:${watermarkCss}`])));
  const editorPartsDir = path.join(source, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor');
  await fs.copyFile(path.join(root, 'desktop', 'workbench', 'hydraStartSurface.ts'), path.join(editorPartsDir, 'hydraStartSurface.ts'));
  const editorGroupWatermarkPath = 'src/vs/workbench/browser/parts/editor/editorGroupWatermark.ts';
  await fs.writeFile(path.join(source, editorGroupWatermarkPath), brandedEditorGroupWatermark(await git(['show', `${pin.commit}:${editorGroupWatermarkPath}`])));
  const sidebarPartPath = 'src/vs/workbench/browser/parts/sidebar/sidebarPart.ts';
  await fs.writeFile(path.join(source, sidebarPartPath), brandedSidebarTitleBar(await git(['show', `${pin.commit}:${sidebarPartPath}`])));
  const sidebarCssPath = 'src/vs/workbench/browser/parts/sidebar/media/sidebarpart.css';
  await fs.writeFile(path.join(source, sidebarCssPath), brandedSidebarCss(await git(['show', `${pin.commit}:${sidebarCssPath}`])));
  for (const [file, lock] of [
    ['src/vs/workbench/common/views.ts', lockedAgentViewsCommon],
    ['src/vs/workbench/api/browser/viewsExtensionPoint.ts', lockedAgentViewsExtensionPoint],
    ['src/vs/workbench/browser/parts/compositeBar.ts', lockedAgentCompositeBar],
    ['src/vs/workbench/services/views/browser/viewDescriptorService.ts', lockedAgentViewDescriptorService],
    ['src/vs/workbench/browser/parts/views/viewPaneContainer.ts', lockedAgentViewPaneContainer],
  ]) await fs.writeFile(path.join(source, file), lock(await git(['show', `${pin.commit}:${file}`])));
  const titlebarMedia = path.join(source, 'src', 'vs', 'workbench', 'browser', 'parts', 'titlebar', 'media');
  await fs.copyFile(path.join(root, 'hydra-logo.png'), path.join(titlebarMedia, 'hydra-logo.png'));
  const windowConstantsPath = 'src/vs/platform/window/common/window.ts';
  await fs.writeFile(path.join(source, windowConstantsPath), brandedTitlebarHeight(await git(['show', `${pin.commit}:${windowConstantsPath}`])));
  const titlebarCssPath = 'src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css';
  await fs.writeFile(path.join(source, titlebarCssPath), brandedTitlebarIcon(await git(['show', `${pin.commit}:${titlebarCssPath}`])));
  const startupPagePath = 'src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts';
  await fs.writeFile(path.join(source, startupPagePath), brandedStartupPage(await git(['show', `${pin.commit}:${startupPagePath}`])));
  const gettingStartedServicePath = 'src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts';
  await fs.writeFile(path.join(source, gettingStartedServicePath), brandedWalkthroughAutoOpen(await git(['show', `${pin.commit}:${gettingStartedServicePath}`])));
  const gettingStartedContentPath = 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts';
  await fs.writeFile(path.join(source, gettingStartedContentPath), brandedGettingStartedContent(await git(['show', `${pin.commit}:${gettingStartedContentPath}`])));
  console.log(`Prepared Hydra ${manifest.version}: Code - OSS ${pin.tag} at ${pin.commit}.`);
}
// vscode-icons (MIT, github.com/vscode-icons/vscode-icons): the file and folder
// icons Cursor users see, bundled as a built-in extension and Hydra's default
// icon theme. Pinned by version and SHA-256 from Open VSX.
// Classic codicons (the plain "+" new-file icon, circular refresh and so on), as
// in Cursor: desktop/codicon-classic.ttf is the pinned editor's codicon font with
// every glyph that also exists in @vscode/codicons 0.0.41 (CC BY 4.0) swapped for
// that release's design. scripts/desktop-classic-codicons.py regenerates it.
// Code - OSS copies node_modules/@vscode/codicons/dist/codicon.ttf into the
// sources on every compile, so the swap happens there, after `npm ci`, and only
// over the exact font it was made from.
export const classicCodicons = {
  base: '9e69844919a0f8c6dbcfc686363f81ace3a6b3e8363260aea8d969a609b0ba67',
  classic: '9cd9d6f542912523c445ef442fc6d698fbdf24fb0b75873babffb8f4fd30047e',
};
export async function stageClassicCodicons(sourceRoot) {
  const target = path.join(sourceRoot, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf');
  const current = sha256(await fs.readFile(target));
  if (current === classicCodicons.classic) return;
  if (current !== classicCodicons.base) throw new Error('The pinned codicon font changed; regenerate desktop/codicon-classic.ttf with scripts/desktop-classic-codicons.py.');
  const classic = await fs.readFile(path.join(root, 'desktop', 'codicon-classic.ttf'));
  if (sha256(classic) !== classicCodicons.classic) throw new Error('desktop/codicon-classic.ttf differs from its recorded SHA-256.');
  await fs.writeFile(target, classic);
}
export const vscodeIcons = { id: 'vscode-icons-team.vscode-icons', version: '12.19.0', sha256: '6891095459234809b9c5161850f2dabc91a80b3eca2daf599d050a88b455e960' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function stageVscodeIcons(destination) {
  const cache = path.join(root, '.desktop', 'artifacts', `${vscodeIcons.id}-${vscodeIcons.version}.vsix`);
  let vsix = await fs.readFile(cache).catch(() => undefined);
  if (!vsix || sha256(vsix) !== vscodeIcons.sha256) {
    const [namespace, name] = vscodeIcons.id.split('.');
    const response = await fetch(`https://open-vsx.org/api/${namespace}/${name}/${vscodeIcons.version}/file/${vscodeIcons.id}-${vscodeIcons.version}.vsix`);
    if (!response.ok) throw new Error(`Downloading ${vscodeIcons.id} ${vscodeIcons.version} failed (${response.status}).`);
    vsix = Buffer.from(await response.arrayBuffer());
    if (sha256(vsix) !== vscodeIcons.sha256) throw new Error(`${vscodeIcons.id} ${vscodeIcons.version} does not match its pinned SHA-256.`);
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, vsix);
  }
  const unpacked = `${destination}.unpacking`;
  await fs.rm(unpacked, { recursive: true, force: true });
  await fs.mkdir(unpacked, { recursive: true });
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', cache, '-C', unpacked, 'extension'], root);
  const manifest = await readJson(path.join(unpacked, 'extension', 'package.json'));
  if (`${manifest.publisher}.${manifest.name}` !== vscodeIcons.id || manifest.version !== vscodeIcons.version) throw new Error('Bundled vscode-icons manifest differs from the pin.');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(path.join(unpacked, 'extension'), destination);
  await fs.rm(unpacked, { recursive: true, force: true });
}
/** The app's defaults: the repository manifest's own, plus the ones only the desktop app sets. */
function hydraAppDefaults(manifest) {
  return { ...manifest.contributes.configurationDefaults,
    'workbench.colorTheme': 'Hydra Dark', 'workbench.preferredDarkColorTheme': 'Hydra Dark',
    'window.autoDetectColorScheme': false,
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'workbench.iconTheme': 'vscode-icons', 'vsicons.dontShowNewVersionMessage': true,
    // Hydra's agents are Claude Code and Codex; the built-in Copilot chat is hidden.
    'chat.disableAIFeatures': true,
    // Settings and Keyboard Shortcuts open as tabs, not a centred overlay (Code - OSS
    // defaults this experimental setting to 'some' outside stable builds).
    'workbench.editor.useModal': 'off' };
}
export async function stageHydra(destination) {
  const manifest = await readJson(path.join(root, 'package.json'));
  // Hydra's look (its themes and the app's defaults) ships in hydra-look instead (stageHydraLook): this extension
  // runs code, so it's switched off in a folder you haven't trusted yet, and its look would go with it.
  delete manifest.contributes.themes;
  delete manifest.contributes.configurationDefaults;
  await fs.mkdir(destination, { recursive: true });
  for (const name of ['dist', 'themes', 'media', 'packs', 'schemas', 'README.md', 'hydra-logo.png']) await fs.cp(path.join(root, name), path.join(destination, name), { recursive: true });
  // Smoke-test code is a development artifact, not a bundled extension entrypoint.
  await fs.rm(path.join(destination, 'dist', 'smoke.cjs'), { force: true });
  await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}
/**
 * hydra-look: Hydra's themes and the app's default settings, in a built-in extension with no code. Having no code,
 * it stays on in Restricted Mode, so a folder you haven't trusted yet (and the trust prompt in front of it) already
 * looks like Hydra instead of the stock editor.
 */
export async function stageHydraLook(destination) {
  const manifest = await readJson(path.join(root, 'package.json'));
  const look = {
    name: 'hydra-look', displayName: 'Hydra Look', description: "Hydra's themes and default settings.",
    publisher: manifest.publisher, version: manifest.version, license: manifest.license, repository: manifest.repository,
    engines: manifest.engines, categories: ['Themes'],
    capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true },
    contributes: { themes: manifest.contributes.themes, configurationDefaults: hydraAppDefaults(manifest) },
  };
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(path.join(root, 'themes'), path.join(destination, 'themes'), { recursive: true });
  await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(look, null, 2) + '\n');
}
export async function verify() {
  await contained(output);
  const exe = await fs.readFile(path.join(output, 'Hydra.exe'));
  if (exe.subarray(0, 2).toString() !== 'MZ') throw new Error('Hydra Windows executable is missing or invalid.');
  const product = await readJson(path.join(output, 'resources', 'app', 'product.json'));
  const expectedGallery = brand.extensionsGallery ? openVsxGallery(brand.extensionsGallery) : undefined;
  if (product.nameShort !== 'Hydra' || product.nameLong !== 'Hydra IDE' || product.dataFolderName !== '.hydra' || product.win32AppUserModelId !== 'Hydra.IDE' || !isDeepStrictEqual(product.extensionsGallery, expectedGallery)) throw new Error('Desktop identity/profile isolation failed.');
  installedUpdateTrust(product.hydraUpdateTrust);
  if (!isDeepStrictEqual(product.hydraUpdateTrust, brand.hydraUpdateTrust)) throw new Error('Installed desktop update trust differs from the reviewed release configuration.');
  const bundled = path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager');
  const manifest = await readJson(path.join(bundled, 'package.json'));
  if (manifest.publisher !== 'nico-dunlap' || manifest.name !== 'hydra-agent-manager') throw new Error('Built-in Hydra extension is missing.');
  // The uninstaller runs this to remove Hydra's entries from Claude Code's and Codex's settings.
  await fs.access(path.join(bundled, 'dist', 'hydra-uninstall.cjs')).catch(() => { throw new Error('Built-in Hydra extension is missing its uninstall cleanup.'); });
  // O8b: the hydra command's CLI, and the launchers that hand it Hydra's commands.
  await fs.access(path.join(bundled, 'dist', 'hydra-cli.cjs')).catch(() => { throw new Error('Built-in Hydra extension is missing the hydra command.'); });
  verifyLaunchers(await fs.readFile(path.join(output, 'bin', 'hydra.cmd'), 'utf8'), await fs.readFile(path.join(output, 'bin', 'hydra'), 'utf8'));
  const release = await readJson(path.join(root, 'package.json'));
  if (product.hydraVersion !== release.version || manifest.version !== release.version) throw new Error('Desktop product and bundled module versions differ from the Hydra release.');
  const nativeHelperPath = path.join(output, 'tools', 'HydraUpdateVerify.exe');
  const nativeHelper = await fs.readFile(nativeHelperPath);
  if (nativeHelper.length < 1024 || nativeHelper.subarray(0, 2).toString() !== 'MZ') throw new Error('Disabled native update helper is missing or invalid.');
  for (const name of await fs.readdir(path.join(output, 'tools'))) {
    if (/fixture/i.test(name)) throw new Error('Native fixture executable leaked into the desktop package.');
  }
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-pe-version.ps1'), '-ExecutablePath', path.join(output, 'Hydra.exe')], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 });
    const pe = JSON.parse(stdout);
    if (pe.ProductName !== 'Hydra' || pe.ProductVersion !== release.version || pe.CompanyName !== 'Nico Dunlap') throw new Error('Hydra executable PE release identity does not match the product and bundled module.');
    const helperVersion = JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-pe-version.ps1'), '-ExecutablePath', nativeHelperPath], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 })).stdout);
    if (helperVersion.ProductName !== 'Hydra' || helperVersion.ProductVersion !== release.version || helperVersion.CompanyName !== 'Nico Dunlap') throw new Error('Native update helper PE release identity differs.');
  }
  await fs.access(path.join(bundled, 'dist', 'extension.cjs'));
  // hydra-look carries the themes and defaults, and must stay on in folders that aren't trusted yet.
  const lookPath = path.join(output, 'resources', 'app', 'extensions', 'hydra-look');
  const look = await readJson(path.join(lookPath, 'package.json'));
  if (look.main || look.browser || look.capabilities?.untrustedWorkspaces?.supported !== true || look.version !== release.version || look.contributes?.configurationDefaults?.['workbench.colorTheme'] !== 'Hydra Dark') throw new Error('Built-in Hydra look is missing, runs code, or would switch off in Restricted Mode.');
  await fs.access(path.join(lookPath, 'themes', 'hydra-light.json'));
  if (manifest.contributes.themes || manifest.contributes.configurationDefaults) throw new Error('The built-in Hydra extension still carries the look that hydra-look owns.');
  if (sha256(await fs.readFile(path.join(output, 'resources', 'app', 'out', 'media', 'codicon.ttf'))) !== classicCodicons.classic) throw new Error('The built editor does not use the classic codicon font.');
  const icons = await readJson(path.join(output, 'resources', 'app', 'extensions', vscodeIcons.id, 'package.json'));
  if (icons.version !== vscodeIcons.version || !icons.contributes?.iconThemes?.some(theme => theme.id === 'vscode-icons') || look.contributes.configurationDefaults['workbench.iconTheme'] !== 'vscode-icons') throw new Error('Bundled vscode-icons theme is missing or not the default.');
  await verifyWatermarks(path.join(output, 'resources', 'app', 'out', 'media'), await fs.readFile(path.join(root, 'hydra-logo.png')));
  const stagedLogo = await fs.readFile(path.join(output, 'resources', 'app', 'out', 'media', 'hydra-logo.png'));
  if (!stagedLogo.equals(await fs.readFile(path.join(root, 'hydra-logo.png')))) throw new Error('Staged start-surface logo differs from the source hydra-logo.png.');
  console.log(`Verified standalone executable and built-in Hydra ${manifest.version}: ${output}`);
}
export async function build() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('First desktop target is native Windows x64.');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 22 || minor === 22 && patch < 1) throw new Error(`Code - OSS requires Node ${pin.node}+ in major 22. Use a workspace-local toolchain; do not bypass its version check.`);
  await prepare();
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-icons.ps1'), '-LogoPath', path.join(root, 'hydra-logo.png'), '-ResourceDirectory', path.join(source, 'resources', 'win32')], root);
  await npm(['run', 'build'], root);
  await npm(['ci'], source);
  await stageClassicCodicons(source);
  await npm(['run', 'gulp', '--', 'vscode-win32-x64'], source);
  await contained(output);
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-native-helper-build.ps1'), '-OutputPath', path.join(output, 'tools', 'HydraUpdateVerify.exe')], root);
  // Stamp after upstream packaging and before signing; Code - OSS otherwise
  // retains its 1.113.0 PE ProductVersion even when product.json is Hydra.
  const rcedit = promisify(createRequire(path.join(source, 'package.json'))('rcedit'));
  const release = await readJson(path.join(root, 'package.json'));
  await rcedit(path.join(output, 'Hydra.exe'), windowsExecutableVersion(release.version));
  const helperVersion = windowsExecutableVersion(release.version);
  helperVersion['version-string'].OriginalFilename = 'HydraUpdateVerify.exe';
  await rcedit(path.join(output, 'tools', 'HydraUpdateVerify.exe'), helperVersion);
  await stageHydra(path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager'));
  await stageHydraLook(path.join(output, 'resources', 'app', 'extensions', 'hydra-look'));
  await stageVscodeIcons(path.join(output, 'resources', 'app', 'extensions', vscodeIcons.id));
  await verify();
}
export async function smoke() {
  await verify();
  await run(process.execPath, [path.join(root, 'scripts', 'desktop-appearance-smoke.mjs')], root);
  await npm(['run', 'test:smoke'], root, { HYDRA_TEST_DESKTOP: path.join(output, 'Hydra.exe') });
}
export async function installer() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Installer generation requires native Windows x64.');
  await verify();
  await contained(source);
  if (await git(['rev-parse', 'HEAD']) !== pin.commit) throw new Error('Installer requires the pinned editor checkout.');
  const manifest = await readJson(path.join(root, 'package.json'));
  const product = await readJson(path.join(output, 'resources', 'app', 'product.json'));
  const bundled = await readJson(path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager', 'package.json'));
  if (product.hydraVersion !== manifest.version || bundled.version !== manifest.version) throw new Error('Build the current Hydra runtime before packaging its installer.');
  const sourcePath = 'build/gulpfile.vscode.win32.ts';
  await fs.writeFile(path.join(source, sourcePath), installerInventorySource(
    installerVersionSource(await git(['show', `${pin.commit}:${sourcePath}`]), manifest.version),
    path.join(root, 'scripts', 'desktop-installed-inventory.mjs'), pin.commit));
  for (const name of installerIncludes) await fs.copyFile(path.join(root, 'desktop', name), path.join(source, 'build', 'win32', name));
  await fs.writeFile(path.join(source, 'build', 'win32', 'code.iss'), brandedInstaller(await git(['show', `${pin.commit}:build/win32/code.iss`])));
  // The standalone app task does not stage installer-specific updater tools.
  // Use the pinned task, including Hydra's icon, before compiling [Files].
  await npm(['run', 'gulp', '--', 'vscode-win32-x64-inno-updater'], source);
  for (const name of ['inno_updater.exe','vcruntime140.dll','HydraUpdateVerify.exe']) {
    const tool=await fs.readFile(path.join(output,'tools',name));
    if(tool.length<1024||tool.subarray(0,2).toString()!=='MZ')throw new Error(`Required installer tool is missing or invalid: ${name}`);
  }
  const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Hydra source commit is invalid.');
  await npm(['run', 'gulp', '--', 'vscode-win32-x64-user-setup'], source, { HYDRA_SOURCE_COMMIT: sourceCommit });
  const setup = path.join(source, '.build', 'win32-x64', 'user-setup', 'HydraSetup.exe');
  const setupDirectory = path.dirname(setup);
  await run(process.execPath, [path.join(root, 'scripts', 'desktop-installed-inventory.mjs'), 'verify-inputs',
    '--source', output, '--product', path.join(setupDirectory, 'product.json'),
    '--inno', path.join(source, 'build', 'win32', 'code.iss'),
    '--inventory', path.join(setupDirectory, 'HydraInstalledInventory.json'),
    '--version', manifest.version, '--source-commit', sourceCommit, '--upstream-commit', pin.commit], root);
  const bytes = await fs.readFile(setup);
  if (bytes.length < 1024 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Installer executable is missing or invalid.');
  console.log(`Generated unsigned Hydra ${manifest.version} user installer: ${setup}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = { prepare, build, verify, smoke, installer };
  const command = commands[process.argv[2]];
  if (!command) throw new Error('Use desktop.mjs prepare, build, verify, smoke, or installer.');
  await command();
}

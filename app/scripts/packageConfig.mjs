// What app/scripts/package.mjs packages and how, kept apart so app/tests can check it.

export const EXE = 'Hydra.exe';
/** G1's fuses (docs/internal/hydra-app/G1-spikes.md, S4.3). RunAsNode stays on: the MCP bridge, `hydra`, the limit hook,
 *  pack gates and the uninstall cleanup run as `ELECTRON_RUN_AS_NODE=1 Hydra.exe`. */
export const APP_FUSES = Object.freeze({
  RunAsNode: true,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
});
/** node-pty's files the app needs on Windows x64: its loader and the N-API prebuilds, never rebuilt (G1 S4.2). */
export const NODE_PTY_PARTS = Object.freeze(['package.json', 'LICENSE', 'lib', 'prebuilds/win32-x64']);
/** Native files stay outside the archive, where Windows can load them. */
export const UNPACK = '*.{node,dll,exe}';
/** What isn't shipped: debug symbols, source maps, node-pty's tests. */
export const excluded = file => /\.(pdb|map)$/i.test(file) || /[\\/]lib[\\/].*\.test\.js$/i.test(file) || /[\\/]lib[\\/]shared[\\/]test/i.test(file);

/** The installer's version: x.y.z only, each part a Windows version field. */
export function releaseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match.slice(1).some(part => Number(part) > 65535)) throw new Error(`The app's version ${JSON.stringify(version)} isn't a stable x.y.z release version.`);
  return version;
}
/** The package's release channel: "stable" only when asked for; a preview otherwise, which never updates itself. */
export function releaseChannel(value) {
  if (value === undefined || value === 'preview') return 'preview';
  if (value === 'stable') return 'stable';
  throw new Error(`Unknown channel ${JSON.stringify(value)}: use stable or preview.`);
}
/** Windows version resources for Hydra.exe. */
export function versionStrings(version) {
  return { ProductName: 'Hydra', FileDescription: 'Hydra', CompanyName: 'Nico Dunlap', ProductVersion: version, FileVersion: version, OriginalFilename: EXE, InternalName: 'Hydra', LegalCopyright: 'MIT License' };
}
/** The definitions app/installer/hydra-app.iss expects. */
export function installerDefinitions({ version, sourceDir, outputDir, setupIcon }) {
  return { Version: releaseVersion(version), RawVersion: version, SourceDir: sourceDir, OutputDir: outputDir, SetupIcon: setupIcon };
}

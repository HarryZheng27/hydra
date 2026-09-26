// Signs Hydra's stable Windows x64 per-user update record (docs/Desktop_Signed_Update.md).
// The output is the exact envelope src/core/desktopSignedUpdate.ts verifies, and the
// script runs that same verifier on it before writing anything.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerName = 'HydraSetup.exe';
// desktopUpdateStaging refuses artifacts over 1 GiB, so a larger record could never install.
const maxInstallerBytes = 1024 * 1024 * 1024;
const maxExecutableBytes = 1024 * 1024 * 1024;
const maxRecordBytes = 1024 * 1024;
const maxExpiryDays = 365;
const futureSkewMs = 5 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const product = Object.freeze({ nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' });
const updateTarget = Object.freeze({ platform: 'win32', architecture: 'x64', installTarget: 'user' });
const inventoryPaths = ['Hydra.exe', 'resources/app/product.json', 'resources/app/extensions/hydra-agent-manager/package.json'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)[-+]/;
const commitPattern = /^[a-f0-9]{40}$/;
const keyIdPattern = /^[A-Za-z0-9._-]{1,80}$/;
const thumbprintPattern = /^[A-F0-9]{40}$/;
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const valueOptions = new Set(['--installer', '--installed', '--version', '--commit', '--sequence', '--run-id', '--issued', '--expires-days', '--out']);
const flagOptions = new Set(['--rotate-trust']);

export const usage = [
  'Usage: node scripts/desktop-update-sign.mjs --installer <HydraSetup.exe> --installed <folder> --version <x.y.z>',
  '         --commit <40-hex> --sequence <n> --out <user.json> [--run-id <n>] [--issued <ISO time>] [--expires-days <n>] [--rotate-trust]',
  '',
  '  --installer     the final, Authenticode-signed HydraSetup.exe (its bytes, length and signer are signed)',
  '  --installed     a folder that installer installed into (Hydra.exe, resources/app/product.json and the',
  '                  bundled module package.json are hashed at those exact relative paths)',
  '  --version       the stable release version; it must equal the installed product.json hydraVersion and',
  '                  the bundled module version',
  '  --commit        the source commit the installer was built from (40 lowercase hex characters)',
  '  --sequence      a positive integer higher than every record published before; never reuse one',
  '  --run-id        the build run ID for provenance (default: GITHUB_RUN_ID)',
  '  --issued        issue time (default: now); --expires-days: validity (default 30, at most 365)',
  '  --out           where to write the envelope; it must not exist yet',
  '  --rotate-trust  allow a release whose built-in update trust names a different key or signer',
  '',
  'The Ed25519 private key (PKCS#8 PEM) and its key ID come only from the environment variables',
  'HYDRA_UPDATE_SIGNING_KEY and HYDRA_UPDATE_KEY_ID. Neither is ever printed.'
].join('\n');

class Refusal extends Error {}
function refuse(reason) { throw new Refusal(reason); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function shown(value) { return JSON.stringify(String(value ?? '').slice(0, 80)); }
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }

function positiveInteger(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) refuse(`${label} must be a positive whole number.`);
  return Number(value);
}

function parseArguments(argv, env, now) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (flagOptions.has(name) || valueOptions.has(name)) {
      if (Object.hasOwn(options, name)) refuse(`${name} is given twice.`);
    } else refuse(/^--[a-z][a-z-]{0,30}$/.test(String(name)) ? `unknown option ${name}. Keys are read only from the environment.` : 'an unexpected argument was given (argument values are never echoed).');
    if (flagOptions.has(name)) { options[name] = true; continue; }
    const value = argv[++index];
    if (typeof value !== 'string' || !value || value.startsWith('--')) refuse(`${name} needs a value.`);
    options[name] = value;
  }
  for (const name of ['--installer', '--installed', '--version', '--commit', '--sequence', '--out']) {
    if (!Object.hasOwn(options, name)) refuse(`${name} is required.\n${usage}`);
  }

  const version = options['--version'];
  if (semanticVersion.test(version)) refuse(`version ${shown(version)} is a prerelease or build version; the stable channel refuses those.`);
  if (!stableVersion.test(version)) refuse(`version ${shown(version)} is not a stable x.y.z version.`);
  // Windows file versions and Hydra's installed trust check cap each part at 65535.
  if (version.split('.').some(part => Number(part) > 65535)) refuse(`version ${shown(version)} has a part above 65535.`);
  if (version === '0.0.0') refuse('version 0.0.0 can never be newer than an installed release.');

  const commit = options['--commit'];
  if (!commitPattern.test(commit)) refuse('--commit must be the 40-character lowercase hexadecimal source commit.');
  const sequence = positiveInteger(options['--sequence'], '--sequence');
  const runIdSource = options['--run-id'] ?? env.GITHUB_RUN_ID;
  if (runIdSource === undefined) refuse('--run-id is required outside GitHub Actions (it defaults to GITHUB_RUN_ID).');
  const runId = positiveInteger(runIdSource, '--run-id');

  let issuedAt = now;
  if (options['--issued'] !== undefined) {
    const parsed = Date.parse(options['--issued']);
    if (!isoTime.test(options['--issued']) || !Number.isFinite(parsed)) refuse('--issued must be an ISO time with a zone, such as 2026-09-26T12:00:00.000Z.');
    issuedAt = parsed;
  }
  if (issuedAt > now + futureSkewMs) refuse('--issued is in the future; clients would refuse the record until then.');
  const days = options['--expires-days'] === undefined ? 30 : positiveInteger(options['--expires-days'], '--expires-days');
  if (days > maxExpiryDays) refuse(`--expires-days must be at most ${maxExpiryDays}.`);
  const expiresAt = issuedAt + days * dayMs;
  if (expiresAt <= now) refuse('the record would already be expired; use a later --issued or more --expires-days.');

  const installer = path.resolve(options['--installer']);
  if (path.basename(installer) !== installerName) refuse(`--installer must be the file named ${installerName}; the update record can name no other artifact.`);
  return {
    installer, installed: path.resolve(options['--installed']), version, commit, sequence, runId,
    issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    out: path.resolve(options['--out']), rotateTrust: options['--rotate-trust'] === true
  };
}

function readSigningKey(env) {
  const pem = env.HYDRA_UPDATE_SIGNING_KEY;
  const keyId = env.HYDRA_UPDATE_KEY_ID;
  // Nothing this script starts (esbuild, PowerShell) may inherit the private key.
  delete env.HYDRA_UPDATE_SIGNING_KEY;
  if (typeof pem !== 'string' || !pem.trim()) refuse('HYDRA_UPDATE_SIGNING_KEY is not set. The signing key is read only from that environment variable.');
  if (typeof keyId !== 'string' || !keyId) refuse('HYDRA_UPDATE_KEY_ID is not set.');
  if (!keyIdPattern.test(keyId)) refuse('HYDRA_UPDATE_KEY_ID must be 1 to 80 letters, digits, dots, underscores or hyphens.');
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) refuse('HYDRA_UPDATE_SIGNING_KEY is not an unencrypted PKCS#8 PEM private key.');
  let privateKey;
  try { privateKey = createPrivateKey({ key: pem, format: 'pem' }); }
  catch { refuse('HYDRA_UPDATE_SIGNING_KEY could not be read as a PKCS#8 PEM private key.'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') refuse('HYDRA_UPDATE_SIGNING_KEY is not an Ed25519 key.');
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey, keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    fingerprint: sha256(publicKey.export({ type: 'spki', format: 'der' }))
  };
}

function redact(message, secret) {
  if (typeof secret !== 'string' || !secret) return message;
  let text = message.split(secret).join('[redacted]');
  for (const line of secret.split(/\r?\n/).map(item => item.trim()).filter(item => item.length >= 16 && !item.startsWith('-----'))) {
    text = text.split(line).join('[redacted]');
  }
  return text;
}

async function requireDirectory(directory, label) {
  let info;
  try { info = await fs.lstat(directory); }
  catch { refuse(`${label} ${directory} does not exist.`); }
  if (info.isSymbolicLink() || !info.isDirectory()) refuse(`${label} ${directory} is not a real folder.`);
}

/** Resolves an exact relative path under base, refusing links and junctions at every step. */
async function installedFile(base, relative) {
  const parts = relative.split('/');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await fs.lstat(current); }
    catch { refuse(`the installed folder has no ${relative}.`); }
    if (info.isSymbolicLink()) refuse(`${relative} in the installed folder passes through a link or junction.`);
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) refuse(`${relative} in the installed folder is not a regular file.`);
  }
  return current;
}

async function hashFile(file, maxBytes, label) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) refuse(`${label} is not a regular file.`);
    if (before.size <= 0 || before.size > maxBytes) refuse(`${label} is empty or larger than ${maxBytes} bytes.`);
    const hash = createHash('sha256');
    const block = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(block, 0, Math.min(block.length, before.size - position), position);
      if (!bytesRead) refuse(`${label} was truncated while it was read.`);
      hash.update(block.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) refuse(`${label} changed while it was read.`);
    return { bytes: before.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function readJsonRecord(file, label) {
  const bytes = await fs.readFile(file);
  if (!bytes.length || bytes.length > maxRecordBytes) refuse(`${label} is empty or too large.`);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { refuse(`${label} is not UTF-8 JSON.`); }
  if (!plainObject(value)) refuse(`${label} is not a JSON object.`);
  return { value, sha256: sha256(bytes) };
}

/** Reads the installer's Authenticode signer and Hydra.exe's PE version through Windows itself. */
async function inspectWindowsFiles({ installer, executable }) {
  if (process.platform !== 'win32') refuse('reading the installer\'s Authenticode signature needs Windows (Get-AuthenticodeSignature).');
  const literal = file => `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(file, 'utf16le').toString('base64')}'))`;
  const command = [
    '$ErrorActionPreference = "Stop"',
    `$installer = ${literal(installer)}`,
    `$executable = ${literal(executable)}`,
    '$signature = Get-AuthenticodeSignature -LiteralPath $installer',
    '$version = (Get-Item -LiteralPath $executable).VersionInfo',
    '$certificate = $signature.SignerCertificate',
    '[pscustomobject]@{',
    '  installer = [pscustomobject]@{',
    '    status = [string]$signature.Status',
    '    subject = if ($certificate) { [string]$certificate.Subject } else { $null }',
    '    thumbprint = if ($certificate) { [string]$certificate.Thumbprint } else { $null }',
    '  }',
    '  executable = [pscustomobject]@{ productName = [string]$version.ProductName; productVersion = [string]$version.ProductVersion }',
    '} | ConvertTo-Json -Compress -Depth 4'
  ].join('\n');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 120000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Refusal(`could not read the installer's Authenticode signature: ${stderr.trim().slice(0, 400) || `PowerShell exited with ${code}`}`)));
  });
  try { return JSON.parse(String(output).trim()); }
  catch { refuse('could not read the installer\'s Authenticode signature (PowerShell returned no JSON).'); }
}

function checkInspection(result, version) {
  const installer = result?.installer, executable = result?.executable;
  if (!plainObject(installer) || !plainObject(executable)) refuse('Windows returned no Authenticode or version details.');
  if (installer.status !== 'Valid') refuse(`${installerName} is not validly Authenticode-signed (Windows reports ${shown(installer.status || 'no status')}). The update record claims a valid publisher signature, so code-sign the installer before signing its update record.`);
  const subject = installer.subject;
  if (typeof subject !== 'string' || subject.length < 3 || subject.length > 512 || subject.trim() !== subject || /[\x00-\x1f\x7f]/.test(subject)) refuse('the installer\'s Authenticode signer subject is invalid.');
  if (typeof installer.thumbprint !== 'string' || !thumbprintPattern.test(installer.thumbprint)) refuse('the installer\'s Authenticode signer thumbprint is not 40 uppercase hexadecimal characters.');
  if (executable.productName !== 'Hydra' || executable.productVersion !== version) refuse(`the installed Hydra.exe is ${shown(executable.productName)} version ${shown(executable.productVersion)}, not Hydra ${version}.`);
  return { subject, thumbprint: installer.thumbprint };
}

/** Bundles the app's own verifier and trust parser, so this script can never drift from them. */
async function loadHydraVerifier() {
  let esbuild;
  try { esbuild = await import('esbuild'); }
  catch { refuse('esbuild is not installed. Run npm ci first: the check uses Hydra\'s own verifier from src/core/desktopSignedUpdate.ts.'); }
  const build = esbuild.build ?? esbuild.default?.build;
  const result = await build({
    stdin: {
      contents: "export { verifyDesktopSignedUpdate } from './src/core/desktopSignedUpdate.ts';\nexport { parseHydraUpdateTrust } from './desktop/main/hydraUpdateTrust.ts';\n",
      resolveDir: root, sourcefile: 'desktop-update-sign-verifier.mjs', loader: 'js'
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'silent'
  });
  const code = result.outputFiles[0].text;
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  if (typeof module.verifyDesktopSignedUpdate !== 'function' || typeof module.parseHydraUpdateTrust !== 'function') refuse('Hydra\'s verifier could not be loaded.');
  return module;
}

function checkInstalledIdentity(productJson, moduleJson, version) {
  if (productJson.nameShort !== product.nameShort || productJson.applicationName !== product.applicationName || productJson.win32AppUserModelId !== product.win32AppUserModelId) {
    refuse('the installed resources/app/product.json is not Hydra\'s (its name or app identity differs).');
  }
  if (productJson.hydraVersion !== version) refuse(`the installed product.json hydraVersion is ${shown(productJson.hydraVersion)}, not ${version}.`);
  if (productJson.target !== 'user') refuse('the installed folder is not a per-user install (product.json target is not "user").');
  if (moduleJson.name !== 'hydra-agent-manager' || moduleJson.publisher !== 'nico-dunlap') refuse('the installed bundled module package.json is not Hydra\'s.');
  if (moduleJson.version !== version) refuse(`the installed bundled module package.json version is ${shown(moduleJson.version)}, not ${version}.`);
}

/**
 * The CLI always reads Windows' own Authenticode result. `inspectWindows` is replaceable only by
 * code that imports this module (the unit test), never by an argument or environment variable.
 */
export async function main(argv = process.argv.slice(2), env = process.env, { inspectWindows = inspectWindowsFiles } = {}) {
  const secret = env.HYDRA_UPDATE_SIGNING_KEY;
  try {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { console.log(usage); return 0; }
    const clock = Date.now();
    const options = parseArguments(argv, env, clock);
    const key = readSigningKey(env);

    await requireDirectory(path.dirname(options.out), 'the output folder');
    try { await fs.lstat(options.out); refuse(`${options.out} already exists; the signed record is never overwritten.`); }
    catch (error) { if (error instanceof Refusal) throw error; }

    await requireDirectory(options.installed, 'the installed folder');
    const executablePath = await installedFile(options.installed, inventoryPaths[0]);
    const productRecord = await readJsonRecord(await installedFile(options.installed, inventoryPaths[1]), 'the installed product.json');
    const moduleRecord = await readJsonRecord(await installedFile(options.installed, inventoryPaths[2]), 'the installed bundled module package.json');
    checkInstalledIdentity(productRecord.value, moduleRecord.value, options.version);

    const { verifyDesktopSignedUpdate, parseHydraUpdateTrust } = await loadHydraVerifier();
    let embedded;
    try { embedded = parseHydraUpdateTrust(productRecord.value, 'win32', 'x64'); }
    catch { refuse('the installed product.json fails Hydra\'s own startup check (its identity or hydraUpdateTrust is invalid).'); }
    if (embedded && !options.rotateTrust) {
      if (embedded.keyId !== key.keyId) refuse('this release\'s built-in hydraUpdateTrust.keyId differs from HYDRA_UPDATE_KEY_ID. If the release deliberately rotates the update key, pass --rotate-trust.');
      if (embedded.publicKeyPem !== key.publicKeyPem) refuse('this release\'s built-in hydraUpdateTrust.publicKeyPem is not the public half of HYDRA_UPDATE_SIGNING_KEY. If the release deliberately rotates the update key, pass --rotate-trust.');
    }

    let installerInfo;
    try { installerInfo = await fs.lstat(options.installer); }
    catch { refuse(`${options.installer} does not exist.`); }
    if (installerInfo.isSymbolicLink() || !installerInfo.isFile()) refuse(`${options.installer} is not a regular file.`);
    const installer = await hashFile(options.installer, maxInstallerBytes, installerName);
    const executable = await hashFile(executablePath, maxExecutableBytes, 'the installed Hydra.exe');

    const signer = checkInspection(await inspectWindows({ installer: options.installer, executable: executablePath }), options.version);
    if (embedded && !options.rotateTrust && !embedded.authenticodeSigners.some(item => item.thumbprint === signer.thumbprint && item.subject === signer.subject)) {
      refuse('the installer\'s Authenticode signer is not in this release\'s built-in authenticodeSigners allowlist. If the release deliberately rotates its signer, pass --rotate-trust.');
    }
    // The bytes Windows inspected must be the bytes being signed.
    const installerAgain = await hashFile(options.installer, maxInstallerBytes, installerName);
    const executableAgain = await hashFile(executablePath, maxExecutableBytes, 'the installed Hydra.exe');
    if (installerAgain.sha256 !== installer.sha256 || installerAgain.bytes !== installer.bytes || executableAgain.sha256 !== executable.sha256) refuse('an input changed while it was being checked.');

    const expectedFiles = [
      { path: inventoryPaths[0], sha256: executable.sha256 },
      { path: inventoryPaths[1], sha256: productRecord.sha256 },
      { path: inventoryPaths[2], sha256: moduleRecord.sha256 }
    ];
    // Key order matches parseDesktopUpdateFeed's reconstruction, which its sha256 seals.
    const unsigned = {
      version: 1, product: { ...product }, channel: 'stable',
      release: {
        version: options.version,
        artifact: { fileName: installerName, sha256: installer.sha256 },
        signature: { status: 'valid', subject: signer.subject, thumbprint: signer.thumbprint, artifactSha256: installer.sha256 },
        provenance: { sourceCommit: options.commit, buildRunId: options.runId, artifactSha256: installer.sha256 }
      }
    };
    const manifest = { ...unsigned, sha256: sha256(JSON.stringify(unsigned)) };
    const payload = {
      schemaVersion: 1, target: { ...updateTarget }, sequence: options.sequence,
      issuedAt: options.issuedAt, expiresAt: options.expiresAt, artifactBytes: installer.bytes,
      expectedFiles, manifest
    };
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = sign(null, payloadBytes, key.privateKey);
    const envelope = Buffer.from(JSON.stringify({
      schemaVersion: 1, keyId: key.keyId, payload: payloadBytes.toString('base64'), signature: signature.toString('base64')
    }), 'utf8');

    const trust = { keyId: key.keyId, publicKeyPem: key.publicKeyPem, channel: 'stable', ...updateTarget };
    const current = { product: { ...product }, channel: 'stable', version: '0.0.0' };
    const verifyAt = Math.max(clock, Date.parse(options.issuedAt));
    let verified;
    try {
      verified = verifyDesktopSignedUpdate(envelope, current, trust, null, verifyAt);
      verifyDesktopSignedUpdate(envelope, current, trust, { sequence: options.sequence, payloadSha256: verified.payloadSha256 }, verifyAt);
    } catch (error) { refuse(`the signed record does not pass Hydra's own verifier: ${error instanceof Error ? error.message : String(error)}`); }
    if (verified.availableVersion !== options.version || verified.sequence !== options.sequence || verified.artifactBytes !== installer.bytes ||
      verified.artifact.sha256 !== installer.sha256 || verified.provenance.sourceCommit !== options.commit || verified.provenance.buildRunId !== options.runId ||
      JSON.stringify(verified.expectedFiles) !== JSON.stringify(expectedFiles)) refuse('the verified record differs from its inputs.');

    await fs.writeFile(options.out, envelope, { flag: 'wx' });
    const origin = embedded ? embedded.origin : '<update origin>';
    console.log([
      `Signed the Hydra ${options.version} stable update record: ${options.out}`,
      `  sequence ${options.sequence}, issued ${options.issuedAt}, expires ${options.expiresAt}`,
      `  ${installerName}: ${installer.bytes} bytes, SHA-256 ${installer.sha256}`,
      `  Authenticode signer: ${signer.subject} (${signer.thumbprint})`,
      `  payload SHA-256 ${verified.payloadSha256}; signing public key SHA-256 ${key.fingerprint}`,
      `  Verified with Hydra's own verifier. Publish both files byte for byte, served directly (no redirect):`,
      `    ${origin}/channels/stable/win32-x64/user.json`,
      `    ${origin}/artifacts/sha256/${installer.sha256}/${installerName}`,
      embedded ? (options.rotateTrust ? '  This release rotates its built-in update trust (--rotate-trust).' : '  This release\'s built-in update trust matches the signing key and installer signer.')
        : '  Note: this release\'s built-in update trust is disabled, so people who install it will not check for later updates.'
    ].join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof Refusal ? error.message : `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`Desktop update signing refused: ${redact(message, secret)}`);
    return 1;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) {
  process.exitCode = await main();
}

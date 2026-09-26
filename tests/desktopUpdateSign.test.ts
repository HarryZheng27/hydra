import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyDesktopSignedUpdate, type InstalledDesktopUpdateTrust } from '../src/core/desktopSignedUpdate';
import type { DesktopUpdateCurrent } from '../src/core/desktopUpdateFeed';

// Run from the repository root, as npm test does.
const root = process.cwd();
const signScript = path.join(root, 'scripts', 'desktop-update-sign.mjs');
const keyScript = path.join(root, 'scripts', 'desktop-update-key.mjs');
const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPrivatePem = otherKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const otherPublicPem = otherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = 'hydra-test-key';
const version = '0.24.0';
const commit = 'c'.repeat(40);
const dayMs = 24 * 60 * 60 * 1000;
const product = { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' } as const;
const signer = { subject: 'CN=Hydra Test Signer, O=Nico Dunlap', thumbprint: 'A'.repeat(40) };
const current: DesktopUpdateCurrent = { product, channel: 'stable', version: '0.23.0' };
const inventory = ['Hydra.exe', 'resources/app/product.json', 'resources/app/extensions/hydra-agent-manager/package.json'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const secretLines = (pem: string) => pem.split('\n').filter(line => line && !line.startsWith('-----'));
const directories: string[] = [];
after(async () => { for (const directory of directories) await fs.rm(directory, { recursive: true, force: true }); });

function trust(publicKeyPem = publicPem, id = keyId): InstalledDesktopUpdateTrust {
  return { keyId: id, publicKeyPem, channel: 'stable', platform: 'win32', architecture: 'x64', installTarget: 'user' };
}
const trustBase = { schemaVersion: 1, product: 'Hydra', channel: 'stable', target: { platform: 'win32', architecture: 'x64', installTarget: 'user' } };
const disabledTrust = { ...trustBase, status: 'disabled' };
function enabledTrust(publicKeyPem = publicPem, id = keyId, signers = [signer]) {
  return { ...trustBase, status: 'enabled', origin: 'https://updates.example.com', keyId: id, publicKeyPem, authenticodeSigners: signers };
}

interface Fixture { directory: string; installer: string; installed: string; out: string; files: Record<string, Buffer> }

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A fake per-user install and installer shaped like the real ones. */
async function fixture(options: { productVersion?: string; moduleVersion?: string; updateTrust?: unknown; installerName?: string } = {}): Promise<Fixture> {
  const directory = await tempDirectory('hydra-update-sign-');
  const installed = path.join(directory, 'installed');
  const files: Record<string, Buffer> = {
    'Hydra.exe': Buffer.from('MZ fake Hydra executable'),
    'resources/app/product.json': Buffer.from(JSON.stringify({
      ...product, win32x64UserAppId: '{{4C372D32-54B2-43D8-8C63-ECC31D3744A8}', target: 'user',
      hydraUpdateTrust: options.updateTrust ?? disabledTrust, hydraVersion: options.productVersion ?? version
    }, null, '\t')),
    'resources/app/extensions/hydra-agent-manager/package.json': Buffer.from(JSON.stringify({
      name: 'hydra-agent-manager', publisher: 'nico-dunlap', version: options.moduleVersion ?? version
    }, null, 2) + '\n')
  };
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(installed, name)), { recursive: true });
    await fs.writeFile(path.join(installed, name), bytes);
  }
  const installer = path.join(directory, options.installerName ?? 'HydraSetup.exe');
  await fs.writeFile(installer, Buffer.concat([Buffer.from('MZ fake installer '), Buffer.alloc(70000, 7)]));
  return { directory, installer, installed, out: path.join(directory, 'user.json'), files };
}

function args(item: Fixture, overrides: Record<string, string | undefined> = {}, extra: string[] = []): string[] {
  const values: Record<string, string | undefined> = {
    '--installer': item.installer, '--installed': item.installed, '--version': version, '--commit': commit,
    '--sequence': '42', '--run-id': '9001', '--out': item.out, ...overrides
  };
  return [...Object.entries(values).filter(([, value]) => value !== undefined).flatMap(([name, value]) => [name, value as string]), ...extra];
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const value: NodeJS.ProcessEnv = { ...process.env, HYDRA_UPDATE_SIGNING_KEY: privatePem, HYDRA_UPDATE_KEY_ID: keyId };
  delete value.GITHUB_RUN_ID;
  for (const [name, item] of Object.entries(extra)) {
    if (item === undefined) delete value[name];
    else value[name] = item;
  }
  return value;
}

function noSecret(result: SpawnSyncReturns<string>, pems = [privatePem, otherPrivatePem]): SpawnSyncReturns<string> {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const pem of pems) for (const line of secretLines(pem)) assert.ok(!output.includes(line), 'a private key was printed');
  return result;
}

/** The real CLI, exactly as CI runs it. */
function runCli(argv: string[], environment = env()): SpawnSyncReturns<string> {
  return noSecret(spawnSync(process.execPath, [signScript, ...argv], { env: environment, encoding: 'utf8', timeout: 120000 }));
}

function inspection(overrides: { status?: string; subject?: string; thumbprint?: string; productVersion?: string } = {}) {
  return {
    installer: { status: overrides.status ?? 'Valid', subject: overrides.subject ?? signer.subject, thumbprint: overrides.thumbprint ?? signer.thumbprint },
    executable: { productName: 'Hydra', productVersion: overrides.productVersion ?? version }
  };
}

let wrappers = 0;
/**
 * The same script in a child process with the key in its environment, except that Windows'
 * Authenticode answer for the unsigned fixture installer is supplied by this test.
 */
async function runSigned(item: Fixture, argv: string[], answer: unknown = inspection(), environment = env()): Promise<SpawnSyncReturns<string>> {
  const wrapper = path.join(item.directory, `sign-${wrappers++}.mjs`);
  await fs.writeFile(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(signScript).href)};\n` +
    `process.exitCode = await main(process.argv.slice(2), process.env, { inspectWindows: async () => (${JSON.stringify(answer)}) });\n`);
  return noSecret(spawnSync(process.execPath, [wrapper, ...argv], { env: environment, encoding: 'utf8', timeout: 120000 }));
}

async function missing(file: string): Promise<boolean> {
  try { await fs.lstat(file); return false; } catch { return true; }
}

function refused(result: SpawnSyncReturns<string>, reason: RegExp): void {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Desktop update signing refused: /);
  assert.match(result.stderr, reason);
}

function decoded(envelope: Buffer) {
  const outer = JSON.parse(envelope.toString('utf8'));
  return { outer, payload: JSON.parse(Buffer.from(outer.payload, 'base64').toString('utf8')) };
}

test('signs a record that Hydra\'s real verifier accepts with the matching trust', async () => {
  const item = await fixture();
  const issued = new Date(Date.now() - 60_000).toISOString();
  const result = await runSigned(item, args(item, { '--issued': issued }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(keyId), 'the key ID is not printed');
  assert.match(result.stdout, /sequence 42/);
  assert.match(result.stdout, /Verified with Hydra's own verifier/);
  assert.match(result.stdout, /built-in update trust is disabled/);

  const envelope = await fs.readFile(item.out);
  assert.notEqual(envelope.at(-1), 0x0a, 'the envelope has no trailing newline; the verifier needs its exact bytes');
  const installer = await fs.readFile(item.installer);
  const now = Date.now();
  const verified = verifyDesktopSignedUpdate(envelope, current, trust(), null, now);
  assert.equal(verified.availableVersion, version);
  assert.equal(verified.sequence, 42);
  assert.equal(verified.artifactBytes, installer.length);
  assert.deepEqual(verified.artifact, { fileName: 'HydraSetup.exe', sha256: hash(installer) });
  assert.deepEqual(verified.signature, { status: 'valid', ...signer, artifactSha256: hash(installer) });
  assert.deepEqual(verified.provenance, { sourceCommit: commit, buildRunId: 9001, artifactSha256: hash(installer) });
  assert.deepEqual(verified.expectedFiles, inventory.map(name => ({ path: name, sha256: hash(item.files[name]!) })));
  const { outer, payload } = decoded(envelope);
  assert.deepEqual(Object.keys(outer), ['schemaVersion', 'keyId', 'payload', 'signature']);
  assert.equal(outer.keyId, keyId);
  assert.equal(payload.issuedAt, issued);
  assert.equal(Date.parse(payload.expiresAt) - Date.parse(issued), 30 * dayMs);
  assert.deepEqual(payload.target, { platform: 'win32', architecture: 'x64', installTarget: 'user' });

  // The same record may resume at its own sequence, and refuses a newer floor, expiry and an equal install.
  assert.equal(verifyDesktopSignedUpdate(envelope, current, trust(), { sequence: 42, payloadSha256: verified.payloadSha256 }, now).payloadSha256, verified.payloadSha256);
  assert.throws(() => verifyDesktopSignedUpdate(envelope, current, trust(), { sequence: 43, payloadSha256: verified.payloadSha256 }, now), /replay or equivocation/);
  assert.throws(() => verifyDesktopSignedUpdate(envelope, current, trust(), null, Date.parse(payload.expiresAt)), /validity window/);
  assert.throws(() => verifyDesktopSignedUpdate(envelope, { ...current, version }, trust(), null, now), /not newer/);
});

test('takes the run ID from GITHUB_RUN_ID and a custom expiry, and refuses to overwrite its output', async () => {
  const item = await fixture();
  const result = await runSigned(item, args(item, { '--run-id': undefined, '--expires-days': '7' }), inspection(), env({ GITHUB_RUN_ID: '31337' }));
  assert.equal(result.status, 0, result.stderr);
  const envelope = await fs.readFile(item.out);
  const verified = verifyDesktopSignedUpdate(envelope, current, trust(), null, Date.now());
  assert.equal(verified.provenance.buildRunId, 31337);
  const { payload } = decoded(envelope);
  assert.equal(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt), 7 * dayMs);

  refused(await runSigned(item, args(item)), /already exists/);
  assert.deepEqual(await fs.readFile(item.out), envelope);
  const noRunId = await fixture();
  refused(runCli(args(noRunId, { '--run-id': undefined })), /--run-id is required/);
});

test('checks the release\'s built-in trust: matching key and signer pass, others refuse unless rotating', async () => {
  const matching = await fixture({ updateTrust: enabledTrust() });
  const accepted = await runSigned(matching, args(matching));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /https:\/\/updates\.example\.com\/channels\/stable\/win32-x64\/user\.json/);
  assert.match(accepted.stdout, /built-in update trust matches/);
  assert.equal(verifyDesktopSignedUpdate(await fs.readFile(matching.out), current, trust(), null, Date.now()).availableVersion, version);

  const otherKey = await fixture({ updateTrust: enabledTrust(otherPublicPem) });
  refused(runCli(args(otherKey)), /publicKeyPem is not the public half of HYDRA_UPDATE_SIGNING_KEY.*--rotate-trust/);
  const otherId = await fixture({ updateTrust: enabledTrust(publicPem, 'hydra-other-key') });
  refused(runCli(args(otherId)), /keyId differs from HYDRA_UPDATE_KEY_ID/);
  const otherSigner = await fixture({ updateTrust: enabledTrust(publicPem, keyId, [{ subject: signer.subject, thumbprint: 'B'.repeat(40) }]) });
  refused(await runSigned(otherSigner, args(otherSigner)), /not in this release's built-in authenticodeSigners allowlist/);
  for (const item of [otherKey, otherId, otherSigner]) assert.ok(await missing(item.out));

  const rotating = await runSigned(otherKey, args(otherKey, {}, ['--rotate-trust']));
  assert.equal(rotating.status, 0, rotating.stderr);
  assert.match(rotating.stdout, /rotates its built-in update trust/);
  assert.equal(verifyDesktopSignedUpdate(await fs.readFile(otherKey.out), current, trust(), null, Date.now()).availableVersion, version);
});

test('refuses a mismatched or prerelease version and inputs the verifier would refuse', async () => {
  const item = await fixture();
  refused(runCli(args(item, { '--version': '0.25.0' })), /hydraVersion is "0\.24\.0", not 0\.25\.0/);
  refused(runCli(args(item, { '--version': '0.24.0-beta.1' })), /prerelease/);
  refused(runCli(args(item, { '--version': '0.24.0+build.7' })), /prerelease or build version/);
  refused(runCli(args(item, { '--version': '0.70000.0' })), /above 65535/);
  const moduleBehind = await fixture({ moduleVersion: '0.23.9' });
  refused(runCli(args(moduleBehind)), /bundled module package\.json version is "0\.23\.9"/);
  const wrongName = await fixture({ installerName: 'Hydra-0.24.0.exe' });
  refused(runCli(args(wrongName)), /must be the file named HydraSetup\.exe/);
  refused(await runSigned(item, args(item), inspection({ productVersion: '1.113.0' })), /installed Hydra\.exe is "Hydra" version "1\.113\.0"/);
  refused(runCli(args(item, { '--commit': 'C'.repeat(40) })), /--commit must be/);
  for (const sequence of ['0', '-1', '1.5', '9007199254740993']) refused(runCli(args(item, { '--sequence': sequence })), /--sequence must be a positive whole number/);
  refused(runCli(args(item, { '--issued': new Date(Date.now() + dayMs).toISOString() })), /in the future/);
  refused(runCli(args(item, { '--issued': new Date(Date.now() - 40 * dayMs).toISOString() })), /already be expired/);
  refused(runCli(args(item, { '--issued': '2026-09-26 12:00' })), /--issued must be an ISO time/);
  refused(runCli(args(item, { '--expires-days': '366' })), /at most 365/);
  await fs.rm(path.join(item.installed, 'resources', 'app', 'product.json'));
  refused(runCli(args(item)), /has no resources\/app\/product\.json/);
  for (const each of [item, moduleBehind, wrongName]) assert.ok(await missing(each.out));
});

test('refuses a missing, unusable or command-line key and never prints the key', async () => {
  const item = await fixture();
  refused(runCli(args(item), env({ HYDRA_UPDATE_SIGNING_KEY: undefined })), /HYDRA_UPDATE_SIGNING_KEY is not set/);
  refused(runCli(args(item), env({ HYDRA_UPDATE_SIGNING_KEY: '' })), /HYDRA_UPDATE_SIGNING_KEY is not set/);
  refused(runCli(args(item), env({ HYDRA_UPDATE_KEY_ID: undefined })), /HYDRA_UPDATE_KEY_ID is not set/);
  refused(runCli(args(item), env({ HYDRA_UPDATE_KEY_ID: 'has spaces' })), /HYDRA_UPDATE_KEY_ID must be/);
  const ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  refused(noSecret(runCli(args(item), env({ HYDRA_UPDATE_SIGNING_KEY: ecPem })), [ecPem]), /not an Ed25519 key/);
  const broken = privatePem.replace(/\n[A-Za-z0-9+/]{8}/, '\n!!!!!!!!');
  refused(noSecret(runCli(args(item), env({ HYDRA_UPDATE_SIGNING_KEY: broken })), [broken]), /could not be read as a PKCS#8 PEM private key/);
  refused(runCli(args(item), env({ HYDRA_UPDATE_SIGNING_KEY: publicPem })), /not an unencrypted PKCS#8 PEM private key/);
  const onCommandLine = runCli([...args(item), '--key', privatePem], env({ HYDRA_UPDATE_SIGNING_KEY: undefined }));
  refused(onCommandLine, /unknown option --key/);
  refused(runCli([...args(item), privatePem]), /unexpected argument/);
  assert.ok(await missing(item.out));
});

test('a tampered envelope or a different key is refused by the real verifier', async () => {
  const item = await fixture();
  assert.equal((await runSigned(item, args(item))).status, 0);
  const envelope = await fs.readFile(item.out);
  const now = Date.now();
  const { outer, payload } = decoded(envelope);
  const reencode = (value: unknown) => Buffer.from(JSON.stringify(value));

  const changedPayload = { ...payload, artifactBytes: payload.artifactBytes + 1 };
  assert.throws(() => verifyDesktopSignedUpdate(reencode({ ...outer, payload: reencode(changedPayload).toString('base64') }), current, trust(), null, now), /signature is invalid/);
  const flipped = Buffer.from(outer.signature, 'base64'); flipped[0] = flipped[0]! ^ 1;
  assert.throws(() => verifyDesktopSignedUpdate(reencode({ ...outer, signature: flipped.toString('base64') }), current, trust(), null, now), /signature is invalid/);
  const resigned = reencode(changedPayload);
  assert.throws(() => verifyDesktopSignedUpdate(reencode({ ...outer, payload: resigned.toString('base64'), signature: sign(null, resigned, otherKeys.privateKey).toString('base64') }), current, trust(), null, now), /signature is invalid/);
  assert.throws(() => verifyDesktopSignedUpdate(reencode({ ...outer, keyId: 'hydra-other-key' }), current, trust(), null, now), /metadata key is invalid/);
  assert.throws(() => verifyDesktopSignedUpdate(Buffer.concat([envelope, Buffer.from('\n')]), current, trust(), null, now), /not canonical/);
  assert.throws(() => verifyDesktopSignedUpdate(envelope, current, trust(otherPublicPem), null, now), /signature is invalid/);

  // A record the script signs with some other key does not verify against the installed key.
  const wrongKey = await fixture();
  const result = await runSigned(wrongKey, args(wrongKey), inspection(), env({ HYDRA_UPDATE_SIGNING_KEY: otherPrivatePem }));
  assert.equal(result.status, 0, result.stderr);
  const other = await fs.readFile(wrongKey.out);
  const later = Date.now();
  assert.throws(() => verifyDesktopSignedUpdate(other, current, trust(), null, later), /signature is invalid/);
  assert.equal(verifyDesktopSignedUpdate(other, current, trust(otherPublicPem), null, later).availableVersion, version);
});

test('refuses an installer that is not validly Authenticode-signed', async () => {
  const item = await fixture();
  // The real CLI asks Windows itself; the fixture installer carries no signature.
  const real = runCli(args(item));
  refused(real, process.platform === 'win32' ? /not validly Authenticode-signed|could not read the installer's Authenticode signature/ : /needs Windows/);
  for (const status of ['NotSigned', 'HashMismatch', 'NotTrusted']) {
    refused(await runSigned(item, args(item), inspection({ status })), new RegExp(`not validly Authenticode-signed \\(Windows reports "${status}"\\)`));
  }
  refused(await runSigned(item, args(item), inspection({ thumbprint: 'a'.repeat(40) })), /thumbprint is not 40 uppercase/);
  refused(await runSigned(item, args(item), inspection({ subject: ' CN=Padded' })), /signer subject is invalid/);
  refused(await runSigned(item, args(item), { installer: null }), /no Authenticode or version details/);
  assert.ok(await missing(item.out));
});

test('the key script writes an owner-only PKCS#8 key and prints its SPKI public key and next steps', async () => {
  const directory = await tempDirectory('hydra-update-key-');
  const out = path.join(directory, 'hydra-update-signing.pem');
  const result = spawnSync(process.execPath, [keyScript, '--out', out], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const written = await fs.readFile(out, 'utf8');
  assert.match(written, /^-----BEGIN PRIVATE KEY-----\n/);
  const privateKey = createPrivateKey(written);
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  noSecret(result, [written]);

  const printed = /-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+?-----END PUBLIC KEY-----\n/.exec(result.stdout)?.[0];
  assert.ok(printed, 'an SPKI PEM is printed');
  const publicKey = createPublicKey(printed);
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(printed, derived);
  assert.equal(publicKey.export({ type: 'spki', format: 'pem' }), printed, 'printed exactly as hydraUpdateTrust compares it');
  assert.ok(result.stdout.includes(`"publicKeyPem": ${JSON.stringify(derived)}`));

  const suggested = /Suggested key ID: (\S+)/.exec(result.stdout)?.[1] ?? '';
  assert.match(suggested, /^[A-Za-z0-9._-]{1,80}$/);
  assert.ok(result.stdout.includes(`gh secret set HYDRA_UPDATE_SIGNING_KEY < "${out}"`));
  assert.ok(result.stdout.includes(`gh secret set HYDRA_UPDATE_KEY_ID --body ${suggested}`));
  assert.match(result.stdout, /desktop\/product\.json/);
  assert.match(result.stdout, /"hydraUpdateTrust"/);
  assert.match(result.stdout, /offline/);
  assert.match(result.stdout, /delete this local copy/);

  if (process.platform === 'win32') {
    const acl = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [out], { encoding: 'utf8' });
    assert.equal(acl.status, 0);
    assert.doesNotMatch(acl.stdout, /\(I\)/, 'no inherited access remains');
  } else {
    assert.equal((await fs.stat(out)).mode & 0o077, 0);
  }

  // The new key, used exactly as the secrets would be, signs a record the printed trust verifies.
  const item = await fixture({ updateTrust: enabledTrust(printed, suggested) });
  const signed = await runSigned(item, args(item), inspection(), env({ HYDRA_UPDATE_SIGNING_KEY: written, HYDRA_UPDATE_KEY_ID: suggested }));
  noSecret(signed, [written]);
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(verifyDesktopSignedUpdate(await fs.readFile(item.out), current, trust(printed, suggested), null, Date.now()).availableVersion, version);
});

test('the key script refuses to overwrite, and refuses a path in this or any git working tree', async () => {
  const directory = await tempDirectory('hydra-update-key-');
  const out = path.join(directory, 'hydra-update-signing.pem');
  assert.equal(spawnSync(process.execPath, [keyScript, '--out', out], { encoding: 'utf8' }).status, 0);
  const before = await fs.readFile(out);
  const again = spawnSync(process.execPath, [keyScript, '--out', out], { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.deepEqual(await fs.readFile(out), before);

  const inRepository = path.join(root, `hydra-update-key-test-${process.pid}.pem`);
  const repositoryResult = spawnSync(process.execPath, [keyScript, '--out', inRepository], { encoding: 'utf8' });
  assert.equal(repositoryResult.status, 1);
  assert.match(repositoryResult.stderr, /inside this repository/);
  assert.ok(await missing(inRepository));

  const otherTree = await tempDirectory('hydra-update-key-tree-');
  await fs.mkdir(path.join(otherTree, '.git'));
  await fs.mkdir(path.join(otherTree, 'keys'));
  const inOtherTree = path.join(otherTree, 'keys', 'signing.pem');
  const treeResult = spawnSync(process.execPath, [keyScript, '--out', inOtherTree], { encoding: 'utf8' });
  assert.equal(treeResult.status, 1);
  assert.match(treeResult.stderr, /inside a git working tree/);
  assert.ok(await missing(inOtherTree));

  for (const argv of [[], ['--out'], ['--out', out, '--extra']]) {
    const usage = spawnSync(process.execPath, [keyScript, ...argv], { encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /give exactly one --out/);
  }
  const noFolder = spawnSync(process.execPath, [keyScript, '--out', path.join(directory, 'absent', 'key.pem')], { encoding: 'utf8' });
  assert.equal(noFolder.status, 1);
  assert.match(noFolder.stderr, /does not exist/);
});

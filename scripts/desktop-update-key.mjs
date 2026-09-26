// Creates a new Ed25519 key pair for signing Hydra's update records (docs/Desktop_Signed_Update.md).
// The release owner runs it once, locally. The private key is written only to the file named by
// --out, which must be outside every git working tree; it is never printed.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const usage = [
  'Usage: node scripts/desktop-update-key.mjs --out <private-key.pem>',
  '',
  'Writes a new Ed25519 private key (PKCS#8 PEM) to <private-key.pem>, readable only by you, and prints',
  'its public key (SPKI PEM), a suggested key ID and the steps to install both. The file must not exist',
  'and must be outside this repository and every other git working tree.'
].join('\n');

class Refusal extends Error {}
function refuse(reason) { throw new Refusal(reason); }

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function destination(out) {
  const target = path.resolve(out);
  const parent = path.dirname(target);
  let info;
  try { info = await fs.stat(parent); }
  catch { refuse(`the folder ${parent} does not exist.`); }
  if (!info.isDirectory()) refuse(`${parent} is not a folder.`);
  const realParent = await fs.realpath(parent);
  const realTarget = path.join(realParent, path.basename(target));
  if (inside(root, target) || inside(await fs.realpath(root), realTarget)) {
    refuse(`${target} is inside this repository (${root}). Keep the private key outside every repository.`);
  }
  for (let directory = realParent; ; directory = path.dirname(directory)) {
    if (await exists(path.join(directory, '.git'))) refuse(`${target} is inside a git working tree (${directory}). Keep the private key outside every repository.`);
    if (path.dirname(directory) === directory) break;
  }
  if (await exists(target)) refuse(`${target} already exists; this script never overwrites a key.`);
  return target;
}

/** Leaves the current user as the only account on the file's access list. */
function restrictToCurrentUser(file) {
  const system = process.env.SystemRoot || 'C:\\Windows';
  const identity = execFileSync(path.join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const sid = /"(S-1-5-(?:\d+-)*\d+)"/.exec(identity)?.[1];
  if (!sid) refuse('could not read the current Windows user to restrict the key file.');
  execFileSync(path.join(system, 'System32', 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
}

function instructions({ target, keyId, publicPem, fingerprint }) {
  const trust = [
    '     "hydraUpdateTrust": {',
    '       "schemaVersion": 1,',
    '       "status": "enabled",',
    '       "product": "Hydra",',
    '       "channel": "stable",',
    '       "target": { "platform": "win32", "architecture": "x64", "installTarget": "user" },',
    '       "origin": "https://<your update host>",',
    `       "keyId": ${JSON.stringify(keyId)},`,
    `       "publicKeyPem": ${JSON.stringify(publicPem)},`,
    '       "authenticodeSigners": [{ "subject": "<installer signer subject>", "thumbprint": "<40 uppercase hex>" }]',
    '     }'
  ];
  return [
    'Created a new Ed25519 update-signing key.',
    '',
    `Private key (PKCS#8 PEM, readable only by you): ${target}`,
    `Suggested key ID: ${keyId}`,
    `Public key SHA-256: ${fingerprint}`,
    '',
    'Public key (SPKI PEM):',
    publicPem.trimEnd(),
    '',
    'Next steps:',
    '1. Give the private key and its key ID to GitHub Actions as secrets, from this repository\'s folder:',
    `     gh secret set HYDRA_UPDATE_SIGNING_KEY < "${target}"`,
    `     gh secret set HYDRA_UPDATE_KEY_ID --body ${keyId}`,
    '   PowerShell has no "<" redirection; there, run the first one as:',
    `     Get-Content -Raw -LiteralPath '${target.replaceAll('\'', '\'\'')}' | gh secret set HYDRA_UPDATE_SIGNING_KEY`,
    '2. Build the public key into the app: in desktop/product.json, replace "hydraUpdateTrust" with this,',
    '   filling in your HTTPS update origin and the installer\'s Authenticode signer:',
    ...trust,
    '   publicKeyPem must be exactly that text, including its final \\n.',
    '3. Store the private key offline (for example on an encrypted drive kept away from this computer), then',
    '   delete this local copy once the secret is set:',
    `     ${target}`,
    '   Anyone who has it can sign Hydra updates that installed copies will accept.'
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { console.log(usage); return 0; }
    if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) refuse(`give exactly one --out <file>.\n${usage}`);
    const target = await destination(argv[1]);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    // Create the file empty, restrict it, and only then write the key into it.
    const handle = await fs.open(target, 'wx', 0o600);
    let written = false;
    try {
      if (process.platform === 'win32') restrictToCurrentUser(target);
      else await handle.chmod(0o600);
      await handle.writeFile(privatePem, 'utf8');
      await handle.sync();
      written = true;
    } finally {
      await handle.close();
      if (!written) await fs.rm(target, { force: true });
    }
    const keyId = `hydra-update-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${fingerprint.slice(0, 8)}`;
    console.log(instructions({ target, keyId, publicPem, fingerprint }));
    return 0;
  } catch (error) {
    const message = error instanceof Refusal ? error.message : `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`Hydra update key refused: ${message}`);
    return 1;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) {
  process.exitCode = await main();
}

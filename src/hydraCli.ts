// Entry point for dist/hydra-cli.cjs, the `hydra` command's plan, heads, status, stop and resume commands
// (run by Hydra's own executable with ELECTRON_RUN_AS_NODE=1, from the launcher in the app's bin folder).
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { callHelperEndpoint } from './core/helperEndpoint';
import { findUserHandshake } from './core/userHandshake';
import { helpersRootCandidates, runCli } from './core/hydraCli';

declare const HYDRA_VERSION: string;

// Installed: <app>/resources/app/extensions/hydra-agent-manager/dist/hydra-cli.cjs.
const appDir = path.resolve(__dirname, '..', '..', '..', '..', '..');
const portable = existsSync(path.join(appDir, 'data', 'user-data'));

async function readText(file: string): Promise<string | undefined> {
  try { if (!(await stat(file)).isFile()) return undefined; return await readFile(file, 'utf8'); } catch { return undefined; }
}

void runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  helpersRoots: helpersRootCandidates(process.env, process.platform, homedir(), appDir, portable),
  findHandshake: findUserHandshake,
  call: (port, token, tool, args) => callHelperEndpoint(port, token, tool, args),
  readFile: readText,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  randomKey: () => randomBytes(8).toString('hex'),
  version: typeof HYDRA_VERSION === 'string' ? HYDRA_VERSION : '0.0.0',
  stdout: text => process.stdout.write(`${text}\n`),
  stderr: text => process.stderr.write(`${text}\n`),
}).then(code => { process.exitCode = code; });

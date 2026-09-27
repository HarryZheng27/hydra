import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { alive as processAlive, findWindowFor } from './helperDiscovery';

/**
 * O8a: the user role's handshake (docs/Heads.md, "Scripts and CI"; docs/THREAT_MODEL.md,
 * HSEC-60 to HSEC-62). A script or CI job on this machine acts as you against the Hydra window
 * that owns its repository, with no prompt: it finds the window the same way a lead's bridge
 * does (the discovery record, src/core/helperDiscovery.ts), then reads that window's handshake
 * file for the port and the user token.
 *
 * - Hydra mints the token itself, once per window, and puts it only in this file. No endpoint
 *   route hands one out, and it dies with the window: tokens live only in the endpoint's memory.
 * - The file lives in Hydra's global storage, under `helpers/handshakes`, and on Windows its
 *   access list is cut to you alone with `icacls` (no inherited entries, nobody else) before the
 *   token is written into it. A reader refuses a file whose access list is anything else.
 * - A reader refuses a handshake whose owning Hydra process is gone (and removes it), or whose
 *   process or port doesn't match the live window it was looked up for.
 *
 * The parsing and checking below are plain functions; only the functions at the end touch the
 * disk or run `icacls`/`whoami`.
 */
export interface UserHandshake {
  version: 1; kind: 'hydra-user-handshake';
  /** The Hydra window's extension host: the process that owns the endpoint and the token. */
  pid: number;
  /** The endpoint's loopback port (127.0.0.1). */
  port: number;
  /** The user token, sent as `Authorization: Bearer <token>`. */
  token: string;
  /** The repository the window owns: its lead folder. */
  repository: string;
  writtenAt: string;
}
export type HandshakeResult = { ok: true; handshake: UserHandshake; file: string } | { ok: false; reason: string };

export const handshakeDirectory = (helpersRoot: string) => path.join(helpersRoot, 'handshakes');
/** One file per window: its extension host's pid and its endpoint's port, both from its discovery record. */
export const handshakeFileName = (pid: number, port: number) => `${pid}-${port}.json`;
/** A handshake is small; anything bigger isn't one. */
export const handshakeMaxBytes = 4096;
/** The same shape HelperEndpoint accepts as a bearer token. */
const tokenPattern = /^[A-Za-z0-9_-]{20,200}$/;
const handshakeKeys = ['version', 'kind', 'pid', 'port', 'token', 'repository', 'writtenAt'];

/** A handshake file's text, checked field by field; throws with the reason. Unknown keys are refused. */
export function parseHandshake(text: string): UserHandshake {
  if (text.length > handshakeMaxBytes) throw new Error('the handshake file is too large.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('the handshake file is not JSON.'); }
  const record = value as Partial<UserHandshake> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('the handshake file is not an object.');
  const extra = Object.keys(record).filter(key => !handshakeKeys.includes(key));
  if (extra.length) throw new Error(`the handshake file has unknown keys: ${extra.join(', ')}.`);
  if (record.version !== 1 || record.kind !== 'hydra-user-handshake') throw new Error('the handshake file is not a version 1 Hydra handshake.');
  if (!Number.isInteger(record.pid) || record.pid! <= 0) throw new Error('the handshake file has no valid pid.');
  if (!Number.isInteger(record.port) || record.port! < 1 || record.port! > 65535) throw new Error('the handshake file has no valid port.');
  if (typeof record.token !== 'string' || !tokenPattern.test(record.token)) throw new Error('the handshake file has no valid token.');
  if (typeof record.repository !== 'string' || !record.repository || record.repository.length > 1024 || record.repository.includes('\0')) throw new Error('the handshake file has no valid repository.');
  if (typeof record.writtenAt !== 'string' || Number.isNaN(Date.parse(record.writtenAt))) throw new Error('the handshake file has no valid time.');
  return { version: 1, kind: 'hydra-user-handshake', pid: record.pid!, port: record.port!, token: record.token, repository: record.repository, writtenAt: record.writtenAt };
}

/**
 * Why a parsed handshake can't be used for the window it was looked up for, or undefined when it
 * can. Stale: its owning process is gone. Mismatched: it names another process or port than the
 * live window's discovery record (a leftover from another window, or a file put there by hand).
 */
export function handshakeProblem(handshake: UserHandshake, window: { pid: number; port: number }, alive: (pid: number) => boolean): string | undefined {
  if (!alive(handshake.pid)) return 'it is stale: the Hydra window that wrote it has closed.';
  if (handshake.pid !== window.pid || handshake.port !== window.port) return 'it belongs to a different Hydra window than the one that owns this folder.';
  return undefined;
}

// ---- The access list (Windows) ----

/** One entry of `icacls <file>`'s listing. */
export interface AclEntry { principal: string; perms: string[]; inherited: boolean; deny: boolean }

/**
 * `icacls <file>`'s listing, one entry per access-control entry. icacls prints the path, then
 * the first entry on the same line and the rest indented below, then a blank line and a summary
 * (which is translated, so it is never read). Throws when the listing isn't that shape, so a
 * reader fails closed rather than trusting output it didn't understand.
 */
export function parseIcacls(output: string, file: string): AclEntry[] {
  const lines = output.replace(/\r/g, '').split('\n');
  const first = lines[0] ?? '';
  if (!first.toLowerCase().startsWith(file.toLowerCase())) throw new Error('icacls listed a different file.');
  const entries: AclEntry[] = [];
  const texts = [first.slice(file.length), ...lines.slice(1)];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) break;
    const match = /^(.+?):((?:\([^()]*\))+)$/.exec(text);
    if (!match) throw new Error(`icacls printed an entry Hydra doesn't understand: ${text.slice(0, 80)}`);
    const perms = [...match[2]!.matchAll(/\(([^()]*)\)/g)].map(part => part[1]!);
    entries.push({ principal: match[1]!, perms, inherited: perms.includes('I'), deny: perms.includes('DENY') });
  }
  if (!entries.length) throw new Error('icacls listed no access entries.');
  return entries;
}

/**
 * Owner-only: every entry that grants access is yours (by name or SID), none is inherited from
 * the folder, and at least one grants you access. Nothing else (not SYSTEM, not Administrators,
 * not Everyone) is allowed in; a deny entry grants nothing and is tolerated. Undefined when it is.
 */
export function aclProblem(entries: readonly AclEntry[], user: { name: string; sid: string }): string | undefined {
  const mine = (principal: string) => {
    const value = principal.toLowerCase();
    return value === user.name.toLowerCase() || value === user.sid.toLowerCase() || value === `*${user.sid.toLowerCase()}`;
  };
  const inherited = entries.find(entry => entry.inherited);
  if (inherited) return `it inherits access from its folder (${inherited.principal}).`;
  const other = entries.find(entry => !entry.deny && !mine(entry.principal));
  if (other) return `someone other than you has access to it (${other.principal}).`;
  if (!entries.some(entry => !entry.deny && mine(entry.principal))) return 'it grants you no access.';
  return undefined;
}

// ---- Disk, icacls and whoami: the effectful shell ----

const system32 = (exe: string) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
/**
 * icacls and whoami print in the console's code page. Both are read byte for byte (latin1), so a
 * name with non-ASCII letters reads the same way from each and still compares equal.
 */
function run(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(system32(exe), args, { encoding: 'latin1', windowsHide: true, timeout: 15_000 }, (error, stdout) => error ? reject(new Error(`${exe} failed: ${error.message}`)) : resolve(stdout));
  });
}

/** The current Windows user's account name and SID, from `whoami /user`. */
export async function currentWindowsUser(): Promise<{ name: string; sid: string }> {
  const output = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const match = /^"([^"]+)","(S-1-5-(?:\d+-)*\d+)"/m.exec(output.trim());
  if (!match) throw new Error('could not read the current Windows user.');
  return { name: match[1]!, sid: match[2]! };
}

/** Cut a file's access list to the current user alone: no inherited entries, full control for you, nobody else. */
export async function restrictToOwner(file: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const user = await currentWindowsUser();
  await run('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${user.sid}:F`]);
}

/** Why a file's access isn't owner-only, or undefined when it is. On Windows, from `icacls`; elsewhere, from its mode and owner. */
export async function ownerOnlyProblem(file: string): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    const info = await lstat(file);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return 'it is owned by another user.';
    return (info.mode & 0o077) !== 0 ? 'others can read or write it.' : undefined;
  }
  try {
    const [user, listing] = await Promise.all([currentWindowsUser(), run('icacls.exe', [file])]);
    return aclProblem(parseIcacls(listing, file), user);
  } catch (error) {
    return `its access list couldn't be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Write this window's handshake. The file is created empty, cut to owner-only and checked before
 * the token goes in, then moved into place (a move keeps its access list), so the token is never
 * on disk with wider access. Throws, leaving no file, if the access list can't be made owner-only.
 */
export async function writeUserHandshake(helpersRoot: string, input: { pid: number; port: number; token: string; repository: string }, now = () => new Date()): Promise<string> {
  const directory = handshakeDirectory(helpersRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, handshakeFileName(input.pid, input.port));
  const body: UserHandshake = { version: 1, kind: 'hydra-user-handshake', pid: input.pid, port: input.port, token: input.token, repository: input.repository, writtenAt: now().toISOString() };
  const text = JSON.stringify(body);
  parseHandshake(text);
  const temporary = path.join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    await restrictToOwner(temporary);
    const before = await ownerOnlyProblem(temporary);
    if (before) throw new Error(`Hydra couldn't make the handshake file private: ${before}`);
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const after = await ownerOnlyProblem(file);
  if (after) { await rm(file, { force: true }).catch(() => undefined); throw new Error(`Hydra couldn't make the handshake file private: ${after}`); }
  return file;
}

export async function removeUserHandshake(file: string): Promise<void> { await rm(file, { force: true }); }

/**
 * Read and check one handshake file, for the window (`pid`, `port`) it was looked up for. In
 * order: it must be a plain small file (no link), owner-only, well formed, and belong to a live
 * process that is that window. A stale one (its process gone) is removed.
 */
export async function readUserHandshake(file: string, window: { pid: number; port: number }, options: { alive?: (pid: number) => boolean; ownerOnly?: (file: string) => Promise<string | undefined> } = {}): Promise<HandshakeResult> {
  const refuse = (reason: string): HandshakeResult => ({ ok: false, reason: `Hydra refused the handshake file: ${reason}` });
  let info;
  try { info = await lstat(file); } catch { return { ok: false, reason: 'This Hydra window has no handshake file yet.' }; }
  if (!info.isFile()) return refuse('it is not a plain file.');
  if (info.size > handshakeMaxBytes) return refuse('it is too large.');
  const acl = await (options.ownerOnly ?? ownerOnlyProblem)(file);
  if (acl) return refuse(acl);
  let handshake: UserHandshake;
  try { handshake = parseHandshake(await readFile(file, 'utf8')); } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
  const alive = options.alive ?? processAlive;
  const problem = handshakeProblem(handshake, window, alive);
  if (problem) {
    if (!alive(handshake.pid)) await rm(file, { force: true }).catch(() => undefined);
    return refuse(problem);
  }
  return { ok: true, handshake, file };
}

/**
 * The handshake for the Hydra window that owns `cwd`: the live window whose folder contains it
 * (the deepest wins; one window per repository), found through the same discovery records a lead's
 * bridge uses. This is what a `hydra` command calls first.
 */
export async function findUserHandshake(helpersRoot: string, cwd: string, options: Parameters<typeof readUserHandshake>[2] = {}): Promise<HandshakeResult> {
  const window = await findWindowFor(helpersRoot, cwd);
  if (!window) return { ok: false, reason: 'No open Hydra window owns this folder.' };
  return readUserHandshake(path.join(handshakeDirectory(helpersRoot), handshakeFileName(window.pid, window.port)), window, options);
}

/** Remove handshake files whose owning process is gone (a window that crashed never removed its own). */
export async function sweepStaleHandshakes(helpersRoot: string, alive: (pid: number) => boolean = processAlive): Promise<number> {
  const directory = handshakeDirectory(helpersRoot);
  let names: string[];
  try { names = await readdir(directory); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const match = /^(\d+)-\d+\.json$/.exec(name);
    if (!match || alive(Number(match[1]))) continue;
    await rm(path.join(directory, name), { force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

import { link, lstat, mkdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Provider } from './model';
import { claudeIsolationVariables, codexCarry, codexIsolationArguments, envValue, type CodexCarry } from './confine';
import { userClaudePlugins } from './confineFiles';

/**
 * Heads and reviewers run with your sign-in only (HSEC-70): none of your own instructions,
 * memories, plugins, hooks or MCP servers. Hydra's own lead entry in your Codex config.toml is one
 * of those servers, and a head or reviewer that loaded it could start heads of its own.
 *
 * Codex keeps all of that in its home folder (CODEX_HOME, `~/.codex`), so a Codex head or reviewer
 * gets Hydra's own home, `<Hydra storage>/codex-home`, holding only:
 * - `auth.json`, a hard link to yours. Codex 0.157.1 rewrites auth.json in place when it refreshes
 *   a token (checked with a hard-linked file), so both names stay one file: a refresh in either
 *   home is seen by the other, and your sign-in never goes stale. A copy would split them, and
 *   the first refresh in one would log the other out. The link is checked, and remade, before
 *   every launch, so signing in again (a new file) is picked up.
 * - `.sandbox` and `.sandbox-secrets`, junctions to yours: the Windows sandbox you set up. Without
 *   them Codex would set up its elevated sandbox again, which needs an administrator.
 * Everything else Codex writes there itself (its sessions, logs and caches). Hydra's flags
 * (codexIsolationArguments) keep your config.toml out as well.
 *
 * When the home can't be made (no auth.json, because you sign in with an API key or a keyring, or
 * a hard link that fails, say across drives), Codex runs with your own home and the same flags:
 * no config.toml, but your AGENTS.md and skills folder still load. The note says so.
 */
export interface AgentIsolation {
  /** Variables set on top of the process's environment: Claude's two switches, or Codex's CODEX_HOME. */
  env: Record<string, string>;
  /** Codex: flags placed right after `exec` (or `exec resume`). */
  codexArgs: string[];
  /** Claude: your plugins, each turned off in the reviewer's settings file. */
  claudePlugins: string[];
  /** Why Codex runs with your own home, when it does. */
  note?: string;
}

export const codexHomeFolder = 'codex-home';

/** Your Codex home: CODEX_HOME, or `~/.codex`. */
export const userCodexHome = (env: Readonly<Record<string, string | undefined>>): string => envValue(env, 'CODEX_HOME')?.trim() || path.join(homedir(), '.codex');

/** Whether two paths are the same file (a hard link), by device and inode. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return first.ino === second.ino && first.dev === second.dev;
  } catch { return false; }
}

/**
 * Makes (or checks) Hydra's own Codex home under `storage` and says what a Codex head or reviewer
 * runs with. Never writes to your own home: it only links to it.
 */
export async function prepareCodexHome(storage: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ home?: string; carry: CodexCarry; note?: string }> {
  const user = userCodexHome(env);
  const carry = codexCarry(await readFile(path.join(user, 'config.toml'), 'utf8').catch(() => undefined));
  const home = path.join(storage, codexHomeFolder);
  if (path.resolve(home).toLowerCase() === path.resolve(user).toLowerCase()) return { carry, note: 'Hydra\'s Codex home is your own' };
  const auth = path.join(user, 'auth.json'), own = path.join(home, 'auth.json');
  try {
    await stat(auth);
  } catch {
    return { carry, note: 'your Codex sign-in isn\'t in an auth.json Hydra can link to' };
  }
  try {
    await mkdir(home, { recursive: true });
    if (!await sameFile(auth, own)) {
      // A new name, then a rename over the old one: another window checking at the same moment never sees no auth.json.
      const temporary = path.join(home, `auth.json.${randomBytes(4).toString('hex')}.link`);
      await link(auth, temporary);
      try { await rename(temporary, own); } catch (error) { await rm(temporary, { force: true }); throw error; }
      if (!await sameFile(auth, own)) throw new Error('the link didn\'t hold');
    }
  } catch (error) {
    return { carry, note: `Hydra couldn't link your Codex sign-in into its own Codex home (${error instanceof Error ? error.message : String(error)})` };
  }
  for (const folder of ['.sandbox', '.sandbox-secrets']) {
    const target = path.join(user, folder), junction = path.join(home, folder);
    if (!await stat(target).then(found => found.isDirectory(), () => false)) continue;
    if (await lstat(junction).then(() => true, () => false)) continue;
    await symlink(target, junction, 'junction').catch(() => undefined);
  }
  return { home, carry };
}

/** What a head or reviewer of `provider` runs with. `storage` is Hydra's storage folder; without it, Codex uses your home with Hydra's flags. */
export async function agentIsolation(provider: Provider, storage: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): Promise<AgentIsolation> {
  if (provider === 'claude') return { env: { ...claudeIsolationVariables }, codexArgs: [], claudePlugins: await userClaudePlugins(env) };
  const prepared = storage ? await prepareCodexHome(storage, env) : { carry: codexCarry(await readFile(path.join(userCodexHome(env), 'config.toml'), 'utf8').catch(() => undefined)), note: 'this Hydra window has no storage folder for its own Codex home' };
  return { env: prepared.home ? { CODEX_HOME: prepared.home } : {}, codexArgs: codexIsolationArguments(prepared.carry), claudePlugins: [], ...(prepared.note ? { note: prepared.note } : {}) };
}

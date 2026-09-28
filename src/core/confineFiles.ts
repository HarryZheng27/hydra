import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { git } from './git';
import { envValue, userPluginIds, type StorageListing } from './confine';

/**
 * What the confinement builders in confine.ts read from disk and git
 * (Step 2): kept apart so confine.ts stays pure.
 */

/**
 * The entries of Hydra's storage folder and of each folder on the way down to the kept paths, for
 * storageReadDeny. A folder that can't be read is left out of the listing, and storageReadDeny then
 * denies the whole storage folder: safe, if it hides a role's files.
 */
export async function storageListing(storage: string, keep: readonly string[]): Promise<StorageListing> {
  const listing = new Map<string, { name: string; dir: boolean }[]>();
  const folders = new Set<string>();
  for (const item of keep) {
    const relative = path.relative(storage, item);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let folder = storage;
    for (const part of relative.split(path.sep).slice(0, -1)) { folders.add(folder); folder = path.join(folder, part); }
    folders.add(folder);
  }
  for (const folder of folders) {
    try { listing.set(folder, (await readdir(folder, { withFileTypes: true })).map(entry => ({ name: entry.name, dir: entry.isDirectory() || entry.isSymbolicLink() }))); }
    catch { /* left out: storageReadDeny falls back to the whole folder */ }
  }
  return listing;
}

/**
 * Every worktree of the lead's repository but `own`, `repository` and the main checkout (for a head,
 * the lead's `.hydra` and `.git` are denied on their own): other heads' and lanes' worktrees, from
 * `git worktree list`. Worktrees made after this runs aren't in it; for a head, the read block covers them.
 */
export async function otherWorktrees(repository: string, own: string): Promise<string[]> {
  const listed = (await git(repository, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)
    .filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice('worktree '.length)));
  const key = (value: string) => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const skip = new Set([key(own), key(repository), ...(listed[0] ? [key(listed[0])] : [])]);
  return listed.filter(item => !skip.has(key(item)));
}

/**
 * Your Claude plugins, for headSettings to turn off: `enabledPlugins` in your user settings and
 * everything in `plugins/installed_plugins.json`, under CLAUDE_CONFIG_DIR or `~/.claude`, where the
 * head's Claude Code finds them. A file that can't be read adds none.
 */
export async function userClaudePlugins(env: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  const folder = envValue(env, 'CLAUDE_CONFIG_DIR') || path.join(homedir(), '.claude');
  const read = (file: string) => readFile(file, 'utf8').catch(() => undefined);
  return userPluginIds(await read(path.join(folder, 'settings.json')), await read(path.join(folder, 'plugins', 'installed_plugins.json')));
}

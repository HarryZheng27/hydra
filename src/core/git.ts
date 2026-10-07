import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
/**
 * Every call also passes `-c core.fsmonitor=false` (1.4): worktrees
 * of one repository share a single `.git`, so a head or a lane could set `core.fsmonitor` in it to
 * a command of its choosing. Without this override that command would run the next time Hydra (or
 * the user) runs git anywhere in the repository, including the main checkout. `core.quotepath=false`
 * is unrelated (it keeps non-ASCII paths readable); both are passed on every call from this module.
 */
const gitFlags = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];

/**
 * `git()`/`gitBytes()`/`gitRun()` default to no timeout (`timeoutMs = 0`, which disables Node's
 * `execFile` timeout entirely), on purpose: killing git mid-command can leave `index.lock` behind
 * (a sandboxed head can't remove it from its own worktree's gitdir, so every later `hydra_done`
 * would fail), abort a merge without its `MERGE_HEAD`/conflict markers cleaned up, or cut off a
 * `pre-commit`/`post-checkout` hook the user or the project relies on running to completion. A hang
 * is a known, visible problem (Heads.md's step timing names the slow step); a kill mid-write is a
 * worse, hidden one.
 *
 * Pass `readOnlyGitTimeoutMs` explicitly only for a call that is genuinely read-only and takes no
 * lock: `status --porcelain`, `rev-parse`, `diff --name-only` (and other read-only `diff`/`status`
 * flavors), `ls-tree`, `merge-tree` (it writes loose objects but never touches the index or HEAD),
 * and a read-only `config --list`. Never add a timeout to anything that commits, merges, checks
 * out, adds or removes a worktree, or can run a hook.
 */
export const readOnlyGitTimeoutMs = 300_000;
/**
 * `git status` refreshes and rewrites the index when it can, taking index.lock to do so; with this flag first it only
 * reads, so a timed-out status can't leave a stale lock behind.
 */
export const readOnlyStatus = ['--no-optional-locks', 'status'] as const;
const killOptions = { killSignal: 'SIGKILL' as const };

/** The git subcommand `args` starts with, for naming it in an error — skips `noHooks`'s leading `-c core.hooksPath=…` pairs and global flags such as `--no-optional-locks`, so the error names the real subcommand. */
function commandName(args: readonly string[]): string {
  let index = 0;
  while (index < args.length && (args[index] === '-c' || args[index]!.startsWith('--'))) index += args[index] === '-c' ? 2 : 1;
  return args[index] ?? '';
}

function timeoutError(args: readonly string[], timeoutMs: number): Error {
  return new Error(`git ${commandName(args)} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`);
}

export async function gitBytes(cwd: string, args: string[], environment?: NodeJS.ProcessEnv, timeoutMs = 0): Promise<Buffer> {
  try {
    const { stdout } = await execute('git', [...gitFlags, ...args], { cwd, env: { ...process.env, ...environment }, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, ...killOptions });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer; killed?: boolean };
    if (failure.killed) throw timeoutError(args, timeoutMs);
    throw new Error(failure.stderr?.toString('utf8').trim() || failure.message);
  }
}
export async function git(cwd: string, args: string[], environment?: NodeJS.ProcessEnv, timeoutMs = 0): Promise<string> { return (await gitBytes(cwd, args, environment, timeoutMs)).toString('utf8'); }
export interface GitResult { code: number; stdout: string; stderr: string }
/**
 * Run git and hand back its exit code and output instead of throwing on a
 * non-zero exit: `merge-tree` and `merge` report conflicts that way. Throws only
 * when git can't run or runs past `timeoutMs`.
 */
export function gitRun(cwd: string, args: string[], environment?: NodeJS.ProcessEnv, timeoutMs = 0): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', [...gitFlags, ...args], { cwd, env: { ...process.env, ...environment }, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, ...killOptions }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: unknown }) | null)?.code;
      if (error && typeof code !== 'number') return reject((error as Error & { killed?: boolean }).killed ? timeoutError(args, timeoutMs) : new Error(stderr.trim() || error.message));
      resolve({ code: error ? code as number : 0, stdout, stderr });
    });
  });
}

/**
 * A fingerprint of the git metadata a worktree shares with every other worktree of the same
 * repository (1.4): the settings in `config` and `config.worktree`
 * that run a program, load more config or redirect git (riskyConfigKey), `info/attributes` (if
 * present) and every file under `hooks/` except `*.sample`, each hashed by name so a change can
 * be named. A head that edits `.git/config` or `.git/hooks/*` runs code the
 * next time Hydra or the user runs git anywhere in the repository, including the main checkout;
 * comparing this fingerprint at `hydra_done` and at a lane's Merge (or Mark job done) catches it.
 * Only present files are included, so a missing file never shows up as a spurious change.
 */
export type GitMetaFingerprint = Readonly<Record<string, string>>;

export async function commonGitDir(repository: string): Promise<string> {
  const raw = (await git(repository, ['rev-parse', '--git-common-dir'], undefined, readOnlyGitTimeoutMs)).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repository, raw);
}

/**
 * Config settings that make git run a program, load more config, or send work somewhere else.
 * Only these are fingerprinted: everyday git (a push that records branch tracking, a new remote,
 * `gh pr checkout`) rewrites the rest of `.git/config`, and must not look like tampering.
 * Keys are as `git config --list` prints them: section and key lowercased, subsections as written.
 */
const riskyConfigKey = new RegExp([
  String.raw`^core\.(fsmonitor|hookspath|sshcommand|gitproxy|askpass|pager|editor|attributesfile|worktree)$`,
  String.raw`^sequence\.editor$`,
  String.raw`^diff\.external$`, String.raw`^diff\..+\.(command|textconv)$`, String.raw`^difftool\..+\.(cmd|path)$`,
  String.raw`^merge\..+\.driver$`, String.raw`^mergetool\..+\.(cmd|path)$`,
  String.raw`^filter\..+\.(clean|smudge|process)$`,
  String.raw`^credential(\..+)?\.helper$`, String.raw`^gpg(\..+)?\.program$`,
  String.raw`^include\.path$`, String.raw`^includeif\..+\.path$`,
  String.raw`^alias\..+$`,
  String.raw`^url\..+\.(insteadof|pushinsteadof)$`,
  String.raw`^remote\..+\.(pushurl|receivepack|uploadpack|proxy)$`,
  String.raw`^uploadpack\.packobjectshook$`, String.raw`^extensions\.worktreeconfig$`,
].join('|'), 'i');

/** The risky settings in one config file, as `config:<key>` → hash of its values (a key may repeat). */
async function riskyConfig(file: string, into: Record<string, string>, label: string): Promise<void> {
  // `git config --file` reads only that file (no includes), and never runs a hook or fsmonitor.
  const listed = await gitRun(path.dirname(file), ['config', '--file', file, '--list', '--null'], undefined, readOnlyGitTimeoutMs).catch(() => undefined);
  if (!listed || listed.code !== 0) return;
  const values = new Map<string, string[]>();
  for (const entry of listed.stdout.split('\0').filter(Boolean)) {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline), value = newline < 0 ? '' : entry.slice(newline + 1);
    if (!riskyConfigKey.test(key)) continue;
    values.set(key.toLowerCase(), [...values.get(key.toLowerCase()) ?? [], value]);
  }
  for (const [key, list] of values) into[`${label} (${key.slice(0, 200)})`] =createHash('sha256').update(JSON.stringify(list)).digest('hex');
}

export async function gitMetaFingerprint(repository: string): Promise<GitMetaFingerprint> {
  const dir = await commonGitDir(repository);
  const fingerprint: Record<string, string> = {};
  const hashFile = async (relative: string, absolute: string): Promise<void> => {
    let data: Buffer;
    try { data = await readFile(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    fingerprint[relative] = createHash('sha256').update(data).digest('hex');
  };
  await riskyConfig(path.join(dir, 'config'), fingerprint, 'config');
  await riskyConfig(path.join(dir, 'config.worktree'), fingerprint, 'config.worktree');
  await hashFile('info/attributes', path.join(dir, 'info', 'attributes'));
  let hooks: string[] = [];
  try { hooks = (await readdir(path.join(dir, 'hooks'))).filter(name => !name.endsWith('.sample')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of hooks) await hashFile(`hooks/${name}`, path.join(dir, 'hooks', name));
  // Bounded, so a repository with many aliases or hooks still fits a job or lane record: past the
  // cap, the rest share one entry, which still changes when any of them does.
  const names = Object.keys(fingerprint).sort();
  if (names.length <= gitMetaMaxEntries) return fingerprint;
  const kept: Record<string, string> = {};
  for (const name of names.slice(0, gitMetaMaxEntries - 1)) kept[name] = fingerprint[name]!;
  kept['(other settings and hooks)'] = createHash('sha256').update(JSON.stringify(names.slice(gitMetaMaxEntries - 1).map(name => [name, fingerprint[name]]))).digest('hex');
  return kept;
}
/** At most this many entries in a fingerprint (see gitMetaFingerprint); job and lane records accept this many. */
export const gitMetaMaxEntries = 64;

/** The files that differ between two fingerprints (added, removed or changed contents), sorted by name. Empty means nothing changed. */
export function gitMetaChanges(before: GitMetaFingerprint, after: GitMetaFingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(name => before[name] !== after[name]).sort();
}

/**
 * Why a head's worktree can't be trusted to run git in, or undefined when it can (HSEC-09). A linked worktree's
 * `.git` is a one-line file, `gitdir: <the repository's .git>/worktrees/<name>`, that tells git where its
 * metadata is. A head that rewrote it could point git at a repository of its own making, whose config runs a
 * command (a filter, a diff driver) the next time Hydra runs git there, unsandboxed and as you. So before
 * Hydra's own git calls in a head's worktree, `.git` must still be a plain file pointing straight into the main
 * checkout's `.git/worktrees/`, which heads can't write. `commonDir` is the main checkout's common git dir.
 */
export async function worktreeGitPointerProblem(worktree: string, commonDir: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const found = await worktreeGitDir(worktree, commonDir, platform);
  return 'problem' in found ? found.problem : undefined;
}

/**
 * The worktree's own metadata folder, `<commonDir>/worktrees/<name>`, once its `.git` file passes the check above, or
 * why it doesn't. The folder is built from `commonDir`, not taken from the file, so what Hydra passes to git is a path
 * under the main checkout's `.git`, which heads can't write.
 */
export async function worktreeGitDir(worktree: string, commonDir: string, platform: NodeJS.Platform = process.platform): Promise<{ dir: string } | { problem: string }> {
  const file = path.join(worktree, '.git');
  const stat = await lstat(file).catch(() => undefined);
  if (!stat) return { problem: 'its .git file is missing' };
  if (!stat.isFile()) return { problem: 'its .git is no longer the plain file git made for the worktree' };
  const text = (await readFile(file, 'utf8').catch(() => '')).trim();
  const match = /^gitdir: (.+)$/.exec(text);
  if (!match || text.includes('\n')) return { problem: 'its .git file no longer says where the worktree\'s metadata is' };
  const target = path.resolve(worktree, match[1]!.trim());
  const key = (value: string) => { const resolved = path.resolve(value); return platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const parent = path.dirname(target);
  if (key(parent) !== key(path.join(commonDir, 'worktrees')) || !path.basename(target)) return { problem: 'its .git file points outside the repository\'s own worktree metadata' };
  // The folder must be this worktree's own: git's `gitdir` file in it names the worktree's .git. Pointing at another
  // head's folder would otherwise pass, and commit this worktree's files onto that head's branch.
  const dir = path.join(commonDir, 'worktrees', path.basename(target));
  const back = (await readFile(path.join(dir, 'gitdir'), 'utf8').catch(() => '')).trim();
  if (!back || key(path.resolve(dir, back)) !== key(file)) return { problem: 'its .git file points at metadata that belongs to another worktree' };
  return { dir };
}

/**
 * The environment that pins git to a head worktree's checked metadata (HSEC-09): with GIT_DIR and GIT_WORK_TREE set,
 * git never reads the worktree's `.git` file, so a head that rewrites it after the check (a background command, say)
 * can't send Hydra's later git calls to a repository of its making.
 */
export const pinnedWorktreeGit = (worktree: string, gitDir: string): NodeJS.ProcessEnv => ({
  GIT_DIR: gitDir, GIT_WORK_TREE: worktree,
  // Anything in Hydra's own environment that would move git elsewhere or add config is cleared (undefined drops it).
  GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined, GIT_CONFIG: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
});

import { spawn } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitRun, readOnlyGitTimeoutMs } from '../../../src/core/git';
import { cmdUnsafe, isWindowsShim, processLaunch } from '../../../src/core/process';
import { findProvider } from '../../../src/core/providers';

/**
 * The review pane (G4 milestone 5): the chat folder's working tree against HEAD, read-only. Every git call only reads,
 * and none can run a program the repository names: core's flags turn off `core.fsmonitor`; these add `--no-ext-diff`,
 * `--no-textconv` and `--ignore-submodules`, empty every clean, smudge and process filter the config sets (git would
 * run a clean filter to hash a changed file), never fetch a missing object (a partial clone's lazy fetch runs the
 * remote's upload-pack, SSH command or credential helper), take paths literally, read old content with `cat-file`, and
 * drop the user's `GIT_*` environment. The diff covers only the chat folder, in a repository whose root is that folder or above it. Each file
 * is read through one handle, after its real path is checked to be inside the folder, and capped in size; big or
 * binary files are listed without their content, and the whole review has a byte budget.
 */
export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'untracked' | 'changed';
  original: string;
  modified: string;
  /** Not shown: binary, too big, or outside the folder. */
  skipped?: string;
}
export interface ReviewResult { files: ReviewFile[]; truncated: boolean; error?: string }

export const MAX_REVIEW_FILES = 300;
export const MAX_REVIEW_BYTES = 1024 * 1024;
/** All the text one review sends to the page. */
export const MAX_REVIEW_TOTAL = 16 * 1024 * 1024;

const statusNames: Record<string, ReviewFile['status']> = { A: 'added', M: 'modified', D: 'deleted', T: 'changed' };

/** The user's own GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*) would point the review elsewhere. */
function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) if (/^GIT_/i.test(key)) environment[key] = undefined;
  return { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' };
}

async function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // --no-lazy-fetch also makes a git too old to know it fail rather than fetch.
  return gitRun(cwd, ['--no-lazy-fetch', ...args], cleanEnvironment(), readOnlyGitTimeoutMs);
}

/** `-c` overrides that empty every filter the config defines, or undefined when one can't be overridden. */
async function filterOverrides(cwd: string): Promise<string[] | undefined> {
  const listed = await run(cwd, ['config', '--list', '--null']);
  if (listed.code !== 0) return undefined;
  const names = new Set<string>();
  for (const entry of listed.stdout.split('\u0000')) {
    const key = entry.split('\n', 1)[0]!;
    const match = /^filter\.(.*)\.[^.]+$/i.exec(key); // `[filter ""]` is a filter too: `filter=` picks it
    if (match) names.add(match[1]!);
  }
  const overrides: string[] = [];
  for (const name of names) {
    if (name.includes('=')) return undefined;
    for (const setting of ['clean', 'smudge', 'process']) overrides.push('-c', `filter.${name}.${setting}=`);
    overrides.push('-c', `filter.${name}.required=false`);
  }
  return overrides;
}

const binary = (text: string) => text.slice(0, 8000).includes('\u0000');
const within = (base: string, full: string) => {
  const relative = path.relative(base.toLowerCase(), full.toLowerCase());
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** A file's working-tree text, if its real path is inside the folder and it is small enough to show. */
async function workingText(folder: string, root: string, relative: string): Promise<{ text: string; skipped?: string }> {
  const real = await realpath(path.resolve(root, relative)).catch(() => undefined);
  if (!real) return { text: '' };
  if (!within(folder, real)) return { text: '', skipped: 'a link that leads outside the folder' };
  const handle = await open(real, 'r').catch(() => undefined);
  if (!handle) return { text: '' };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { text: '' };
    if (info.size > MAX_REVIEW_BYTES) return { text: '', skipped: 'over 1 MB' };
    const buffer = Buffer.alloc(MAX_REVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REVIEW_BYTES) return { text: '', skipped: 'over 1 MB' };
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return binary(text) ? { text: '', skipped: 'binary' } : { text };
  } finally { await handle.close(); }
}

async function headText(cwd: string, relative: string): Promise<{ text: string; skipped?: string }> {
  const size = await run(cwd, ['cat-file', '-s', `HEAD:${relative}`]);
  if (size.code !== 0) return { text: '' };
  if (Number(size.stdout.trim()) > MAX_REVIEW_BYTES) return { text: '', skipped: 'over 1 MB' };
  const blob = await run(cwd, ['cat-file', 'blob', `HEAD:${relative}`]);
  if (blob.code !== 0) return { text: '' };
  return binary(blob.stdout) ? { text: '', skipped: 'binary' } : { text: blob.stdout };
}

interface Changes { folder: string; root: string; head: boolean; entries: Array<{ path: string; status: ReviewFile['status'] }>; error?: string }

/** The folder's changed and untracked files (paths relative to the repository's root), without their content. */
async function listChanges(cwd: string): Promise<Changes> {
  const folder = await realpath(cwd).catch(() => path.resolve(cwd));
  const none = (error: string): Changes => ({ folder, root: folder, head: false, entries: [], error });
  const inside = await run(folder, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return none(/dubious ownership/i.test(inside.stderr)
      ? 'Git doesn\'t trust this folder\'s owner (safe.directory), so there is no diff to show.'
      : 'This folder isn\'t a git repository, so there is no diff to show.');
  }
  const top = (await run(folder, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const root = top ? await realpath(top).catch(() => '') : '';
  // core.worktree can point the work tree anywhere; only the folder itself or a folder above it is reviewed.
  if (!root || !(root.toLowerCase() === folder.toLowerCase() || within(root, folder))) return none('This folder\'s git work tree is somewhere else, so Hydra won\'t show it.');
  // git runs from the folder itself (with core.worktree, the work tree's root may have no .git) on the pathspec `.`;
  // every path it gives back is relative to the root.
  const overrides = await filterOverrides(folder);
  if (!overrides) return none('Hydra couldn\'t read this repository\'s filters, or one can\'t be switched off, so it won\'t run git on it.');
  const head = (await run(folder, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  const flags = ['--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules'];
  const changed = await run(folder, [...overrides, 'diff', ...(head ? ['HEAD'] : ['--cached']), ...flags, '--', '.']);
  const untracked = await run(folder, [...overrides, 'ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.']);
  const failed = changed.code !== 0 ? changed : untracked.code !== 0 ? untracked : undefined;
  if (failed) return none(`git couldn't list this folder's changes: ${failed.stderr.trim().split(/\r?\n/).pop() ?? ''}`);
  const entries: Changes['entries'] = [];
  const parts = changed.stdout.split('\u0000').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ status: statusNames[parts[i]![0]!] ?? 'changed', path: parts[i + 1]! });
  for (const file of untracked.stdout.split('\u0000').filter(Boolean)) entries.push({ status: 'untracked', path: file });
  return { folder, root, head, entries };
}

/** The names Open in editor may take: the folder's current changes. */
export async function changedPaths(cwd: string): Promise<string[]> {
  return (await listChanges(cwd)).entries.slice(0, MAX_REVIEW_FILES).map(entry => entry.path);
}

export async function workingTreeDiff(cwd: string): Promise<ReviewResult> {
  const { folder, root, head, entries, error } = await listChanges(cwd);
  if (error) return { files: [], truncated: false, error };
  let truncated = entries.length > MAX_REVIEW_FILES;
  let budget = MAX_REVIEW_TOTAL;
  const files: ReviewFile[] = [];
  for (const entry of entries.slice(0, MAX_REVIEW_FILES)) {
    if (budget <= 0) { truncated = true; files.push({ path: entry.path, status: entry.status, original: '', modified: '', skipped: 'over the review\'s size budget' }); continue; }
    const before = entry.status === 'added' || entry.status === 'untracked' || !head ? { text: '' } : await headText(folder, entry.path);
    const after = entry.status === 'deleted' ? { text: '' } : await workingText(folder, root, entry.path);
    const skipped = before.skipped ?? after.skipped;
    if (!skipped) budget -= before.text.length + after.text.length;
    files.push({ path: entry.path, status: entry.status, original: skipped ? '' : before.text, modified: skipped ? '' : after.text, ...(skipped ? { skipped } : {}) });
  }
  return { files, truncated };
}

/**
 * Open in editor: the file in Hydra IDE or VS Code when either's command is on PATH; otherwise it is only shown in its
 * folder. Never the file's default action: on Windows that runs .js, .bat and .ps1 files rather than opening them. An
 * editor reached through a .cmd launcher gets the file only when cmd.exe can't read its name as commands (`&`, `%`).
 */
export async function openInEditor(cwd: string, relative: string, reveal: (file: string) => void): Promise<'editor' | 'folder'> {
  const { folder, root, error } = await listChanges(cwd);
  if (error) throw new Error(error);
  const full = await realpath(path.resolve(root, relative)).catch(() => path.resolve(root, relative));
  if (!within(folder, full)) throw new Error('That file isn\'t in this folder.');
  for (const editor of ['hydra', 'code'] as const) {
    const found = await findProvider(editor as never).catch(() => undefined);
    if (!found?.available || !found.executable) continue;
    if (isWindowsShim(found.executable) && cmdUnsafe.test(full)) break;
    const launch = processLaunch(found.executable, ['--goto', full]);
    const child = spawn(launch.executable, launch.args, { cwd: folder, windowsHide: true, stdio: 'ignore', detached: false });
    child.on('error', () => undefined);
    child.unref();
    return 'editor';
  }
  reveal(full);
  return 'folder';
}

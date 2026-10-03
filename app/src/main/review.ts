import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitRun, readOnlyGitTimeoutMs } from '../../../src/core/git';
import { processLaunch } from '../../../src/core/process';
import { findProvider } from '../../../src/core/providers';

/**
 * The review pane (G4 milestone 5): the chat folder's working tree against HEAD, read-only. Every git call only reads:
 * core's flags turn off `core.fsmonitor`, and these add `--no-ext-diff` and `--no-textconv` and read old content with
 * `cat-file`, so a project's own git config can't make the diff run a program. Files are read only from inside the
 * folder (a link that leads out is refused), and big or binary files are listed without their content.
 */
export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'changed';
  original: string;
  modified: string;
  /** Not shown: binary, too big, or outside the folder. */
  skipped?: string;
}
export interface ReviewResult { files: ReviewFile[]; truncated: boolean; error?: string }

export const MAX_REVIEW_FILES = 300;
export const MAX_REVIEW_BYTES = 1024 * 1024;

const statusNames: Record<string, ReviewFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'changed', C: 'added' };

async function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return gitRun(cwd, args, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, readOnlyGitTimeoutMs);
}

const binary = (text: string) => text.slice(0, 8000).includes('\u0000');

/** A file's working-tree text, if it sits inside the folder and is small enough to show. */
async function workingText(root: string, relative: string): Promise<{ text: string; skipped?: string }> {
  const full = path.resolve(root, relative);
  const base = path.resolve(root);
  if (!full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return { text: '', skipped: 'outside the folder' };
  let info;
  try { info = await lstat(full); } catch { return { text: '' }; }
  if (info.isSymbolicLink()) {
    const target = await realpath(full).catch(() => '');
    const realBase = await realpath(base).catch(() => base);
    if (!target.toLowerCase().startsWith(realBase.toLowerCase() + path.sep)) return { text: '', skipped: 'a link that leads outside the folder' };
  }
  if (info.size > MAX_REVIEW_BYTES) return { text: '', skipped: 'over 1 MB' };
  const text = await readFile(full, 'utf8').catch(() => '');
  return binary(text) ? { text: '', skipped: 'binary' } : { text };
}

async function headText(cwd: string, relative: string): Promise<{ text: string; skipped?: string }> {
  const size = await run(cwd, ['cat-file', '-s', `HEAD:${relative}`]);
  if (size.code !== 0) return { text: '' };
  if (Number(size.stdout.trim()) > MAX_REVIEW_BYTES) return { text: '', skipped: 'over 1 MB' };
  const blob = await run(cwd, ['cat-file', 'blob', `HEAD:${relative}`]);
  if (blob.code !== 0) return { text: '' };
  return binary(blob.stdout) ? { text: '', skipped: 'binary' } : { text: blob.stdout };
}

export async function workingTreeDiff(cwd: string): Promise<ReviewResult> {
  const inside = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { files: [], truncated: false, error: 'This folder isn\'t a git repository, so there is no diff to show.' };
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim() || cwd;
  const head = (await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  const changed = head
    ? await run(root, ['diff', 'HEAD', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--'])
    : await run(root, ['diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--']);
  const untracked = await run(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const entries: Array<{ path: string; status: ReviewFile['status'] }> = [];
  const parts = changed.stdout.split('\u0000').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ status: statusNames[parts[i]![0]!] ?? 'changed', path: parts[i + 1]! });
  for (const file of untracked.stdout.split('\u0000').filter(Boolean)) entries.push({ status: 'untracked', path: file });
  const truncated = entries.length > MAX_REVIEW_FILES;
  const files: ReviewFile[] = [];
  for (const entry of entries.slice(0, MAX_REVIEW_FILES)) {
    const before = entry.status === 'added' || entry.status === 'untracked' || !head ? { text: '' } : await headText(root, entry.path);
    const after = entry.status === 'deleted' ? { text: '' } : await workingText(root, entry.path);
    const skipped = before.skipped ?? after.skipped;
    files.push({ path: entry.path, status: entry.status, original: skipped ? '' : before.text, modified: skipped ? '' : after.text, ...(skipped ? { skipped } : {}) });
  }
  return { files, truncated };
}

/**
 * Open in editor: the file in Hydra IDE or VS Code when either's command is on PATH; otherwise it is only shown in its
 * folder. Never the file's default action: on Windows that runs .js, .bat and .ps1 files rather than opening them.
 */
export async function openInEditor(cwd: string, relative: string, reveal: (file: string) => void): Promise<'editor' | 'folder'> {
  const root = (await run(cwd, ['rev-parse', '--show-toplevel']).catch(() => ({ stdout: '' }))).stdout.trim() || cwd;
  const full = path.resolve(root, relative);
  if (!full.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new Error('That file isn\'t in this folder.');
  for (const editor of ['hydra', 'code'] as const) {
    const found = await findProvider(editor as never).catch(() => undefined);
    if (!found?.available || !found.executable) continue;
    const launch = processLaunch(found.executable, ['--goto', full]);
    const child = spawn(launch.executable, launch.args, { cwd: root, windowsHide: true, stdio: 'ignore', detached: false });
    child.on('error', () => undefined);
    child.unref();
    return 'editor';
  }
  reveal(full);
  return 'folder';
}

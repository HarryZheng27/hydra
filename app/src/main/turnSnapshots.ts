import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitBytes, gitRun } from '../../../src/core/git';
import type { TurnFile } from '../../../src/core/chat/events';
import { cleanEnvironment } from './review';
import type { ReviewFile } from '../shared/ipc';

/**
 * What a turn changed in a chat's folder, and putting it back (the change summary card). One private git repository per
 * chat, under the app's own data, never the user's: git runs with `GIT_DIR` there and `GIT_WORK_TREE` at the chat's
 * folder, with its own index, an empty global config (so no filter or hook of the user's runs), hooks off, and the
 * user's `GIT_*` variables dropped. `git add -A` then `git write-tree` before and after a turn give two trees; the
 * folder's own .gitignore applies. Nested repositories already in the index are left out of `add`, as commitAll does
 * (src/core/helperService.ts): git would run `status` inside them with their own config, whose clean filter an agent
 * could have written. A snapshot that fails or runs past its time box is skipped: no card, and the chat never waits on it.
 */
export const SNAPSHOT_MS = 20_000;
const GIT_MS = 15_000;
/** The most a diff shows of one file. */
export const MAX_TURN_FILE_BYTES = 1024 * 1024;
const MAX_UNDO_BYTES = 8 * 1024 * 1024;
/** An undo that runs this long stops, and names the files it didn't reach. */
const UNDO_MS = 60_000;
const treePattern = /^[0-9a-f]{40,64}$/;
const chatPattern = /^[0-9a-f-]{8,64}$/;

/** A file's path relative to the folder, with forward slashes; undefined when it is the folder itself or outside it. */
export function folderRelative(folder: string, file: string): string | undefined {
  if (!file || file.includes('\u0000')) return undefined;
  const relative = path.relative(path.resolve(folder), path.resolve(folder, file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}
const sameKey = (file: string): string => (process.platform === 'win32' ? file.toLowerCase() : file);
const within = (base: string, full: string): boolean => {
  const relative = path.relative(sameKey(base), sameKey(full));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const binary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0);

export interface UndoResult { restored: string[]; skipped: Array<{ path: string; reason: string }> }

export class TurnSnapshots {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Why the last snapshot was skipped, for tests and the log. */
  lastProblem: string | undefined;
  constructor(private readonly dir: string) {}

  private gitDir(chatId: string): string {
    if (!chatPattern.test(chatId)) throw new Error('Not a chat id.');
    return path.join(this.dir, `${chatId}.git`);
  }

  /** Runs `task` after the chat's earlier ones: they share one index. */
  queue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(chatId) ?? Promise.resolve()).then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(chatId, tail);
    void tail.then(() => { if (this.queues.get(chatId) === tail) this.queues.delete(chatId); });
    return run;
  }

  private environment(chatId: string, folder: string): NodeJS.ProcessEnv {
    const gitDir = this.gitDir(chatId);
    const empty = path.join(this.dir, 'empty.config');
    // GIT_LITERAL_PATHSPECS=1 (the review's) would turn `:(exclude,literal)` into a literal name and make `add` fail.
    return { ...cleanEnvironment(), GIT_LITERAL_PATHSPECS: '0', GIT_DIR: gitDir, GIT_WORK_TREE: folder, GIT_INDEX_FILE: path.join(gitDir, 'hydra-index'), GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: '1' };
  }

  private flags(): string[] {
    return ['-c', `core.hooksPath=${path.join(this.dir, 'no-hooks')}`, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', '-c', 'gc.auto=0'];
  }

  private run(chatId: string, folder: string, args: string[], timeoutMs = GIT_MS) {
    return gitRun(folder, [...this.flags(), ...args], this.environment(chatId, folder), timeoutMs);
  }

  private bytes(chatId: string, folder: string, args: string[]): Promise<Buffer> {
    return gitBytes(folder, [...this.flags(), ...args], this.environment(chatId, folder), GIT_MS);
  }

  private async ensure(chatId: string, folder: string): Promise<void> {
    const gitDir = this.gitDir(chatId);
    await mkdir(path.join(this.dir, 'no-hooks'), { recursive: true });
    if (!existsSync(path.join(this.dir, 'empty.config'))) await writeFile(path.join(this.dir, 'empty.config'), '');
    if (!existsSync(path.join(gitDir, 'HEAD'))) {
      await mkdir(gitDir, { recursive: true });
      const made = await this.run(chatId, folder, ['init', '--quiet']);
      if (made.code !== 0) throw new Error(`git init failed: ${made.stderr.trim()}`);
    }
    // The folder's .gitattributes (text=auto, eol, filters, encodings) must not change the bytes a snapshot keeps: this file wins over it.
    const attributes = path.join(gitDir, 'info', 'attributes');
    if (!existsSync(attributes)) { await mkdir(path.dirname(attributes), { recursive: true }); await writeFile(attributes, '* -text -eol -filter -ident -working-tree-encoding\n'); }
  }

  /**
   * A tree of the folder as it is now, or undefined when it couldn't be taken in time. Queued with the chat's other
   * work; never throws.
   */
  snapshot(chatId: string, folder: string): Promise<string | undefined> {
    return this.queue(chatId, async () => {
      try {
        const deadline = Date.now() + SNAPSHOT_MS;
        const left = () => Math.max(1000, deadline - Date.now());
        await this.ensure(chatId, folder);
        // A snapshot killed at its time box leaves its lock behind; the queue guarantees nothing else is using it.
        await rm(path.join(this.gitDir(chatId), 'hydra-index.lock'), { force: true });
        const staged = await this.run(chatId, folder, ['ls-files', '-s', '-z'], left());
        const gitlinks = staged.code === 0 ? staged.stdout.split('\u0000').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)) : [];
        // A file git couldn't read would keep its old entry, and the tree would be stale: that snapshot is skipped.
        const spec = ['--', '.', ...gitlinks.map(link => `:(exclude,literal)${link}`)];
        let added = await this.run(chatId, folder, ['add', '-A', ...spec], left());
        // A nested repository with no commit can't be added as a pointer and stops `add`; it alone is left out, and nothing else may fail.
        const benign = (stderr: string) => stderr.split(/\r?\n/).every(line => !line.trim() || /does not have a commit checked out|unable to index file '[^']*/'|adding files failed|^hint:|^warning:/.test(line));
        if (added.code !== 0 && benign(added.stderr)) added = await this.run(chatId, folder, ['add', '-A', '--ignore-errors', ...spec], left());
        if (added.code !== 0 && !(benign(added.stderr) && /does not have a commit checked out/.test(added.stderr))) { this.lastProblem = `add failed (${added.code}): ${added.stderr.trim()}`; return undefined; }
        const tree = await this.run(chatId, folder, ['write-tree'], left());
        const id = tree.stdout.trim();
        return tree.code === 0 && treePattern.test(id) ? id : undefined;
      } catch { return undefined; }
    });
  }

  /** The files `listed` names (folder-relative or absolute) that differ between two trees, with their line counts. */
  async changes(chatId: string, folder: string, before: string, after: string, listed: Iterable<string>): Promise<TurnFile[]> {
    if (!treePattern.test(before) || !treePattern.test(after) || before === after) return [];
    const wanted: string[] = [];
    for (const file of listed) { const relative = folderRelative(folder, file); if (relative && !wanted.some(known => sameKey(known) === sameKey(relative))) wanted.push(relative); }
    if (!wanted.length) return [];
    const flags = ['-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
    const [counts, names] = await Promise.all([
      this.run(chatId, folder, ['diff-tree', ...flags, '--numstat', before, after]),
      this.run(chatId, folder, ['diff-tree', ...flags, '--name-status', before, after]),
    ]);
    if (counts.code !== 0 || names.code !== 0) return [];
    const numbers = new Map<string, { added?: number; removed?: number; path: string }>();
    for (const record of counts.stdout.split('\u0000').filter(Boolean)) {
      const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
      if (first < 0 || second < 0) continue;
      const file = record.slice(second + 1);
      const added = record.slice(0, first), removed = record.slice(first + 1, second);
      numbers.set(sameKey(file), { path: file, ...(/^\d+$/.test(added) ? { added: Number(added) } : {}), ...(/^\d+$/.test(removed) ? { removed: Number(removed) } : {}) });
    }
    const kinds = new Map<string, TurnFile['kind']>();
    const parts = names.stdout.split('\u0000').filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) kinds.set(sameKey(parts[i + 1]!), parts[i]![0] === 'A' ? 'add' : parts[i]![0] === 'D' ? 'delete' : 'update');
    const files: TurnFile[] = [];
    for (const relative of wanted) {
      const found = numbers.get(sameKey(relative));
      if (!found) continue;
      files.push({ path: found.path, kind: kinds.get(sameKey(relative)) ?? 'update', ...(found.added !== undefined ? { added: found.added } : {}), ...(found.removed !== undefined ? { removed: found.removed } : {}) });
    }
    return files;
  }

  /** A path's entry in a tree: its mode, and its blob (`sha` is empty for a folder or a nested repository). */
  private async entry(chatId: string, folder: string, tree: string, relative: string): Promise<{ mode: string; sha: string } | undefined> {
    const listed = await this.run(chatId, folder, ['ls-tree', '-z', tree, '--', relative]);
    if (listed.code !== 0) throw new Error(listed.stderr.trim() || 'git ls-tree failed');
    for (const line of listed.stdout.split('\u0000').filter(Boolean)) {
      const tab = line.indexOf('\t');
      if (tab <= 0 || line.slice(tab + 1) !== relative) continue;
      const [mode, type, sha] = line.slice(0, tab).split(' ');
      return { mode: mode!, sha: type === 'blob' ? sha! : '' };
    }
    return undefined;
  }

  private async blobSize(chatId: string, folder: string, sha: string): Promise<number> {
    return Number((await this.bytes(chatId, folder, ['cat-file', '-s', sha])).toString('utf8').trim());
  }

  private requireRepo(chatId: string): void {
    if (!existsSync(path.join(this.gitDir(chatId), 'HEAD'))) throw new Error('Hydra no longer has the snapshots for this chat, so it can\'t do that.');
  }

  /** One file as a before and after pair for the review pane, capped in size. */
  async diffFile(chatId: string, folder: string, before: string, after: string, relative: string, kind: TurnFile['kind']): Promise<ReviewFile> {
    this.requireRepo(chatId);
    if (!treePattern.test(before) || !treePattern.test(after)) throw new Error('That change has no snapshot.');
    const status: ReviewFile['status'] = kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : 'modified';
    const read = async (tree: string): Promise<{ text: string; skipped?: string }> => {
      const found = await this.entry(chatId, folder, tree, relative);
      if (!found?.sha) return { text: '' };
      if (await this.blobSize(chatId, folder, found.sha) > MAX_TURN_FILE_BYTES) return { text: '', skipped: 'over 1 MB' };
      const bytes = await this.bytes(chatId, folder, ['cat-file', 'blob', found.sha]);
      return binary(bytes) ? { text: '', skipped: 'binary' } : { text: bytes.toString('utf8') };
    };
    const [was, now] = await Promise.all([read(before), read(after)]);
    const skipped = was.skipped ?? now.skipped;
    return { path: relative, status, original: skipped ? '' : was.text, modified: skipped ? '' : now.text, ...(skipped ? { skipped } : {}) };
  }

  /**
   * Puts `files` back as the `before` tree had them. A file is only touched while it still is what the turn left (the
   * `after` tree's content, or absent); one that has changed since, or isn't a plain file, is left alone and named.
   * Runs in the chat's queue, so it never overlaps a snapshot.
   */
  undo(chatId: string, folder: string, before: string, after: string, files: readonly string[]): Promise<UndoResult> {
    return this.queue(chatId, async () => {
      this.requireRepo(chatId);
      if (!treePattern.test(before) || !treePattern.test(after)) throw new Error('That change has no snapshot.');
      const root = await realpath(folder);
      const restored: string[] = [];
      const skipped: UndoResult['skipped'] = [];
      const deadline = Date.now() + UNDO_MS;
      for (const relative of files) {
        const skip = (reason: string) => { skipped.push({ path: relative, reason }); };
        if (Date.now() > deadline) { skip('ran out of time'); continue; }
        try {
          if (folderRelative(folder, relative) !== relative) { skip('outside the folder'); continue; }
          const target = path.join(root, ...relative.split('/'));
          // The nearest folder that exists must really be inside the folder (a link could lead out of it).
          let ancestor = path.dirname(target);
          while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
          if (!within(root, await realpath(ancestor))) { skip('behind a link that leads outside the folder'); continue; }
          const was = await this.entry(chatId, folder, before, relative);
          const now = await this.entry(chatId, folder, after, relative);
          const plain = (entry: { mode: string; sha: string } | undefined) => !entry || (!!entry.sha && ['100644', '100755'].includes(entry.mode));
          if (!plain(was) || !plain(now)) { skip('not a plain file'); continue; }
          const info = await lstat(target).catch(() => undefined);
          if (info && !info.isFile()) { skip(info.isSymbolicLink() ? 'now a link' : 'not a plain file'); continue; }
          if (now) {
            if (!info) { skip('already gone'); continue; }
            if (info.size > MAX_UNDO_BYTES || await this.blobSize(chatId, folder, now.sha) > MAX_UNDO_BYTES) { skip('too big to undo'); continue; }
          } else if (info) { skip('exists again'); continue; }
          if (was && await this.blobSize(chatId, folder, was.sha) > MAX_UNDO_BYTES) { skip('too big to undo'); continue; }
          // Everything git has to say is fetched first, so the comparison and the swap that follow it are back to back.
          const left = now ? await this.bytes(chatId, folder, ['cat-file', 'blob', now.sha]) : undefined;
          const content = was ? await this.bytes(chatId, folder, ['cat-file', 'blob', was.sha]) : undefined;
          let scratch: string | undefined;
          if (content) {
            await mkdir(path.dirname(target), { recursive: true });
            // A new name only this call can create: a link planted at a guessable name is never written through.
            scratch = `${target}.${randomBytes(6).toString('hex')}.hydra-undo`;
            await writeFile(scratch, content, { flag: 'wx', mode: info ? info.mode & 0o777 : was!.mode === '100755' ? 0o755 : 0o644 });
          }
          try {
            if (left && !left.equals(await readFile(target))) { skip('edited since'); if (scratch) await unlink(scratch).catch(() => undefined); continue; }
            if (scratch) await rename(scratch, target); else await unlink(target);
          } catch (error) { if (scratch) await unlink(scratch).catch(() => undefined); throw error; }
          restored.push(relative);
        } catch (error) { skip(`couldn't restore: ${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}`); }
      }
      return { restored, skipped };
    });
  }

  /** Deletes a chat's snapshots, after its queued work. */
  remove(chatId: string): Promise<void> {
    return this.queue(chatId, () => rm(this.gitDir(chatId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
}

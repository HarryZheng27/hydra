import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startClaudeCloud, windowsCommandLine, type ClaudeCloudSession, type SpawnPseudoTerminal } from '../../../src/core/chat/cloud';
import { loadNodePty, type PtyLike } from '../../../src/core/lanePty';
import { chatIdPattern } from '../../../src/core/chat/store';

/**
 * The app's side of Claude cloud chats (G7): `claude --cloud` in node-pty, the lanes' own pseudo-terminal, and the
 * fresh worktree Continue here opens the session in (src/core/chat/cloud.ts has the rules).
 */
export interface CloudChatsDeps {
  /** The app folder node-pty is in (lanes use the same). */
  appRoot: string;
  /** Where Continue here's worktrees go: under the app's own data, never inside a project. */
  worktrees: string;
  git?: (args: string[], cwd: string) => Promise<string>;
  spawn?: SpawnPseudoTerminal;
}

const runGit = (args: string[], cwd: string): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim().split('\n').slice(-2).join(' ')));
    else resolve(stdout.trim());
  });
});

export function cloudChats(deps: CloudChatsDeps): { start(input: { executable: string; cwd: string; message: string; signal?: AbortSignal }): Promise<ClaudeCloudSession>; worktree(cwd: string, chatId: string): Promise<string> } {
  const git = deps.git ?? runGit;
  const spawn: SpawnPseudoTerminal = deps.spawn ?? ((file, args, options) => {
    const pty = loadNodePty(deps.appRoot).module;
    if (!pty) throw new Error('Terminals aren\'t available in this build, and a cloud chat needs one.');
    const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    // On Windows the command line is quoted here, not by node-pty (windowsCommandLine says why). node-pty takes a
    // string as the whole command line; the lanes' narrower type only lists the array form.
    const spawnPty = pty.spawn.bind(pty) as (file: string, args: string[] | string, ptyOptions: typeof options & { env: Record<string, string> }) => PtyLike;
    return spawnPty(file, process.platform === 'win32' ? windowsCommandLine(args) : args, { ...options, env });
  });
  return {
    // The project is trusted in the app (ChatManager checks), so Claude Code's own trust prompt is answered.
    start: input => startClaudeCloud({ ...input, spawn, answerTrust: true }),
    async worktree(cwd, chatId) {
      if (!chatIdPattern.test(chatId)) throw new Error('No such chat.');
      try { await git(['rev-parse', '--show-toplevel'], cwd); } catch { throw new Error('Continue here needs the project to be a git repository.'); }
      const folder = path.join(deps.worktrees, chatId);
      const branch = `hydra/cloud-${chatId.slice(0, 8)}`;
      // A second Continue here opens the same worktree.
      if (existsSync(path.join(folder, '.git'))) return folder;
      await mkdir(deps.worktrees, { recursive: true });
      // A worktree whose folder was deleted is still registered, and `worktree add` would refuse its path.
      await git(['worktree', 'prune'], cwd);
      const branches = await git(['branch', '--list', branch], cwd);
      await git(branches ? ['worktree', 'add', folder, branch] : ['worktree', 'add', '-b', branch, folder, 'HEAD'], cwd);
      return folder;
    },
  };
}

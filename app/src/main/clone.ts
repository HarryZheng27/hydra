import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Clone a repo: the user's own git clones a repository they name into a folder they pick, and the clone becomes a
 * project. Only https and SSH (`git@host:path`, `ssh://`) URLs are accepted, so no local path, `file://` or `ext::`
 * transport can be named, and nothing that starts with `-` reaches git as an option. Submodules aren't fetched. git runs
 * hidden, never asks in a terminal (git's and ssh's prompts are off), and stops after 10 minutes; a failed clone's folder
 * is removed. The new folder's name is checked so it can never be `.git` or start with a dot.
 */
// Host and path each start with a letter or digit, so neither can be read as an option (`-oProxyCommand`).
const host = '[A-Za-z0-9][A-Za-z0-9.-]*';
const repoPath = '[A-Za-z0-9][A-Za-z0-9._~\\/-]*';
const https = new RegExp(`^https://${host}(:\\d{1,5})?/${repoPath}$`);
const scp = new RegExp(`^git@${host}:${repoPath}$`);
const ssh = new RegExp(`^ssh://git@${host}(:\\d{1,5})?/${repoPath}$`);

export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Why a repository URL can't be cloned, or undefined when it can. */
export function repoUrlProblem(url: string): string | undefined {
  if (typeof url !== 'string' || url.length > 500) return 'That isn\'t a repository URL.';
  if (!(https.test(url) || scp.test(url) || ssh.test(url))) return 'Use an https or SSH repository URL, like https://github.com/owner/repo.';
  if (/(^|\/)\.\.(\/|$)/.test(url.replace(/^[^:]+:\/*/, ''))) return 'That isn\'t a repository URL.';
  return undefined;
}

/** The folder name a clone gets: the URL's last part without `.git`. */
export function repoName(url: string): string {
  const last = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  // Starts and ends with a letter or digit (Windows drops a trailing dot), and is never `.git` in any case or a
  // reserved device name: a clone named `.git` in the picked folder would make that folder a repository whose config
  // (and its programs) the repository's author chose.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/.test(name) || /^\.?git$/i.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) {
    throw new Error('Hydra can\'t name a folder after that repository.');
  }
  return name;
}

export type GitRunner = (args: string[], cwd: string) => Promise<void>;

const runGit: GitRunner = (args, cwd) => new Promise((resolve, reject) => {
  // No prompt in a terminal nobody sees: git's own, and ssh's (an unknown host key or a passphrase fails at once).
  execFile('git', args, { cwd, windowsHide: true, timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
    if (!error) { resolve(); return; }
    const line = String(stderr).trim().split(/\r?\n/).filter(Boolean).pop();
    reject(new Error(line ? `git couldn't clone it: ${line.slice(0, 300)}` : 'git couldn\'t clone it.'));
  });
});

/** Clones `url` into a new folder under `parent`; returns that folder. */
export async function cloneRepo(url: string, parent: string, run: GitRunner = runGit): Promise<string> {
  const problem = repoUrlProblem(url);
  if (problem) throw new Error(problem);
  const destination = path.join(parent, repoName(url));
  if (existsSync(destination)) throw new Error(`${destination} already exists. Pick another folder.`);
  try {
    await run(['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--no-recurse-submodules', '--', url, destination], parent);
  } catch (error) {
    // A clone that failed or timed out leaves no half-made folder (it didn't exist before), so a retry can work.
    rmSync(destination, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
  return destination;
}

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Clone a repo: the user's own git clones a repository they name into a folder they pick, and the clone becomes a
 * project. Only https and SSH (`git@host:path`, `ssh://`) URLs are accepted, so no local path, `file://` or `ext::`
 * transport can be named, and nothing that starts with `-` reaches git as an option. Submodules aren't fetched. git runs
 * hidden, never asks in the terminal, and stops after 10 minutes.
 */
const https = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~\/-]+$/;
const scp = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+$/;
const ssh = /^ssh:\/\/git@[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~\/-]+$/;

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
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw new Error('Hydra can\'t name a folder after that repository.');
  return name;
}

export type GitRunner = (args: string[], cwd: string) => Promise<void>;

const runGit: GitRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, windowsHide: true, timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
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
  await run(['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--no-recurse-submodules', '--', url, destination], parent);
  return destination;
}

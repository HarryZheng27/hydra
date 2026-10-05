import { execFile } from 'node:child_process';
import type { PullRequestInfo, PullRequestCheck } from '../shared/ipc';
import { pullRequestUrlPattern } from '../../../src/core/chat/store';

/** What `gh pr view --json` prints for the fields asked; anything else in it is ignored. */
const FIELDS = 'number,title,headRefName,additions,deletions,state,isDraft,statusCheckRollup';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);

/** One entry of gh's statusCheckRollup (a check run or a commit status), as pending, passed, failed or skipped. */
function check(raw: unknown): PullRequestCheck | undefined {
  if (!isRecord(raw)) return undefined;
  const name = text(raw.name) || text(raw.context);
  if (!name) return undefined;
  const workflow = text(raw.workflowName);
  const label = workflow && workflow !== name ? `${workflow} / ${name}` : name;
  if (raw.__typename === 'StatusContext') {
    const state = text(raw.state).toUpperCase();
    return { name: label, status: state === 'SUCCESS' ? 'success' : state === 'FAILURE' || state === 'ERROR' ? 'failure' : 'pending' };
  }
  if (text(raw.status).toUpperCase() !== 'COMPLETED') return { name: label, status: 'pending' };
  const conclusion = text(raw.conclusion).toUpperCase();
  return { name: label, status: conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' ? 'success' : conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'ACTION_REQUIRED' || conclusion === 'STARTUP_FAILURE' ? 'failure' : 'skipped' };
}

/** CI as one word: running while any check runs; else failed if any failed; else passed if any passed. */
export function rollup(checks: readonly PullRequestCheck[]): PullRequestInfo['ci'] {
  if (checks.some(c => c.status === 'pending')) return 'pending';
  if (checks.some(c => c.status === 'failure')) return 'failure';
  if (checks.some(c => c.status === 'success')) return 'success';
  return 'none';
}

/** Reads gh's JSON for one pull request into what the chat's PR bar shows. Throws on anything that isn't one. */
export function parsePullRequest(url: string, stdout: string): PullRequestInfo {
  const raw = JSON.parse(stdout) as unknown;
  if (!isRecord(raw) || !Number.isSafeInteger(raw.number)) throw new Error('gh printed something other than a pull request.');
  const [, owner = '', repo = ''] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(url) ?? [];
  const state = text(raw.state).toLowerCase();
  const checks = (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).slice(0, 100).map(check).filter((c): c is PullRequestCheck => !!c);
  return {
    url, number: raw.number as number, owner, repo, title: text(raw.title, 300), branch: text(raw.headRefName),
    additions: count(raw.additions), deletions: count(raw.deletions),
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open', draft: raw.isDraft === true,
    checks, ci: rollup(checks),
  };
}

type Run = (args: string[]) => Promise<string>;
const gh: Run = args => new Promise((resolve, reject) => execFile('gh', args, { windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20 }, (error, stdout) => (error ? reject(new Error("GitHub's gh couldn't read that pull request.")) : resolve(String(stdout)))));

/**
 * The chat's PR bars (Claude desktop's): gh's own read-only view of a GitHub pull request, by its link only. Answers
 * are kept for 15 seconds so several open chats don't each ask.
 */
export function pullRequests(run: Run = gh, now = () => Date.now()) {
  const cache = new Map<string, { at: number; info: Promise<PullRequestInfo> }>();
  return (url: string): Promise<PullRequestInfo> => {
    if (!pullRequestUrlPattern.test(url)) return Promise.reject(new Error('That is not a GitHub pull request link.'));
    const hit = cache.get(url);
    if (hit && now() - hit.at < 15_000) return hit.info;
    const info = run(['pr', 'view', url, '--json', FIELDS]).then(stdout => parsePullRequest(url, stdout));
    cache.set(url, { at: now(), info });
    info.catch(() => cache.delete(url));
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return info;
  };
}

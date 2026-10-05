import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePullRequest, pullRequests, rollup } from '../src/main/pullRequests';
import { chatPullRequests } from '../src/renderer/PrBars';
import { groupLabel, runningTasks, stepLabel } from '../src/renderer/ToolSteps';
import { parseCall } from '../src/shared/ipc';
import type { ChatEvent } from '../src/shared/ipc';

const url = 'https://github.com/ndunl075/hydra/pull/333';
const gh = JSON.stringify({
  number: 333, title: 'App: the sidebar', headRefName: 'feat/app-sidebar-claude', additions: 291, deletions: 74, state: 'OPEN', isDraft: false,
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'app', workflowName: 'App', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'check', workflowName: 'Check', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', name: 'desktop', workflowName: 'Windows desktop', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { __typename: 'StatusContext', context: 'deploy', state: 'FAILURE' },
  ],
});

test('a PR bar reads gh\'s view of a GitHub pull request link only, and CI is running while any check runs', async () => {
  const info = parsePullRequest(url, gh);
  assert.deepEqual({ number: info.number, owner: info.owner, repo: info.repo, branch: info.branch, additions: info.additions, deletions: info.deletions, state: info.state }, { number: 333, owner: 'ndunl075', repo: 'hydra', branch: 'feat/app-sidebar-claude', additions: 291, deletions: 74, state: 'open' });
  assert.deepEqual(info.checks.map(c => `${c.name}:${c.status}`), ['App / app:success', 'Check / check:pending', 'Windows desktop / desktop:skipped', 'deploy:failure']);
  assert.equal(info.ci, 'pending');
  assert.equal(rollup(info.checks.filter(c => c.status !== 'pending')), 'failure');
  assert.equal(rollup([{ name: 'a', status: 'success' }, { name: 'b', status: 'skipped' }]), 'success');
  assert.equal(rollup([]), 'none');
  assert.equal(parsePullRequest(url, JSON.stringify({ number: 1, state: 'MERGED' })).state, 'merged');
  assert.throws(() => parsePullRequest(url, '[]'));

  // gh is asked once per link for 15 seconds, with its arguments as a list; anything but a PR link never reaches it.
  const calls: string[][] = [];
  let now = 0;
  const read = pullRequests(async args => { calls.push(args); return gh; }, () => now);
  await read(url); await read(url);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 3), ['pr', 'view', url]);
  now = 16_000; await read(url);
  assert.equal(calls.length, 2);
  for (const bad of ['https://github.com/a/b/issues/1', 'https://evil.example/a/b/pull/1', `${url} --web`, 'https://github.com/a/b/pull/1/files']) {
    await assert.rejects(read(bad), /not a GitHub pull request link/);
    assert.equal(parseCall({ channel: 'chats.pullRequest', payload: { url: bad } }).ok, false);
  }
  assert.equal(calls.length, 2);
  assert.equal(parseCall({ channel: 'chats.pullRequest', payload: { url } }).ok, true);
});

test('a chat\'s PR bars are the links its own gh pr create printed, newest first', () => {
  const events: ChatEvent[] = [
    { type: 'tool-call', id: 'a', name: 'Bash', input: { command: 'gh pr create --fill' } },
    { type: 'tool-result', id: 'a', output: 'https://github.com/ndunl075/hydra/pull/332\n' },
    { type: 'tool-call', id: 'b', name: 'Bash', input: { command: 'gh pr view 1' } },
    { type: 'tool-result', id: 'b', output: 'https://github.com/x/y/pull/1' },
    { type: 'tool-call', id: 'c', name: 'Shell', input: { command: ['gh', 'pr', 'create'] } },
    { type: 'tool-result', id: 'c', output: url },
  ] as ChatEvent[];
  assert.deepEqual(chatPullRequests(events), [url, 'https://github.com/ndunl075/hydra/pull/332']);
  assert.deepEqual(chatPullRequests([], url), [url]);
});

test('tool steps fold into one line: a step\'s own description, or counts for several', () => {
  const tool = (name: string, input: unknown, output?: string) => ({ kind: 'tool' as const, key: name, id: name, name, input, ...(output !== undefined ? { output } : {}) });
  assert.equal(stepLabel(tool('Bash', { command: 'gh run list', description: 'Watch CI for PR 332' })), 'Watch CI for PR 332');
  assert.equal(stepLabel(tool('Bash', { command: 'git status\nmore' })), 'Ran git status');
  assert.equal(stepLabel(tool('Read', { file_path: 'C:\\repo\\app\\Sidebar.tsx' })), 'Read Sidebar.tsx');
  assert.equal(stepLabel(tool('mcp__hydra__hydra_lanes', {})), 'hydra / hydra_lanes');
  assert.equal(groupLabel([tool('Bash', { command: 'a' }), tool('Bash', { command: 'b' }), tool('Read', { file_path: 'x.ts' }), tool('Edit', { file_path: 'y.ts' })]), 'Ran 2 commands, read 1 file, edited 1 file');
});

test('running tasks count background commands until they end or Hydra reopens the chat', () => {
  const start = (id: string, task: string): ChatEvent[] => [
    { type: 'tool-call', id, name: 'Bash', input: { command: 'sleep 60', run_in_background: true } },
    { type: 'tool-result', id, output: `Command running in background with ID: ${task}. Output is being written to: x` },
  ] as ChatEvent[];
  const events: ChatEvent[] = [{ type: 'user', text: 'go' } as ChatEvent, ...start('a', 'b1'), ...start('b', 'b2'), { type: 'done', status: 'success' } as ChatEvent];
  assert.equal(runningTasks(events), 2);
  // A turn the user didn't start is Claude Code's notice that one ended.
  assert.equal(runningTasks([...events, { type: 'done', status: 'success' } as ChatEvent]), 1);
  assert.equal(runningTasks([...events, { type: 'tool-call', id: 'k', name: 'TaskStop', input: {} } as ChatEvent, { type: 'tool-result', id: 'k', output: 'b2 stopped' } as ChatEvent]), 1);
  assert.equal(runningTasks(events, events.length), 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { LanesController, type LanesHost } from '../src/host/lanes';
import type { LaneServerMessage } from '../src/core/model';
import { FakeHost } from './host/fakeHost';

/**
 * The lanes controller with no editor (docs/internal/hydra-app/G2-host-split.md, milestone 5): node-pty comes from the
 * host's app root (a FakeHost's has none, so terminals are unavailable), and everything it asks or opens goes through Host.
 */
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydra-lanes-controller-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const platform = new FakeHost({ storage: path.join(root, 'storage'), dist: path.join(root, 'dist'), appRoot: path.join(root, 'no-app') });
  const posted: LaneServerMessage[] = [];
  let ready = false, opened = 0;
  const lanesHost: LanesHost = {
    platform, log: line => platform.log(line), post: message => { posted.push(message); },
    openAgents: async () => { opened++; }, toEditor: async () => {}, webviewReady: () => ready,
    helperServerSpec: () => ({ command: 'hydra', args: [], env: {} }), runningHeads: () => 0, changed: () => {},
    gatesExecutable: async provider => `fake-${provider}`, gatesLimited: () => false,
    openEvidence: async () => {},
  };
  const lanes = new LanesController(lanesHost);
  t.after(async () => { await lanes.stop(); lanes.dispose(); });
  return { root, repo, platform, posted, lanes, setReady: (value: boolean) => { ready = value; }, opened: () => opened };
}

test('lanes load node-pty from the host\'s app root, and say so when it has none', async t => {
  const { repo, root, platform, lanes } = await setup(t);
  await lanes.start(repo, path.join(root, 'storage', 'workspaces', 'w'));
  assert.equal(lanes.available, true);
  assert.equal(lanes.state().terminals, false);
  assert.ok(platform.logs.some(line => line.startsWith('[lanes] ') && line.includes("Terminals aren't available")), platform.logs.join(' | '));
  assert.ok(platform.logs.some(line => /\[lanes\] ready \(0 open, terminals unavailable\)/.test(line)));
});

test('a lane diff\'s base side is served through the host, only for an open lane at a full commit', async t => {
  const { repo, root, platform, lanes } = await setup(t);
  await lanes.start(repo, path.join(root, 'storage', 'workspaces', 'w'));
  const source = platform.textSources.get('hydra-lane');
  assert.ok(source, 'the base-content source is registered with the host');
  assert.equal(await source('/a.txt', 'aaaaaaaaaaaa.empty'), '');
  assert.equal(await source('/a.txt', `aaaaaaaaaaaa.${'b'.repeat(40)}`), '', 'no such lane');
  assert.equal(await source('/../a.txt', 'nonsense'), '');
  lanes.dispose();
  assert.equal(platform.textSources.has('hydra-lane'), false, 'disposing the controller unregisters it');
});

test('New lane without terminals explains itself through the host, an unknown lane is refused, and Show waits for the view', async t => {
  const { repo, root, platform, lanes, posted, setReady, opened } = await setup(t);
  await lanes.start(repo, path.join(root, 'storage', 'workspaces', 'w'));
  await assert.rejects(lanes.action('nope', 'refresh', false), /isn't open in this window/);
  // hydra.newLane, through the commands the IDE registers: with no terminals it says so, and asks nothing.
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  lanes.registerCommands((name, callback) => { commands.set(name, callback); });
  await commands.get('hydra.newLane')!();
  assert.deepEqual(platform.notices.map(notice => [notice.level, notice.message]), [['error', "Hydra: Terminals aren't available in this build."]]);
  assert.equal(platform.confirms.length, 0);
  await lanes.show('lanes');
  assert.equal(opened(), 1);
  assert.equal(posted.filter(message => message.type === 'show').length, 0, 'not posted before the view is ready');
  setReady(true);
  await lanes.show('canvas');
  assert.deepEqual(posted.filter(message => message.type === 'show').at(-1), { type: 'show', view: 'canvas' });
});

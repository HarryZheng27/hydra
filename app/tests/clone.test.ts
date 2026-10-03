import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cloneRepo, repoName, repoUrlProblem } from '../src/main/clone';
import { createHandlers } from '../src/main/handlers';

test('Clone a repo takes only https and SSH repository URLs, never a local path, another transport or an option', () => {
  for (const url of ['https://github.com/owner/repo', 'https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@example.com:2222/team/repo', 'https://gitlab.example.com/group/sub/repo']) {
    assert.equal(repoUrlProblem(url), undefined, url);
  }
  for (const url of ['git@-oProxyCommand=calc:x', 'git@host:-x/y', 'https://-h/x', 'C:\\Users\\me\\repo', 'file:///C:/repo', 'ext::sh -c touch% /tmp/x', '--upload-pack=calc', 'http://github.com/owner/repo', 'https://github.com/owner/repo --config x', 'https://github.com/../etc', 'https://user:pass@github.com/o/r', '']) {
    assert.ok(repoUrlProblem(url), url);
  }
  assert.equal(repoName('https://github.com/owner/repo.git'), 'repo');
  assert.equal(repoName('git@github.com:owner/my-app'), 'my-app');
  // A clone named .git would make the picked folder a repository its author configured.
  for (const url of ['https://h/x/.git.git', 'https://h/x/.GIT.git', 'https://h/x/.git..git', 'https://h/x/git', 'https://h/x/.hidden', 'https://h/x/name.', 'https://h/x/CON', 'https://h/x/nul.txt']) {
    assert.throws(() => repoName(url), /can't name a folder/, url);
  }
});

test('a clone goes into a new folder under the one picked, with no submodules and no local transports; an existing folder is refused', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-clone-'));
  try {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const folder = await cloneRepo('https://github.com/owner/repo.git', parent, async (args, cwd) => { calls.push({ args, cwd }); });
    assert.equal(folder, path.join(parent, 'repo'));
    assert.deepEqual(calls, [{ args: ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--no-recurse-submodules', '--', 'https://github.com/owner/repo.git', path.join(parent, 'repo')], cwd: parent }]);
    fs.mkdirSync(path.join(parent, 'repo'));
    await assert.rejects(cloneRepo('https://github.com/owner/repo', parent, async () => undefined), /already exists/);
    await assert.rejects(cloneRepo('file:///C:/x', parent, async () => { throw new Error('ran'); }), /https or SSH/);
    // A failed clone leaves no half-made folder behind.
    await assert.rejects(cloneRepo('https://github.com/owner/other', parent, async (args) => { fs.mkdirSync(args.at(-1)!); throw new Error('network'); }), /network/);
    assert.equal(fs.existsSync(path.join(parent, 'other')), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('the clone channel checks the URL before asking for a folder, and adds the clone as a project', async () => {
  let state = { version: 1 as const, sidebarOpen: true, projects: [] as Array<{ id: string; path: string; name: string }> };
  const store = { load: async () => state, update: async (change: (current: typeof state) => typeof state) => (state = change(state)) } as never;
  const picks: string[] = [];
  const handlers = createHandlers({
    info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' }, settings: { load: async () => ({ version: 1, theme: 'system', cliPaths: {} }) } as never, state: store,
    pickFolder: async purpose => { picks.push(purpose ?? 'project'); return 'C:\\code'; }, pickExecutable: async () => undefined, applyTheme: () => undefined,
    checkSetup: async () => { throw new Error('unused'); }, signIn: async () => ({ signedIn: false }), confirmTrust: async () => false,
    chats: {} as never, cloneRepo: async (url, parent) => path.join(parent, repoName(url)),
  });
  await assert.rejects(async () => handlers['projects.clone']({ url: 'file:///C:/x' }), /https or SSH/);
  assert.deepEqual(picks, [], 'no folder is asked for a bad URL');
  const result = await handlers['projects.clone']({ url: 'https://github.com/owner/repo' });
  assert.deepEqual(picks, ['clone']);
  assert.equal(result.state.projects.length, 1);
  assert.equal(result.state.projects[0]!.path, path.join('C:\\code', 'repo'));
  assert.equal(result.picked, result.state.projects[0]!.id);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OwnershipLock } from '../../src/core/ownership';
import { findWindowFor } from '../../src/core/helperDiscovery';
import { folderKey, ideStorageRoot, vscodeFolderUri } from '../src/main/host';
import { HydraProjects } from '../src/main/hydra';
import type { Project } from '../src/shared/ipc';

const scratch = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `hydra-app-${name}-`));
function repo(): string {
  const dir = fs.realpathSync.native(scratch('repo'));
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); };
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
  return dir;
}
const projects = (storage: string, userData: string) => new HydraProjects({
  storage, dist: path.join(__dirname, '..', 'dist'), appRoot: path.join(__dirname, '..'), extension: path.join(__dirname, '..', '..'),
  userData, version: '0.0.0-test', development: true, cliPath: async () => undefined, log: () => undefined,
});
const project = (dir: string): Project => ({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', path: dir, name: path.basename(dir), trustedAt: new Date().toISOString() });

test('a project\'s storage is the IDE\'s own for a window of that folder: the same URI and the same key', () => {
  assert.equal(vscodeFolderUri('C:\\Users\\ndunl\\Documents\\orven'), 'file:///c%3A/Users/ndunl/Documents/orven');
  assert.equal(vscodeFolderUri('D:\\my repo\\R&D'), 'file:///d%3A/my%20repo/R%26D');
  // A key the IDE wrote on Nico's machine for this folder (checked against 27 of its window folders).
  assert.equal(folderKey('C:\\Users\\ndunl\\Documents\\hydra'), '12f29467c0a73187');
  assert.match(ideStorageRoot({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), /^C:\\Users\\x\\AppData\\Roaming\\Hydra\\User\\globalStorage\\nico-dunlap\.hydra-agent-manager$/);
  assert.equal(ideStorageRoot({ HYDRA_APP_IDE_STORAGE: 'C:\\t', APPDATA: 'C:\\x' }), 'C:\\t');
});

test('coexistence: a repository the app owns is refused by another Hydra, and one another Hydra owns is refused by the app', { timeout: 120_000 }, async () => {
  const dir = repo();
  const storage = scratch('storage'), userData = scratch('userdata');
  try {
    // The app owns it: another Hydra window (the IDE) can't take it, and `hydra` finds the app there.
    const app = projects(storage, userData);
    await app.start(project(dir));
    assert.deepEqual(app.status().map(status => [status.running, status.owned]), [[true, true]]);
    const ide = new OwnershipLock();
    await assert.rejects(ide.acquire(path.join(storage, 'ownership'), dir), /already managed/);
    const window = await findWindowFor(path.join(storage, 'helpers'), dir);
    assert.equal(window?.pid, process.pid, 'the discovery record names the app\'s process');
    await app.shutdown();
    assert.equal(await findWindowFor(path.join(storage, 'helpers'), dir), undefined, 'gone when the app quits');

    // Another Hydra owns it: the app runs nothing there and says why.
    const owner = new OwnershipLock();
    await owner.acquire(path.join(storage, 'ownership'), dir);
    const second = projects(storage, userData);
    await second.start(project(dir));
    const [status] = second.status();
    assert.equal(status?.owned, false);
    assert.match(status?.error ?? '', /another window already manages/);
    assert.equal(await findWindowFor(path.join(storage, 'helpers'), dir), undefined, 'no endpoint for a project it doesn\'t own');
    await second.shutdown();
    await owner.release();
  } finally {
    for (const folder of [dir, storage, userData]) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
});

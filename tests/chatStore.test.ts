import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore, titleFrom, type StoreSecurity } from '../src/core/chat/store';
import { ownerOnlyProblem } from '../src/core/userHandshake';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-chat-store-'));
const restricted: string[] = [];
const fakeSecurity: StoreSecurity = { restrict: async file => { restricted.push(path.basename(file)); }, problem: async () => undefined };

test('a chat log only grows: events append in order, and a torn last line is skipped', async () => {
  const dir = scratch();
  try {
    const store = new ChatStore(dir, fakeSecurity);
    const chat = await store.create({ provider: 'claude', cwd: dir, providerSessionId: undefined });
    await store.append(chat.id, [{ type: 'user', text: 'hi' }, { type: 'text', delta: 'he', block: 'a' }]);
    await store.append(chat.id, [{ type: 'text', delta: 'llo', block: 'a' }, { type: 'done', status: 'success' }]);
    fs.appendFileSync(path.join(dir, `${chat.id}.jsonl`), '{"t":"2026-10-03T00:00:00Z","event":{"type":"te');
    const log = await store.read(chat.id);
    assert.deepEqual(log.map(entry => entry.event.type), ['user', 'text', 'text', 'done']);
    const reread = await new ChatStore(dir, fakeSecurity).read(chat.id);
    assert.equal(reread.length, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the index keeps each chat\'s provider session id for resume, and survives a restart', async () => {
  const dir = scratch();
  try {
    const store = new ChatStore(dir, fakeSecurity);
    const chat = await store.create({ provider: 'codex', cwd: dir, sandbox: 'read-only' });
    await store.update(chat.id, { providerSessionId: 'thr_123', title: titleFrom('  Fix the\nflaky   test in auth please  ') });
    await store.flush(); // updates are saved shortly after; the app flushes before it quits
    const again = new ChatStore(dir, fakeSecurity);
    const [record] = await again.list();
    assert.equal(record!.providerSessionId, 'thr_123');
    assert.equal(record!.title, 'Fix the flaky test in auth please');
    assert.equal(record!.sandbox, 'read-only');
    assert.equal(titleFrom('x'.repeat(200)).length, 80);
    await again.remove(chat.id);
    assert.deepEqual(await new ChatStore(dir, fakeSecurity).list(), []);
    assert.equal(fs.existsSync(path.join(dir, `${chat.id}.jsonl`)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every chat file is restricted before anything is written, and a file that isn\'t private is refused', async () => {
  const dir = scratch();
  try {
    restricted.length = 0;
    const store = new ChatStore(dir, fakeSecurity);
    const chat = await store.create({ provider: 'claude', cwd: dir });
    assert.ok(restricted.length >= 2, 'the log and the index were restricted');
    assert.ok(restricted.every(name => name.endsWith('.tmp')), 'each was restricted while still empty, before it was moved into place');
    const leaky = new ChatStore(dir, { restrict: async () => undefined, problem: async () => 'others can read it.' });
    await assert.rejects(leaky.list(), /won't use its chat index: others can read it/);
    const fresh = new ChatStore(scratch(), { restrict: async () => undefined, problem: async () => 'others can read it.' });
    await assert.rejects(fresh.create({ provider: 'claude', cwd: dir }), /couldn't make a chat file private/);
    assert.ok(chat.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ids are checked: no path in a chat id, no relative folder, no unknown provider', async () => {
  const dir = scratch();
  try {
    const store = new ChatStore(dir, fakeSecurity);
    await assert.rejects(store.append('../index', [{ type: 'user', text: 'x' }]), /Not a chat id|No such chat/);
    await assert.rejects(store.read('..\\..\\x'), /Not a chat id/);
    await assert.rejects(store.create({ provider: 'claude', cwd: 'relative' }), /isn't valid/);
    await assert.rejects(store.create({ provider: 'bash' as never, cwd: dir }), /isn't valid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('on Windows, chat logs and the index are readable only by the user', { skip: process.platform !== 'win32' }, async () => {
  const dir = scratch();
  try {
    const store = new ChatStore(dir);
    const chat = await store.create({ provider: 'claude', cwd: dir });
    await store.append(chat.id, [{ type: 'user', text: 'secret plans' }]);
    assert.equal(await ownerOnlyProblem(path.join(dir, `${chat.id}.jsonl`)), undefined);
    assert.equal(await ownerOnlyProblem(path.join(dir, 'index.json')), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('after a crash leaves half a line, the next entries are kept, not swallowed', async () => {
  const dir = scratch();
  try {
    const store = new ChatStore(dir, fakeSecurity);
    const chat = await store.create({ provider: 'claude', cwd: dir });
    await store.append(chat.id, [{ type: 'user', text: 'a' }]);
    fs.appendFileSync(path.join(dir, `${chat.id}.jsonl`), '{"t":"2026-10-03T00:00:00Z","event":{"type":"te');
    const restarted = new ChatStore(dir, fakeSecurity);
    await restarted.append(chat.id, [{ type: 'user', text: 'after crash' }]);
    await restarted.append(chat.id, [{ type: 'user', text: 'later' }]);
    assert.deepEqual((await restarted.read(chat.id)).map(entry => (entry.event as { text: string }).text), ['a', 'after crash', 'later']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

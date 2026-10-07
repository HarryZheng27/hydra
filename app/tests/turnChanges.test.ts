import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCall, type ChatEvent } from '../src/shared/ipc';
import { foldEvents } from '../src/renderer/chatModel';
import { ChangeCard, changeTitle, changeTotals } from '../src/renderer/ChangeCard';
import { TurnSnapshots, folderRelative } from '../src/main/turnSnapshots';
import { ChatManager, pendingUndone, undoNote } from '../src/main/chats';
import { ChatStore, type StoreSecurity } from '../../src/core/chat/store';
import type { Launch, ProcessHandlers } from '../../src/core/chat/session';

const CHAT = '0a1b2c3d-0000-4000-8000-000000000001';
const scratch = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-turn-'));
  const folder = path.join(root, 'project');
  fs.mkdirSync(folder);
  return { root, folder, snapshots: new TurnSnapshots(path.join(root, 'snapshots')), done: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
};
const write = (folder: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); fs.writeFileSync(path.join(folder, file), text); };
const read = (folder: string, file: string) => fs.readFileSync(path.join(folder, file), 'utf8');

test('a snapshot and its numstat list the files a turn changed, in a plain folder and in a git repository', async () => {
  for (const asRepo of [false, true]) {
    const { folder, snapshots, done } = scratch();
    try {
      if (asRepo) assert.equal(spawnSync('git', ['init', '-q'], { cwd: folder, windowsHide: true }).status, 0);
      write(folder, 'a.txt', 'one\ntwo\n');
      write(folder, 'sub/b.txt', 'keep\n');
      write(folder, 'gone.txt', 'bye\n');
      const before = await snapshots.snapshot(CHAT, folder);
      assert.ok(before);
      write(folder, 'a.txt', 'one\nTWO\nthree\n');
      write(folder, 'new.txt', 'x\ny\nz\n');
      fs.rmSync(path.join(folder, 'gone.txt'));
      const after = await snapshots.snapshot(CHAT, folder);
      assert.ok(after && after !== before);
      // Absolute and folder-relative paths both name a file; a path outside the folder is ignored.
      const files = await snapshots.changes(CHAT, folder, before, after, [path.join(folder, 'a.txt'), 'new.txt', 'gone.txt', 'sub/b.txt', path.join(path.dirname(folder), 'elsewhere.txt'), '../x']);
      assert.deepEqual(files, [{ path: 'a.txt', kind: 'update', added: 2, removed: 1 }, { path: 'new.txt', kind: 'add', added: 3, removed: 0 }, { path: 'gone.txt', kind: 'delete', added: 0, removed: 1 }]);
      // Only the file-change paths are listed: edited files nobody named stay out of the card.
      assert.deepEqual((await snapshots.changes(CHAT, folder, before, after, ['new.txt'])).map(file => file.path), ['new.txt']);
      assert.deepEqual(await snapshots.changes(CHAT, folder, before, after, ['sub/b.txt']), []);
    } finally { done(); }
  }
});

test('the folder\'s .gitignore applies, binary files carry no counts, and an unchanged turn lists nothing', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    write(folder, '.gitignore', 'ignored.txt\n');
    const before = await snapshots.snapshot(CHAT, folder);
    write(folder, 'ignored.txt', 'secret\n');
    fs.writeFileSync(path.join(folder, 'pic.bin'), Buffer.from([0, 1, 2, 0, 3]));
    const after = await snapshots.snapshot(CHAT, folder);
    const files = await snapshots.changes(CHAT, folder, before!, after!, ['ignored.txt', 'pic.bin']);
    assert.deepEqual(files, [{ path: 'pic.bin', kind: 'add' }]);
    assert.deepEqual(await snapshots.changes(CHAT, folder, after!, after!, ['pic.bin']), []);
    assert.equal(await snapshots.snapshot(CHAT, folder), after, 'the same folder gives the same tree');
  } finally { done(); }
});

test('a nested repository already in a snapshot is left out of the next one\'s add', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    const nested = path.join(folder, 'inner');
    fs.mkdirSync(nested);
    for (const args of [['init', '-q'], ['config', 'user.email', 't@example.invalid'], ['config', 'user.name', 'T']]) spawnSync('git', args, { cwd: nested, windowsHide: true });
    write(nested, 'f.txt', 'one\n');
    spawnSync('git', ['add', '.'], { cwd: nested, windowsHide: true });
    spawnSync('git', ['commit', '-q', '-m', 'first'], { cwd: nested, windowsHide: true });
    assert.ok(await snapshots.snapshot(CHAT, folder));
    // The nested repository's own clean filter would run if git looked inside it again.
    const marker = path.join(path.dirname(folder), 'pwned-nested');
    spawnSync('git', ['config', 'filter.p.clean', `echo pwned > "${marker.replace(/\\/g, '/')}"; cat`], { cwd: nested, windowsHide: true });
    write(nested, '.gitattributes', '* filter=p\n');
    // A same-size change, after the index's timestamp has passed: git has to hash the file to see it.
    await new Promise(resolve => setTimeout(resolve, 1100));
    write(nested, 'f.txt', 'two\n');
    assert.ok(await snapshots.snapshot(CHAT, folder));
    assert.equal(fs.existsSync(marker), false, 'nothing the nested repository names ran');
  } finally { done(); }
});

test('undo restores edited files, deletes added ones and brings back deleted ones', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    write(folder, 'a.txt', 'original\n');
    write(folder, 'gone.txt', 'bye\n');
    const before = (await snapshots.snapshot(CHAT, folder))!;
    write(folder, 'a.txt', 'changed\n');
    write(folder, 'deep/new/n.txt', 'fresh\n');
    fs.rmSync(path.join(folder, 'gone.txt'));
    const after = (await snapshots.snapshot(CHAT, folder))!;
    const files = (await snapshots.changes(CHAT, folder, before, after, ['a.txt', 'deep/new/n.txt', 'gone.txt'])).map(file => file.path);
    const result = await snapshots.undo(CHAT, folder, before, after, files);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.restored.sort(), ['a.txt', 'deep/new/n.txt', 'gone.txt']);
    assert.equal(read(folder, 'a.txt'), 'original\n');
    assert.equal(read(folder, 'gone.txt'), 'bye\n');
    assert.equal(fs.existsSync(path.join(folder, 'deep/new/n.txt')), false);
    assert.equal(fs.existsSync(path.join(folder, 'a.txt.hydra-undo')), false, 'no scratch file is left');
  } finally { done(); }
});

test('undo leaves a file alone that changed after the turn, and says which', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    write(folder, 'a.txt', 'one\n');
    write(folder, 'b.txt', 'one\n');
    write(folder, 'c.txt', 'one\n');
    const before = (await snapshots.snapshot(CHAT, folder))!;
    write(folder, 'a.txt', 'two\n');
    write(folder, 'b.txt', 'two\n');
    fs.rmSync(path.join(folder, 'c.txt'));
    write(folder, 'd.txt', 'added\n');
    const after = (await snapshots.snapshot(CHAT, folder))!;
    write(folder, 'b.txt', 'two, then the user\'s own edit\n');
    write(folder, 'c.txt', 'the user made it again\n');
    write(folder, 'd.txt', 'added, then edited\n');
    const result = await snapshots.undo(CHAT, folder, before, after, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    assert.deepEqual(result.restored, ['a.txt']);
    assert.deepEqual(result.skipped.map(skip => skip.path).sort(), ['b.txt', 'c.txt', 'd.txt']);
    assert.equal(read(folder, 'a.txt'), 'one\n');
    assert.equal(read(folder, 'b.txt'), 'two, then the user\'s own edit\n');
    assert.equal(read(folder, 'c.txt'), 'the user made it again\n');
    assert.equal(read(folder, 'd.txt'), 'added, then edited\n');
  } finally { done(); }
});

test('undo refuses paths outside the folder and never writes through a link', async () => {
  const { root, folder, snapshots, done } = scratch();
  try {
    write(folder, 'a.txt', 'one\n');
    const before = (await snapshots.snapshot(CHAT, folder))!;
    write(folder, 'a.txt', 'two\n');
    const after = (await snapshots.snapshot(CHAT, folder))!;
    fs.writeFileSync(path.join(root, 'outside.txt'), 'two\n');
    const result = await snapshots.undo(CHAT, folder, before, after, ['../outside.txt', 'a.txt/../../outside.txt', path.join(root, 'outside.txt')]);
    assert.deepEqual(result.restored, []);
    assert.equal(result.skipped.length, 3);
    assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'two\n');
    assert.equal(folderRelative(folder, path.join(folder, 'x', '..', 'y.txt')), 'y.txt');
    assert.equal(folderRelative(folder, folder), undefined);
  } finally { done(); }
});

test('a missing snapshot repository fails safe: no card, no undo, no diff', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    write(folder, 'a.txt', 'one\n');
    const before = (await snapshots.snapshot(CHAT, folder))!;
    write(folder, 'a.txt', 'two\n');
    const after = (await snapshots.snapshot(CHAT, folder))!;
    await snapshots.remove(CHAT);
    await assert.rejects(snapshots.undo(CHAT, folder, before, after, ['a.txt']), /no longer has the snapshots/);
    await assert.rejects(snapshots.diffFile(CHAT, folder, before, after, 'a.txt', 'update'), /no longer has the snapshots/);
    assert.deepEqual(await snapshots.changes(CHAT, folder, before, after, ['a.txt']), []);
    assert.equal(read(folder, 'a.txt'), 'two\n');
    // A snapshot of a folder that isn't there gives nothing, and doesn't throw.
    assert.equal(await snapshots.snapshot(CHAT, path.join(folder, 'missing')), undefined);
    await assert.rejects(snapshots.undo('not a chat id', folder, before, after, ['a.txt']), /Not a chat id/);
  } finally { done(); }
});

test('a turn\'s diff of one file is its before and after text, capped in size', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    write(folder, 'a.txt', 'one\n');
    write(folder, 'big.txt', 'x');
    const before = (await snapshots.snapshot(CHAT, folder))!;
    write(folder, 'a.txt', 'two\n');
    write(folder, 'big.txt', 'x'.repeat(1024 * 1024 + 10));
    write(folder, 'new.txt', 'hello\n');
    const after = (await snapshots.snapshot(CHAT, folder))!;
    assert.deepEqual(await snapshots.diffFile(CHAT, folder, before, after, 'a.txt', 'update'), { path: 'a.txt', status: 'modified', original: 'one\n', modified: 'two\n' });
    assert.deepEqual(await snapshots.diffFile(CHAT, folder, before, after, 'new.txt', 'add'), { path: 'new.txt', status: 'added', original: '', modified: 'hello\n' });
    assert.equal((await snapshots.diffFile(CHAT, folder, before, after, 'big.txt', 'update')).skipped, 'over 1 MB');
  } finally { done(); }
});

test('the change events fold into one card after their turn, and undone marks it', () => {
  const files = [{ path: 'src/a.ts', kind: 'update' as const, added: 3, removed: 1 }, { path: 'b.md', kind: 'add' as const, added: 2, removed: 0 }];
  const events: ChatEvent[] = [
    { type: 'user', text: 'go' }, { type: 'text', delta: 'done', block: '1' }, { type: 'done', status: 'success' },
    // A queued message's turn has already begun when the card for the first one is written.
    { type: 'user', text: 'again' },
    { type: 'turn-changes', changeId: 'abcd1234', turn: 1, before: 'a'.repeat(40), after: 'b'.repeat(40), files },
  ];
  const kinds = (list: ChatEvent[]) => foldEvents(list).items.map(item => item.kind);
  assert.deepEqual(kinds(events), ['user', 'text', 'turn-end', 'changes', 'user']);
  const undone = foldEvents([...events, { type: 'turn-undone', changeId: 'abcd1234', files: ['b.md'], skipped: [{ path: 'src/a.ts', reason: 'edited since' }] }]);
  const card = undone.items.find(item => item.kind === 'changes');
  assert.ok(card && card.kind === 'changes');
  assert.deepEqual(card.undone, { files: ['b.md'], skipped: [{ path: 'src/a.ts', reason: 'edited since' }] });
  assert.equal(undone.running, true, 'the second turn is still running');
  // A card whose turn hasn't ended yet goes at the end.
  assert.deepEqual(kinds([{ type: 'user', text: 'go' }, { type: 'turn-changes', changeId: 'abcd1234', turn: 1, before: 'a'.repeat(40), after: 'b'.repeat(40), files }]), ['user', 'changes']);
  // Events from before this feature, and unknown ones, fold as they did.
  assert.deepEqual(kinds([{ type: 'turn-undone', changeId: 'nothing', files: [], skipped: [] }]), []);
});

test('the card says Edited N files with the turn\'s totals, per-file rows, and the Undone state', () => {
  const files = [{ path: 'src/core/helperService.ts', kind: 'update' as const, added: 8, removed: 2 }, { path: 'tests/hardening.test.ts', kind: 'add' as const, added: 31, removed: 0 }, { path: 'logo.png', kind: 'add' as const }];
  assert.equal(changeTitle(1), 'Edited 1 file');
  assert.equal(changeTitle(2), 'Edited 2 files');
  assert.deepEqual(changeTotals(files), { added: 39, removed: 2 });
  const html = renderToStaticMarkup(createElement(ChangeCard, { card: { changeId: 'c1', files }, onOpen: () => undefined, onUndo: async () => undefined }));
  assert.match(html, /Edited 3 files/);
  assert.match(html, />Undo</);
  assert.match(html, /<span class="add">\+39<\/span> <span class="del">-2<\/span>/);
  assert.match(html, /helperService\.ts/);
  assert.match(html, /title="tests\/hardening\.test\.ts"/);
  assert.match(html, /<span class="add">\+31<\/span> <span class="del">-0<\/span>/);
  assert.equal((html.match(/class="change-row"/g) ?? []).length, 3);
  const single = renderToStaticMarkup(createElement(ChangeCard, { card: { changeId: 'c2', files: [files[0]!] }, onOpen: () => undefined }));
  assert.match(single, /Edited 1 file</);
  assert.match(single, /disabled=""[^>]*>Undo</, 'Undo is off when the chat can\'t undo');
  const undone = renderToStaticMarkup(createElement(ChangeCard, { card: { changeId: 'c1', files, undone: { files: ['logo.png'], skipped: [{ path: 'src/core/helperService.ts', reason: 'edited since' }] } }, onOpen: () => undefined, onUndo: async () => undefined }));
  assert.match(undone, /Undone/);
  assert.doesNotMatch(undone, />Undo</);
  assert.match(undone, /helperService\.ts \(edited since\)/);
});

// ---- the chat manager's side: snapshot before the message, card after the turn, Undo, and the agent's note ----

const noAcl: StoreSecurity = { restrict: async () => undefined, problem: async () => undefined };
function fakeLaunch() {
  const starts: Array<{ handlers: ProcessHandlers; written: string[] }> = [];
  const launch: Launch = (_executable, _args, _cwd, handlers) => {
    const entry = { handlers, written: [] as string[] };
    starts.push(entry);
    return { write: line => { entry.written.push(line); }, kill: () => setTimeout(() => handlers.exit(0), 1) };
  };
  return { starts, launch };
}
const settle = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 50)); };

test('a turn that edits a file gets a card; Undo restores it, records it, and the next message tells the agent without showing it', async () => {
  const { root, folder, snapshots, done } = scratch();
  try {
    write(folder, 'a.txt', 'one\n');
    const pushed: ChatEvent[] = [];
    const { starts, launch } = fakeLaunch();
    const manager = new ChatManager({ store: new ChatStore(path.join(root, 'chats'), noAcl), launch, executable: async () => 'claude.exe', trusted: async () => true, push: (_id, events) => pushed.push(...events), snapshots });
    const chat = await manager.create({ cwd: folder, provider: 'claude' });
    await manager.send(chat.id, 'edit a');
    const say = (message: unknown) => starts[0]!.handlers.line(JSON.stringify(message));
    say({ type: 'system', subtype: 'init', session_id: chat.providerSessionId });
    say({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'w1', name: 'Edit', input: { file_path: path.join(folder, 'a.txt') } }, { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: path.join(folder, 'untouched.txt') } }] } });
    write(folder, 'a.txt', 'two\nmore\n');
    say({ type: 'result', subtype: 'success', usage: {} });
    await settle(() => pushed.some(event => event.type === 'turn-changes'));
    const card = pushed.find((event): event is Extract<ChatEvent, { type: 'turn-changes' }> => event.type === 'turn-changes');
    assert.ok(card, 'the card was written');
    assert.equal(card.turn, 1);
    assert.deepEqual(card.files, [{ path: 'a.txt', kind: 'update', added: 2, removed: 1 }], 'only a file that really changed is listed');
    assert.deepEqual((await manager.turnDiff(chat.id, card.changeId, 'a.txt')).modified, 'two\nmore\n');
    await assert.rejects(manager.turnDiff(chat.id, card.changeId, 'other.txt'), /isn't in this change/);
    await assert.rejects(manager.undoTurn(chat.id, 'ffffffff'), /isn't in this chat/);

    const result = await manager.undoTurn(chat.id, card.changeId);
    assert.deepEqual(result.restored, ['a.txt']);
    assert.equal(read(folder, 'a.txt'), 'one\n');
    assert.ok(pushed.some(event => event.type === 'turn-undone' && event.changeId === card.changeId));
    await assert.rejects(manager.undoTurn(chat.id, card.changeId), /undone already/);

    // The next message carries a note for the agent, and the bubble the user sees doesn't.
    await manager.send(chat.id, 'thanks');
    const sent = starts[0]!.written.filter(line => line.includes('thanks')).join('');
    assert.match(sent, /undid your changes to this file/);
    assert.match(sent, /a\.txt/);
    await settle(() => pushed.filter(event => event.type === 'user').length === 2);
    const bubbles = pushed.filter((event): event is Extract<ChatEvent, { type: 'user' }> => event.type === 'user').map(event => event.text);
    assert.deepEqual(bubbles, ['edit a', 'thanks']);
    assert.deepEqual(foldEvents((await manager.open(chat.id, { warm: false })).log.map(entry => entry.event)).items.filter(item => item.kind === 'changes').map(item => item.kind === 'changes' && item.undone?.files), [['a.txt']]);
    manager.closeAll();
  } finally { done(); }
});

test('Undo waits while the chat is working, and a chat without snapshots has no card or undo', async () => {
  const { root, folder, snapshots, done } = scratch();
  try {
    const pushed: ChatEvent[] = [];
    const { starts, launch } = fakeLaunch();
    const manager = new ChatManager({ store: new ChatStore(path.join(root, 'chats'), noAcl), launch, executable: async () => 'claude.exe', trusted: async () => true, push: (_id, events) => pushed.push(...events), snapshots });
    const chat = await manager.create({ cwd: folder, provider: 'claude' });
    await manager.send(chat.id, 'work');
    await assert.rejects(manager.undoTurn(chat.id, 'abcdef12'), /finish its turn/);
    starts[0]!.handlers.line(JSON.stringify({ type: 'result', subtype: 'success', usage: {} }));
    manager.closeAll();
    const plain = new ChatManager({ store: new ChatStore(path.join(root, 'chats2'), noAcl), launch: fakeLaunch().launch, executable: async () => 'claude.exe', trusted: async () => true, push: () => undefined });
    await assert.rejects(plain.undoTurn('abcdef12', 'abcdef12'), /isn't available/);
  } finally { done(); }
});

test('the agent\'s note names the files, and only undone turns after the last message are pending', () => {
  assert.match(undoNote(['a.txt', 'b\nc.txt']), /^\[The user undid your changes to these files .*: a\.txt, b\?c\.txt\.\]\n\n$/);
  assert.match(undoNote(Array.from({ length: 25 }, (_, i) => `f${i}.txt`)), /and 5 more/);
  const undone = (path: string): ChatEvent => ({ type: 'turn-undone', changeId: 'abcd1234', files: [path], skipped: [] });
  assert.deepEqual(pendingUndone([{ event: undone('old.txt') }, { event: { type: 'user', text: 'told' } }, { event: undone('a.txt') }, { event: undone('b.txt') }]), ['a.txt', 'b.txt']);
  assert.deepEqual(pendingUndone([{ event: { type: 'user', text: 'told' } }]), []);
});

test('the undo and diff channels take a chat id, a change id and a file path, and nothing else', () => {
  const ok = (channel: string, payload: unknown) => parseCall({ channel, payload }).ok;
  const id = '0a1b2c3d-0000-4000-8000-000000000001';
  assert.equal(ok('chats.undoTurn', { id, changeId: id }), true);
  assert.equal(ok('chats.undoTurn', { id, changeId: '../x' }), false);
  assert.equal(ok('chats.undoTurn', { id, changeId: id, extra: 1 }), false);
  assert.equal(ok('chats.turnDiff', { id, changeId: id, path: 'src/a.ts' }), true);
  assert.equal(ok('chats.turnDiff', { id, changeId: id, path: 'a\u0000b' }), false);
  assert.equal(ok('chats.turnDiff', { id, changeId: id }), false);
});

test('snapshots keep bytes exactly, keep working beside a nested repository, and undo never writes through a planted scratch name', async () => {
  const { folder, snapshots, done } = scratch();
  try {
    write(folder, '.gitattributes', '* text=auto eol=lf\n');
    fs.writeFileSync(path.join(folder, 'crlf.txt'), 'one\r\ntwo\r\n');
    fs.writeFileSync(path.join(folder, 'a.txt.hydra-undo'), 'a real user file\n');
    const nested = path.join(folder, 'inner');
    fs.mkdirSync(nested);
    spawnSync('git', ['init', '-q'], { cwd: nested, windowsHide: true });
    write(nested, 'x.txt', 'x\n');
    const before = (await snapshots.snapshot(CHAT, folder))!;
    assert.ok(before);
    write(folder, 'crlf.txt', 'one\r\nTWO\r\n');
    write(folder, 'a.txt', 'new\n');
    const after = (await snapshots.snapshot(CHAT, folder))!;
    assert.notEqual(after, before, 'a nested repository does not freeze the snapshots');
    const result = await snapshots.undo(CHAT, folder, before, after, ['crlf.txt', 'a.txt']);
    assert.deepEqual(result.skipped, []);
    assert.equal(fs.readFileSync(path.join(folder, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\n');
    assert.equal(fs.readFileSync(path.join(folder, 'a.txt.hydra-undo'), 'utf8'), 'a real user file\n');
    assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.hydra-undo')), ['a.txt.hydra-undo'], 'no scratch file is left');
  } finally { done(); }
});

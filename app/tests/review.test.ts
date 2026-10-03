import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHandlers } from '../src/main/handlers';
import { MAX_REVIEW_BYTES, openInEditor, workingTreeDiff } from '../src/main/review';
import { ChatPane } from '../src/renderer/ChatPane';

const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-review-'));
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  return { dir, git };
};

test('the review lists the working tree against HEAD: changed, added, deleted and untracked, with their text', async () => {
  const { dir, git } = repo();
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'two\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.writeFileSync(path.join(dir, 'staged.md'), '# staged\n');
    git('add', 'staged.md');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_REVIEW_BYTES + 10));
    const result = await workingTreeDiff(dir);
    const byPath = Object.fromEntries(result.files.map(file => [file.path, file]));
    assert.equal(byPath['a.ts']!.status, 'modified');
    assert.equal(byPath['a.ts']!.original.replace(/\r/g, ''), 'one\n');
    assert.equal(byPath['a.ts']!.modified.replace(/\r/g, ''), 'two\n');
    assert.equal(byPath['gone.txt']!.status, 'deleted');
    assert.equal(byPath['staged.md']!.status, 'added');
    assert.equal(byPath['new.txt']!.status, 'untracked');
    assert.equal(byPath['blob.bin']!.skipped, 'binary');
    assert.equal(byPath['big.txt']!.skipped, 'over 1 MB');
    assert.equal(result.truncated, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a project\'s own git config can\'t make the review run a program', async () => {
  const { dir, git } = repo();
  const marker = path.join(dir, 'ran.txt');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const script = path.join(dir, 'evil.cmd');
    fs.writeFileSync(script, `@echo ran> "${marker}"\r\n`);
    git('config', 'diff.external', script.replace(/\\/g, '/'));
    git('config', 'diff.evil.textconv', script.replace(/\\/g, '/'));
    git('config', 'core.fsmonitor', script.replace(/\\/g, '/'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    const result = await workingTreeDiff(dir);
    assert.ok(result.files.some(file => file.path === 'a.txt'));
    assert.equal(fs.existsSync(marker), false, 'a program from the repository\'s config ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a folder that isn\'t a repository says so; Open in editor stays inside the folder', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-plain-'));
  const { dir } = repo();
  try {
    assert.match((await workingTreeDiff(plain)).error ?? '', /isn't a git repository/);
    await assert.rejects(openInEditor(dir, '../outside.txt', () => undefined), /isn't in this folder/);
    const shown: string[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath); // no editor on PATH: the file is only shown in its folder
    try { assert.equal(await openInEditor(dir, 'a.ts', file => shown.push(file)), 'folder'); } finally { process.env.PATH = savedPath; }
    assert.deepEqual(shown, [path.resolve(dir, 'a.ts')]);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Open in editor takes only a file the current diff lists', async () => {
  const opened: string[] = [];
  const store = { load: async () => ({ version: 1, theme: 'system', cliPaths: {} }) } as never;
  const handlers = createHandlers({
    info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' }, settings: store, state: store,
    pickFolder: async () => undefined, pickExecutable: async () => undefined, applyTheme: () => undefined,
    checkSetup: async () => { throw new Error('unused'); }, signIn: async () => ({ started: false }), confirmTrust: async () => false,
    chats: { reviewFolder: async () => 'C:\\repo' } as never,
    review: { diff: async () => ({ files: [{ path: 'src/a.ts', status: 'modified', original: '', modified: '' }], truncated: false }), open: async (_cwd, file) => { opened.push(file); return 'folder'; } },
  });
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.deepEqual(await handlers['review.open']({ id, path: 'src/a.ts' }), { opened: 'folder' });
  await assert.rejects(async () => handlers['review.open']({ id, path: 'run-me.bat' }), /isn't among this folder's changes/);
  assert.deepEqual(opened, ['src/a.ts']);
});

test('errors say what to do next: a missing CLI leads to Your agents, and a usage limit is named as the plan\'s', () => {
  const record = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', provider: 'codex' as const, cwd: 'C:\\x', title: 't', createdAt: '', updatedAt: '' };
  const page = renderToStaticMarkup(createElement(ChatPane, {
    record, onSend: () => undefined, onAnswer: () => undefined, onStop: () => undefined, onConfigure: () => undefined, onOpenTerminal: () => undefined,
    events: [
      { type: 'user', text: 'hi' }, { type: 'error', message: 'The CLI isn\'t installed where Hydra looked.', fatal: true, code: 'missing-cli' }, { type: 'done', status: 'error' },
      { type: 'user', text: 'again' }, { type: 'error', message: 'You\'ve hit your usage limit.', fatal: false, code: 'limit' }, { type: 'done', status: 'error' },
    ],
  }));
  assert.match(page, /Open Your agents/);
  assert.match(page, /Codex has reached your plan&#x27;s usage limit/);
});

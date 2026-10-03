import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHandlers } from '../src/main/handlers';
import { MAX_REVIEW_BYTES, changedPaths, openInEditor, workingTreeDiff } from '../src/main/review';
import { ChatPane } from '../src/renderer/ChatPane';

/** PATH with git and node but no editor, so Open in editor finds only what a test puts there. */
const gitOnlyPath = (...first: string[]) => {
  const git = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)[0]!.trim();
  return [...first, path.dirname(git), path.dirname(process.execPath)].join(path.delimiter);
};

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

test('a repository\'s clean and process filters don\'t run when the review hashes a changed file', async () => {
  const { dir, git } = repo();
  const marker = path.join(dir, 'ran.txt');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const script = path.join(dir, 'evil.cmd');
    fs.writeFileSync(script, `@echo ran> "${marker}"\r\n@more\r\n`);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'a.txt filter=one\nb.txt filter=two\n');
    git('config', 'filter.one.clean', script.replace(/\\/g, '/'));
    git('config', 'filter.two.process', script.replace(/\\/g, '/'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    const past = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(dir, 'a.txt'), past, past); // stat-dirty, so git hashes them
    fs.utimesSync(path.join(dir, 'b.txt'), past, past);
    const result = await workingTreeDiff(dir);
    assert.ok(result.files.some(file => file.path === 'a.txt'));
    assert.equal(fs.existsSync(marker), false, 'a filter from the repository\'s config ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the review covers only the chat folder: a subfolder\'s chat, a work tree moved elsewhere, a junction that leads out', async () => {
  const { dir, git } = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-outside-'));
  const elsewhere = repo();
  try {
    fs.mkdirSync(path.join(dir, 'sub', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'docs', 'readme.md'), 'inside\n');
    fs.writeFileSync(path.join(dir, 'top.txt'), 'top\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(dir, 'top.txt'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'sub', 'mine.txt'), 'mine\n');
    assert.deepEqual(await changedPaths(path.join(dir, 'sub')), ['sub/mine.txt']);
    await assert.rejects(openInEditor(path.join(dir, 'sub'), 'top.txt', () => undefined), /isn't in this folder/);

    fs.writeFileSync(path.join(outside, 'readme.md'), 'secret\n');
    fs.rmSync(path.join(dir, 'sub', 'docs'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'sub', 'docs'), 'junction');
    const files = (await workingTreeDiff(path.join(dir, 'sub'))).files;
    assert.ok(!files.some(file => file.modified.includes('secret')), 'the review read a file through a junction');

    fs.writeFileSync(path.join(outside, 'id_rsa'), 'key\n');
    elsewhere.git('config', 'core.worktree', outside.replace(/\\/g, '/'));
    const moved = await workingTreeDiff(elsewhere.dir);
    assert.equal(moved.files.length, 0);
    assert.match(moved.error ?? '', /somewhere else|isn't a git repository/);
  } finally {
    fs.rmSync(path.join(dir, 'sub', 'docs'), { recursive: true, force: true });
    for (const folder of [dir, outside, elsewhere.dir]) fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Open in editor gives a .cmd launcher no file name cmd.exe would read as commands', { skip: process.platform !== 'win32' }, async () => {
  const { dir } = repo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrabin'));
  const marker = path.join(dir, 'ran.txt');
  try {
    fs.writeFileSync(path.join(bin, 'hydra.cmd'), '@exit /b 0\r\n');
    fs.writeFileSync(path.join(dir, 'evil.bat'), `@echo ran> "${marker}"\r\n`);
    const shown: string[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = gitOnlyPath(bin);
    try {
      for (const name of ['x&evil', 'y%PATH%.txt']) {
        fs.writeFileSync(path.join(dir, name), 'hi\n');
        assert.equal(await openInEditor(dir, name, file => shown.push(file)), 'folder');
      }
    } finally { process.env.PATH = savedPath; }
    assert.equal(shown.length, 2);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(fs.existsSync(marker), false, 'cmd.exe ran a program named in the file name');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('a folder that isn\'t a repository says so; Open in editor stays inside the folder', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-plain-'));
  const { dir } = repo();
  try {
    assert.match((await workingTreeDiff(plain)).error ?? '', /isn't a git repository/);
    await assert.rejects(openInEditor(dir, '../outside.txt', () => undefined), /isn't in this folder/);
    const shown: string[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = gitOnlyPath(); // no editor on PATH: the file is only shown in its folder
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
    review: { diff: async () => { throw new Error('the check lists names only'); }, changed: async () => ['src/a.ts'], open: async (_cwd, file) => { opened.push(file); return 'folder'; } },
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHandlers } from '../src/main/handlers';
import { MAX_REVIEW_BYTES, branchSummary, changedPaths, githubRepoName, openInEditor, workingTreeDiff } from '../src/main/review';
import { createPrPrompt } from '../src/renderer/BranchBar';
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
    fs.writeFileSync(path.join(dir, 'c.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const script = path.join(dir, 'evil.cmd');
    fs.writeFileSync(script, `@echo ran> "${marker}"\r\n@more\r\n`);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'a.txt filter=one\nb.txt filter=two\n');
    git('config', 'filter.one.clean', script.replace(/\\/g, '/'));
    git('config', 'filter.two.process', script.replace(/\\/g, '/'));
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'a.txt filter=one\nb.txt filter=two\nc.txt filter=\n');
    fs.appendFileSync(path.join(dir, '.git', 'config'), `[filter ""]\n\tclean = ${script.replace(/\\/g, '/')}\n`);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'two\n');
    const past = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(dir, 'a.txt'), past, past); // stat-dirty, so git hashes them
    fs.utimesSync(path.join(dir, 'b.txt'), past, past);
    fs.utimesSync(path.join(dir, 'c.txt'), past, past);
    const result = await workingTreeDiff(dir);
    assert.ok(result.files.some(file => file.path === 'a.txt'));
    assert.equal(fs.existsSync(marker), false, 'a filter from the repository\'s config ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the review never fetches a partial clone\'s missing objects, which would run the remote\'s upload-pack', async () => {
  const source = repo();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-partial-'));
  const marker = path.join(clone, 'ran.txt');
  try {
    fs.writeFileSync(path.join(source.dir, 'f.txt'), 'one\n');
    source.git('add', '.');
    source.git('commit', '-q', '-m', 'first');
    source.git('config', 'uploadpack.allowFilter', 'true');
    const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: clone, encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); };
    git('clone', '-q', '--no-checkout', '--filter=blob:none', `file://${source.dir.replace(/\\/g, '/')}`, 'c');
    const dir = path.join(clone, 'c');
    spawnSync('git', ['read-tree', 'HEAD'], { cwd: dir, windowsHide: true });
    const script = path.join(clone, 'evil.cmd');
    fs.writeFileSync(script, `@echo ran> "${marker}"\r\n`);
    spawnSync('git', ['config', 'remote.origin.uploadpack', script.replace(/\\/g, '/')], { cwd: dir, windowsHide: true });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'two\n');
    const result = await workingTreeDiff(dir);
    assert.ok(result.error || result.files.some(file => file.path === 'f.txt'), 'the review neither listed the change nor said why');
    assert.equal(fs.existsSync(marker), false, 'a lazy fetch ran the remote\'s upload-pack');
  } finally { fs.rmSync(source.dir, { recursive: true, force: true }); fs.rmSync(clone, { recursive: true, force: true }); }
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

    const inner = path.join(elsewhere.dir, 'inner');
    fs.mkdirSync(inner);
    fs.renameSync(path.join(elsewhere.dir, '.git'), path.join(inner, '.git'));
    fs.writeFileSync(path.join(elsewhere.dir, 'id_rsa'), 'key\n');
    fs.writeFileSync(path.join(inner, 'mine.txt'), 'mine\n');
    spawnSync('git', ['config', 'core.worktree', elsewhere.dir.replace(/\\/g, '/')], { cwd: inner, windowsHide: true });
    const scoped = await workingTreeDiff(inner);
    assert.deepEqual(scoped.files.map(file => file.path), ['inner/mine.txt'], 'a work tree above the folder showed a file beside it');
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
    assert.deepEqual(shown, [path.join(fs.realpathSync.native(dir), 'a.ts')]); // the real path (CI's temp folder is an 8.3 short name)
  } finally { fs.rmSync(plain, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Open in editor takes only a file the current diff lists', async () => {
  const opened: string[] = [];
  const store = { load: async () => ({ version: 1, theme: 'system', cliPaths: {} }) } as never;
  const handlers = createHandlers({
    info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' }, settings: store, state: store,
    pickFolder: async () => undefined, pickExecutable: async () => undefined, applyTheme: () => undefined,
    checkSetup: async () => { throw new Error('unused'); }, signIn: async () => ({ signedIn: false }), confirmTrust: async () => false,
    chats: { reviewFolder: async () => 'C:\\repo' } as never,
    review: { diff: async () => { throw new Error('the check lists names only'); }, branch: async () => undefined, changed: async () => ['src/a.ts'], open: async (_cwd, file) => { opened.push(file); return 'folder'; } },
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

test('the branch bar counts a feature branch against the default branch, and offers Create PR only where a PR makes sense', async () => {
  const { dir, git } = repo();
  try {
    git('checkout', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    // On the default branch: no base to compare with, and nothing to open a pull request from.
    const onMain = await branchSummary(dir);
    assert.equal(onMain?.branch, 'main');
    assert.equal(onMain?.canCreatePr, false);
    assert.equal(onMain?.additions, 0);
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree\nfour\n');
    git('commit', '-q', '-am', 'more');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\nthree\nfour\n'); // one line removed, uncommitted
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
    // No remote yet: the lines are counted (committed and uncommitted, against main), but there is nowhere to push.
    const local = await branchSummary(dir);
    assert.deepEqual({ branch: local?.branch, base: local?.base, additions: local?.additions, deletions: local?.deletions, files: local?.files, canCreatePr: local?.canCreatePr },
      { branch: 'feature', base: 'main', additions: 2, deletions: 1, files: 2, canCreatePr: false });
    git('remote', 'add', 'origin', 'https://github.com/someone/shop.git');
    const withRemote = await branchSummary(dir);
    assert.equal(withRemote?.repo, 'shop');
    assert.equal(withRemote?.canCreatePr, true);
    assert.match(createPrPrompt(withRemote!), /branch feature against main.*gh pr create/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the branch bar is absent outside git and with a detached HEAD, and names a GitHub repository from either URL form', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-branch-'));
  const { dir, git } = repo();
  try {
    assert.equal(await branchSummary(plain), undefined);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    git('checkout', '-q', '--detach');
    assert.equal(await branchSummary(dir), undefined);
    assert.equal(githubRepoName('https://github.com/ndunl075/hydra.git'), 'hydra');
    assert.equal(githubRepoName('git@github.com:ndunl075/hydra-cloud-sandbox.git'), 'hydra-cloud-sandbox');
    assert.equal(githubRepoName('https://example.com/x/y.git'), undefined);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

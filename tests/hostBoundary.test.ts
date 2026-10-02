import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeHost } from './host/fakeHost';

/**
 * The controller runs in both the IDE and the Hydra app (docs/internal/hydra-app/G2-host-split.md), so nothing
 * under src/core or src/host may reach for either program's own API: VS Code's goes through src/vscodeHost.ts.
 */
// TypeScript's own scanner lists every import, export-from, require() and import() (including a backtick literal),
// and ignores comments and strings, so neither a glob in a string nor a commented-out line can hide or fake one.
const ts = createRequire(__filename)('typescript') as typeof import('typescript');
function editorImports(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName.split('/')[0]!).filter(name => name === 'vscode' || name === 'electron');
}

async function sources(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await sources(full));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test('the boundary check finds every way of importing vscode or electron', () => {
  assert.deepEqual(editorImports(`import * as vscode from 'vscode';`), ['vscode']);
  assert.deepEqual(editorImports(`import type { Uri } from "vscode";`), ['vscode']);
  assert.deepEqual(editorImports(`const { app } = require('electron');`), ['electron']);
  assert.deepEqual(editorImports(`const main = await import('electron/main');`), ['electron']);
  assert.deepEqual(editorImports(`import 'vscode';`), ['vscode']);
  assert.deepEqual(editorImports(`export { window } from 'vscode';`), ['vscode']);
  assert.deepEqual(editorImports(`// import * as vscode from 'vscode';\n/* require('electron') */\nconst name = 'vscode';`), []);
  assert.deepEqual(editorImports(`import { thing } from './vscodeHost';`), []);
  assert.deepEqual(editorImports(`const glob = 'src/**/*.ts';\nimport * as vscode from 'vscode';\n/* done */`), ['vscode']);
  assert.deepEqual(editorImports('const app = require(`electron`);'), ['electron']);
  assert.deepEqual(editorImports(`const message = "Load plugins from 'vscode'";`), []);
});

test('nothing under src/core or src/host imports vscode or electron', async () => {
  const files = [...await sources(path.join('src', 'core')), ...await sources(path.join('src', 'host'))];
  assert.ok(files.length > 50, 'src/core and src/host were found');
  const offenders: string[] = [];
  for (const file of files) for (const name of editorImports(await readFile(file, 'utf8'))) offenders.push(`${file.split(path.sep).join('/')} imports ${name}`);
  assert.deepEqual(offenders, []);
});

test('the Agents view reaches its host only through the bridge', async () => {
  const index = await readFile(path.join('webview', 'index.tsx'), 'utf8');
  assert.match(index, /hostBridge\(\)/);
  assert.doesNotMatch(index, /acquireVsCodeApi/);
  const bridge = await readFile(path.join('webview', 'bridge.ts'), 'utf8');
  assert.match(bridge, /window\.hydraBridge \?\? acquireVsCodeApi\(\)/);
});

test('FakeHost records what it was asked and answers as scripted', async () => {
  const host = new FakeHost({ storage: '/storage', dist: '/dist' }, { defaultProvider: 'codex' });
  assert.equal(host.settings.get('defaultProvider', 'claude'), 'codex');
  assert.equal(host.settings.get('heads.defaultBudgetUsd', 5), 5);
  assert.equal(host.settings.machine('codexPath'), undefined);
  const changed: boolean[] = [];
  const listening = host.settings.onChange(affects => changed.push(affects('heads'), affects('defaultProvider'), affects('')));
  await host.settings.update('heads.defaultBudgetUsd', 2);
  assert.deepEqual(changed, [true, false, true]);
  listening.dispose();
  host.set('defaultProvider', 'claude');
  assert.equal(changed.length, 3);
  host.answers.set('Delete plan', true);
  host.answers.set('started lane', 'Show lane');
  assert.equal(await host.confirm('Delete plan Build?', 'Delete plan'), true);
  assert.equal(await host.confirm('Cancel job X?', 'Cancel job'), false);
  assert.equal(await host.notify('info', 'Plan P started lane L.', 'Show lane'), 'Show lane');
  assert.equal(await host.notify('info', 'Something else.', 'OK'), undefined);
  await host.postToUi({ type: 'heads', heads: [] });
  host.log('[heads] ready');
  assert.deepEqual(host.posted, [{ type: 'heads', heads: [] }]);
  assert.deepEqual(host.logs, ['[heads] ready']);
  assert.equal(host.notices.length, 2);
  assert.equal(host.confirms.length, 2);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandlers } from '../src/main/handlers';
import { addProject, createSettingsStore, createStateStore, defaultSettings, isAbsolutePath, parseSettings, parseState } from '../src/main/settings';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-settings-'));
const absolute = path.resolve(os.tmpdir(), 'tools', 'claude.exe');

test('settings and state are schema-checked: unknown keys, wrong types and relative paths are refused', () => {
  assert.deepEqual(parseSettings({ version: 1, theme: 'dark', cliPaths: { claude: absolute } }), { version: 1, theme: 'dark', cliPaths: { claude: absolute } });
  for (const bad of [
    null, [], {}, { version: 2, theme: 'dark', cliPaths: {} }, { version: 1, theme: 'blue', cliPaths: {} },
    { version: 1, theme: 'dark', cliPaths: {}, extra: true }, { version: 1, theme: 'dark', cliPaths: { claude: 'claude.exe' } },
    { version: 1, theme: 'dark', cliPaths: { claude: '.\\tools\\claude.exe' } }, { version: 1, theme: 'dark', cliPaths: { bash: absolute } },
    { version: 1, theme: 'dark', cliPaths: { codex: 42 } }, { version: 1, theme: 'dark', cliPaths: { codex: '\\\\?\\C:\\x.exe' } },
  ]) assert.equal(parseSettings(bad), undefined, JSON.stringify(bad));
  assert.equal(isAbsolutePath('C:\\tools\\claude.exe'), true);
  assert.equal(isAbsolutePath('C:\\tools\\a\u0007.exe'), false);
  const project = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', path: absolute, name: 'tools' };
  assert.ok(parseState({ version: 1, sidebarOpen: false, projects: [project] }));
  assert.equal(parseState({ version: 1, sidebarOpen: false, projects: [project, project] }), undefined, 'duplicate ids');
  assert.equal(parseState({ version: 1, sidebarOpen: 'no', projects: [] }), undefined);
  assert.equal(parseState({ version: 1, sidebarOpen: true, projects: [{ ...project, path: 'relative' }] }), undefined);
  assert.equal(parseState({ version: 1, sidebarOpen: true, projects: [{ ...project, cliPath: absolute }] }), undefined, 'a project carries no CLI path');
});

test('the store writes atomically, reads back what it wrote, and never writes an invalid file', async () => {
  const dir = scratch();
  try {
    const store = createSettingsStore(dir);
    assert.deepEqual(await store.load(), defaultSettings());
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'loading writes nothing');
    await store.update(current => ({ ...current, theme: 'light' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { version: 1, theme: 'light', cliPaths: {} });
    await assert.rejects(store.update(current => ({ ...current, theme: 'neon' as never })), /Refused to write an invalid settings.json/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).theme, 'light', 'the refused write changed nothing');
    await Promise.all(['dark', 'light', 'system', 'dark'].map(theme => store.update(current => ({ ...current, theme: theme as 'dark' }))));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).theme, 'dark', 'writes run in order');
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file that fails its schema is set aside and the defaults are used', async () => {
  const dir = scratch();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, theme: 'dark', cliPaths: { claude: 'claude.exe' } }));
    fs.writeFileSync(path.join(dir, 'state.json'), '{ not json');
    const settings = createSettingsStore(dir), state = createStateStore(dir);
    assert.deepEqual(await settings.load(), defaultSettings());
    assert.match(settings.problem ?? '', /didn't match its schema/);
    assert.equal((await state.load()).projects.length, 0);
    const names = fs.readdirSync(dir);
    assert.ok(names.some(name => name.startsWith('settings.json.invalid-')));
    assert.ok(names.some(name => name.startsWith('state.json.invalid-')));
    assert.equal(names.includes('settings.json'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a folder becomes a project once, by its resolved path', () => {
  const folder = path.resolve(os.tmpdir(), 'Some Project');
  const once = addProject({ version: 1, sidebarOpen: true, projects: [] }, folder);
  assert.equal(once.projects.length, 1);
  assert.equal(once.projects[0]!.name, 'Some Project');
  assert.equal(addProject(once, folder.toUpperCase()), once);
  assert.ok(parseState(once));
});

test('CLI paths and projects come only from main\'s own pickers, never from the renderer or a project', async () => {
  const dir = scratch();
  try {
    const picked: string[] = [];
    let nextFile: string | undefined = absolute;
    const handlers = createHandlers({
      info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' },
      settings: createSettingsStore(dir), state: createStateStore(dir),
      pickFolder: async () => { picked.push('folder'); return dir; },
      pickExecutable: async provider => { picked.push(provider); return nextFile; },
      applyTheme: () => undefined,
    });
    assert.deepEqual((await handlers['settings.pickCliPath']({ provider: 'claude' })).cliPaths, { claude: absolute });
    nextFile = undefined;
    assert.deepEqual((await handlers['settings.pickCliPath']({ provider: 'codex' })).cliPaths, { claude: absolute }, 'a cancelled picker changes nothing');
    assert.deepEqual((await handlers['settings.clearCliPath']({ provider: 'claude' })).cliPaths, {});
    assert.equal((await handlers['projects.pick'](null)).projects[0]!.path, path.resolve(dir));
    assert.deepEqual(picked, ['claude', 'codex', 'folder']);
    // Nothing but the two stores was written, and nothing was read from the picked folder.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'state.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the stores live in user data and no app code reads CLI paths from anywhere else', () => {
  const sources = ['handlers.ts', 'settings.ts', 'startup.ts'].map(name => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', name), 'utf8')).join('\n');
  assert.match(sources, /createSettingsStore\(userData\)/);
  assert.match(sources, /const userData = app\.getPath\('userData'\)/);
  for (const forbidden of ['.hydra', '.vscode', 'process.cwd()', 'hydra.claudePath', 'hydra.codexPath']) assert.ok(!sources.includes(forbidden), forbidden);
});

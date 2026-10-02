import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandlers } from '../src/main/handlers';
import { replaceAtomic } from '../../src/core/atomicFile';
import { addProject, createSettingsStore, createStateStore, defaultSettings, defaultState, isAbsolutePath, JsonStore, parseSettings, parseState, SETTINGS_FILE } from '../src/main/settings';

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
  for (const good of ['C:\\tools\\claude.exe', 'D:/x/codex.cmd', '\\\\server\\share\\claude.exe']) assert.equal(isAbsolutePath(good, 'win32'), true, good);
  for (const bad of ['\\tools\\claude.exe', '/tools/claude.exe', 'C:tools\\claude.exe', 'claude.exe', '\\\\?\\C:\\x.exe', '\\\\.\\pipe\\x', '']) assert.equal(isAbsolutePath(bad, 'win32'), false, bad);
  assert.equal(isAbsolutePath('/usr/bin/claude', 'linux'), true);
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
  const project = scratch();
  fs.writeFileSync(path.join(project, 'marker.txt'), 'x');
  try {
    const picked: string[] = [];
    let nextFile: string | undefined = absolute;
    const handlers = createHandlers({
      info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' },
      settings: createSettingsStore(dir), state: createStateStore(dir),
      pickFolder: async () => { picked.push('folder'); return project; },
      pickExecutable: async provider => { picked.push(provider); return nextFile; },
      applyTheme: () => undefined,
      checkSetup: async () => { throw new Error('not used'); },
      signIn: async () => ({ started: false }),
    });
    assert.deepEqual((await handlers['settings.pickCliPath']({ provider: 'claude' })).cliPaths, { claude: absolute });
    nextFile = undefined;
    assert.deepEqual((await handlers['settings.pickCliPath']({ provider: 'codex' })).cliPaths, { claude: absolute }, 'a cancelled picker changes nothing');
    assert.deepEqual((await handlers['settings.clearCliPath']({ provider: 'claude' })).cliPaths, {});
    const first = await handlers['projects.pick'](null);
    assert.equal(first.state.projects[0]!.path, path.resolve(project));
    assert.equal(first.picked, first.state.projects[0]!.id);
    const again = await handlers['projects.pick'](null);
    assert.equal(again.state.projects.length, 1, 'picking it again adds nothing');
    assert.equal(again.picked, first.picked, 'and leads back to the same project');
    assert.deepEqual(picked, ['claude', 'codex', 'folder', 'folder']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'state.json'], 'only the two stores were written');
    assert.deepEqual(fs.readdirSync(project), ['marker.txt'], 'nothing was written into the project');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); }
});

test('the stores live in user data and no app code reads CLI paths from anywhere else', () => {
  const sources = ['handlers.ts', 'settings.ts', 'startup.ts'].map(name => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', name), 'utf8')).join('\n');
  assert.match(sources, /createSettingsStore\(userData\)/);
  assert.match(sources, /const userData = app\.getPath\('userData'\)/);
  for (const forbidden of ['.hydra', '.vscode', 'process.cwd()', 'hydra.claudePath', 'hydra.codexPath']) assert.ok(!sources.includes(forbidden), forbidden);
});

test('a file Hydra cannot read is never overwritten: defaults for this session, and every write refused', async () => {
  const dir = scratch();
  try {
    // A folder where the file should be: reading it fails with something other than "not found".
    fs.mkdirSync(path.join(dir, SETTINGS_FILE));
    const store = createSettingsStore(dir);
    assert.deepEqual(await store.load(), defaultSettings());
    assert.equal(store.readOnly, true);
    assert.match(store.problem ?? '', /couldn't read settings\.json/);
    await assert.rejects(store.update(current => ({ ...current, theme: 'dark' })), /won't save changes/);
    assert.ok(fs.statSync(path.join(dir, SETTINGS_FILE)).isDirectory(), 'what was there is untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file that fails its schema and cannot be moved aside is kept, and writes are refused', async () => {
  const dir = scratch();
  const file = path.join(dir, SETTINGS_FILE);
  const original = JSON.stringify({ version: 1, theme: 'dark', cliPaths: { claude: 'typo' } });
  fs.writeFileSync(file, original);
  const realRename = fs.promises.rename;
  (fs.promises as { rename: typeof realRename }).rename = async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); };
  try {
    const store = createSettingsStore(dir);
    assert.deepEqual(await store.load(), defaultSettings());
    assert.equal(store.readOnly, true);
    await assert.rejects(store.update(current => current), /won't save changes/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'the hand-edited file survives');
  } finally {
    (fs.promises as { rename: typeof realRename }).rename = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write that fails before its rename leaves the old file whole, and the stores write through replaceAtomic', async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'state.json');
    await createStateStore(dir).update(current => ({ ...current, sidebarOpen: false }));
    const before = fs.readFileSync(file, 'utf8');
    const failing = new JsonStore(file, parseState, defaultState, async () => { throw new Error('power cut'); });
    await assert.rejects(failing.update(current => ({ ...current, sidebarOpen: true })), /power cut/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
    assert.equal((createStateStore(dir) as unknown as { replace: unknown }).replace, replaceAtomic, 'the real stores use core replaceAtomic');
    assert.equal((createSettingsStore(dir) as unknown as { replace: unknown }).replace, replaceAtomic);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one read is shared: a load that started before a write never brings back the old value', async () => {
  const dir = scratch();
  try {
    const store = createSettingsStore(dir);
    const early = store.load();
    const written = store.update(current => ({ ...current, theme: 'light' }));
    await early;
    await written;
    assert.equal((await store.load()).theme, 'light');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a brief Windows lock is waited out, and a lock that never clears ends read-only', async () => {
  const dir = scratch();
  const file = path.join(dir, SETTINGS_FILE);
  fs.writeFileSync(file, JSON.stringify({ version: 1, theme: 'light', cliPaths: {} }));
  const realRead = fs.promises.readFile;
  const lockFor = (times: number) => {
    let left = times;
    (fs.promises as { readFile: unknown }).readFile = async (...args: Parameters<typeof realRead>) => {
      if (left-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return realRead(...args);
    };
  };
  try {
    lockFor(3);
    const store = createSettingsStore(dir);
    assert.equal((await store.load()).theme, 'light');
    assert.equal(store.readOnly, false);
    lockFor(100);
    const stuck = createSettingsStore(dir);
    assert.deepEqual(await stuck.load(), defaultSettings());
    assert.equal(stuck.readOnly, true);
    assert.match(stuck.problem ?? '', /EBUSY/);
  } finally {
    (fs.promises as { readFile: unknown }).readFile = realRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('after a failed write the next one starts from the last saved value', async () => {
  const dir = scratch();
  try {
    let fail = true;
    const store = new JsonStore(path.join(dir, 'state.json'), parseState, defaultState, async (temporary, destination) => {
      if (fail) throw new Error('disk full');
      await replaceAtomic(temporary, destination);
    });
    await assert.rejects(store.update(current => ({ ...current, sidebarOpen: false })), /disk full/);
    fail = false;
    const next = await store.update(current => current);
    assert.equal(next.sidebarOpen, true, 'the failed change was not kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sidebarOpen, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

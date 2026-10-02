import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { APP_USER_MODEL_ID, applyIdentity, identityProblems, insideIdeUserData, OWNED_PATHS, type IdentityApp } from '../src/main/identity';

const appData = path.join('C:', 'Users', 'someone', 'AppData', 'Roaming');

function fakeApp(): IdentityApp & { calls: string[]; paths: Record<string, string> } {
  const paths: Record<string, string> = { appData, userData: path.join(appData, 'Hydra'), sessionData: path.join(appData, 'Hydra'), logs: path.join(appData, 'Hydra', 'logs'), crashDumps: path.join(appData, 'Hydra', 'Crashpad') };
  const calls: string[] = [];
  return {
    calls, paths,
    getPath: name => paths[name]!,
    setPath: (name, value) => { calls.push(`setPath:${name}`); paths[name] = value; },
    setAppLogsPath: value => { calls.push('setAppLogsPath'); paths.logs = value!; },
    setName: name => calls.push(`setName:${name}`),
    setAppUserModelId: id => calls.push(`aumid:${id}`),
  };
}

test('identity moves every owned path to Hydra App under AppData', () => {
  const app = fakeApp();
  assert.ok(identityProblems(app).length > 0, 'the defaults (productName "Hydra") point at the IDE\'s folder');
  const userData = applyIdentity(app);
  assert.equal(userData, path.join(appData, 'Hydra App'));
  for (const name of OWNED_PATHS) assert.ok(app.paths[name]!.startsWith(userData), name);
  assert.deepEqual(identityProblems(app), []);
  assert.ok(app.calls.includes(`aumid:${APP_USER_MODEL_ID}`));
  assert.equal(APP_USER_MODEL_ID, 'Hydra.App');
  assert.equal(app.calls[0], 'setPath:userData', 'user data is set before anything else');
});

test('the IDE folder check is exact and case-insensitive', () => {
  assert.equal(insideIdeUserData(path.join(appData, 'Hydra'), appData), true);
  assert.equal(insideIdeUserData(path.join(appData, 'hydra', 'User'), appData), true);
  assert.equal(insideIdeUserData(path.join(appData, 'Hydra App'), appData), false);
  assert.equal(insideIdeUserData(path.join(appData, 'Hydra2'), appData), false);
});

test('main.ts applies the identity as its first statement and loads the rest after', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  const statements = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('//'));
  assert.deepEqual(statements.slice(0, 2), [`import { app } from 'electron';`, `import { applyIdentity } from './identity';`], 'main.ts imports only electron and identity');
  assert.equal(statements[2], 'applyIdentity(app);');
  assert.match(statements[3] ?? '', /^\(require\('\.\/startup'\)/);
  assert.equal(statements.length, 4);
});

test('identity.ts imports nothing that could touch user data first', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'identity.ts'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';\r?$/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['node:path']);
});

test('nothing in the app names the IDE\'s data folder except identity.ts', () => {
  const root = path.join(__dirname, '..', 'src');
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith(path.join('main', 'identity.ts'))) {
        const code = fs.readFileSync(full, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
        if (/APPDATA%?\\Hydra(?! App)|IDE_USER_DATA_FOLDER|ideUserData|['"]Hydra['"]\s*\)/.test(code)) hits.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

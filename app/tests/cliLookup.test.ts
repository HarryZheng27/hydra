import assert from 'node:assert/strict';
import test from 'node:test';
import { pathWithUsualCliFolders, usualCliLocations } from '../src/main/cliLookup';

const env = { USERPROFILE: 'C:\\Users\\nico', APPDATA: 'C:\\Users\\nico\\AppData\\Roaming' };

test('the CLIs\' usual Windows install locations: Claude Code\'s native installer folder, and npm\'s global folder', () => {
  assert.deepEqual(usualCliLocations('claude', env, 'win32'), ['C:\\Users\\nico\\.local\\bin\\claude.exe', 'C:\\Users\\nico\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\nico\\AppData\\Roaming\\npm\\claude.exe']);
  assert.deepEqual(usualCliLocations('codex', env, 'win32'), ['C:\\Users\\nico\\AppData\\Roaming\\npm\\codex.cmd', 'C:\\Users\\nico\\AppData\\Roaming\\npm\\codex.exe']);
  assert.deepEqual(usualCliLocations('codex', {}, 'win32'), []);
});

test('an app started with a short PATH gets the installers\' folders at its end, only where a CLI is, and only once', () => {
  const installed = new Set(['C:\\Users\\nico\\.local\\bin\\claude.exe', 'C:\\Users\\nico\\AppData\\Roaming\\npm\\codex.cmd']);
  const exists = (file: string) => installed.has(file);
  // The G5 and G7 live checks: started with a PATH that lacked .local\bin.
  assert.equal(pathWithUsualCliFolders({ ...env, PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' }, 'win32', exists),
    'C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Users\\nico\\.local\\bin;C:\\Users\\nico\\AppData\\Roaming\\npm');
  // Already there (any case, a trailing slash): nothing changes, and the user's order stands.
  assert.equal(pathWithUsualCliFolders({ ...env, PATH: 'c:\\users\\nico\\.local\\bin\\;C:\\Users\\nico\\AppData\\Roaming\\npm' }, 'win32', exists), undefined);
  // No CLI installed there: nothing added.
  assert.equal(pathWithUsualCliFolders({ ...env, PATH: 'C:\\Windows' }, 'win32', () => false), undefined);
});

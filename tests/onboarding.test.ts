import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnboarding, advanceOnboarding, shouldOpenOnboarding, shouldConnectOnFirstRun, firstRunProviders } from '../src/core/onboarding';
import { installWithFallback } from '../src/core/openVsx';

test('onboarding resumes interrupted steps, records optional skips, and completes only at the last step', () => {
  let state = readOnboarding(undefined);
  assert.equal(state.step, 'welcome');
  state = advanceOnboarding(state, false);
  assert.equal(state.step, 'import');
  state = advanceOnboarding(state, true);
  assert.deepEqual(state.skipped, ['import']);
  assert.deepEqual(readOnboarding(JSON.parse(JSON.stringify(state))), state);
  state = advanceOnboarding(state, false);
  assert.equal(state.step, 'accounts'); assert.equal(state.completed, false);
  state = advanceOnboarding(state, true);
  assert.equal(state.step, 'accounts'); assert.equal(state.completed, true);
  assert.deepEqual(state.skipped, ['import', 'accounts']);
});
test('onboarding migrates the retired project step onto accounts without losing completion', () => {
  const migrated = readOnboarding({ version: 1, step: 'project', completed: true, skipped: ['appearance', 'project'] });
  assert.equal(migrated.step, 'accounts');
  assert.equal(migrated.completed, true);
  assert.deepEqual(migrated.skipped, ['appearance', 'accounts']);
});
test('onboarding rejects corrupt persisted state and never auto-opens in tests, development, remote, untrusted or handoff windows', () => {
  for (const value of [null, {}, {version:1, step:'import', completed:false, skipped:['invalid']}, {version:2, step:'project', completed:true, skipped:[]}]) assert.equal(readOnboarding(value).step, 'welcome');
  const allowed = { desktop:true, trusted:true, development:false, handoff:false, completed:false };
  assert.equal(shouldOpenOnboarding(allowed), true);
  for (const override of [{desktop:false}, {trusted:false}, {development:true}, {handoff:true}, {completed:true}]) assert.equal(shouldOpenOnboarding({...allowed,...override}), false);
});

test('first run connects the agents by itself only in an installed desktop Hydra, once, and never in a development, test or handoff window', () => {
  const base = { desktop: true, production: true, development: false, test: false, handoff: false, done: false };
  assert.equal(shouldConnectOnFirstRun(base), true);
  for (const key of ['desktop', 'production'] as const) assert.equal(shouldConnectOnFirstRun({ ...base, [key]: false }), false, key);
  for (const key of ['development', 'test', 'handoff', 'done'] as const) assert.equal(shouldConnectOnFirstRun({ ...base, [key]: true }), false, key);
});

test('first run sets up the agents whose command-line tool is on this computer, unless they\'re connected with their extension installed here', () => {
  const agent = (cli: boolean, connected: boolean, extension: boolean) => ({ cli, connected, extension });
  assert.deepEqual(firstRunProviders({ claude: agent(true, false, false), codex: agent(true, false, false) }), ['claude', 'codex']);
  assert.deepEqual(firstRunProviders({ claude: agent(true, true, true), codex: agent(true, false, false) }), ['codex'], 'a complete setup is left as it is');
  assert.deepEqual(firstRunProviders({ claude: agent(true, true, false), codex: agent(false, false, false) }), ['claude'], 'connected from another editor, but no extension here: set it up');
  assert.deepEqual(firstRunProviders({ claude: agent(false, false, false), codex: agent(false, false, false) }), [], 'nothing on this computer: nothing to set up');
});

test('an extension the gallery can\'t install (Open VSX\'s 406 on a platform-specific manifest) is installed from Open VSX instead', async () => {
  const installed: string[] = [], logged: string[] = [];
  const failing = async () => { throw new Error('Server returned 406'); };
  assert.equal(await installWithFallback('anthropic.claude-code', failing, async file => { installed.push(file); }, async id => `C:/tmp/${id}.vsix`, line => logged.push(line)), 'open-vsx');
  assert.deepEqual(installed, ['C:/tmp/anthropic.claude-code.vsix']);
  assert.match(logged[0]!, /gallery failed \(Server returned 406\); trying Open VSX/);
  assert.equal(await installWithFallback('openai.chatgpt', async () => undefined, async () => { throw new Error('not used'); }, async () => { throw new Error('not used'); }), 'gallery', 'the gallery first, when it works');
  await assert.rejects(installWithFallback('anthropic.claude-code', failing, async () => undefined, async () => { throw new Error('anthropic.claude-code was not found on Open VSX.'); }),
    /the extension gallery said "Server returned 406", and Open VSX said "anthropic.claude-code was not found on Open VSX\."/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsShell } from '../src/settings/shell';
import type { SettingsImports } from '../src/settings/types';
import type { PackService } from '../src/core/packs/service';
import { FakeHost } from './host/fakeHost';

/**
 * Hydra Settings with no editor (docs/internal/hydra-app/G2-host-split.md, milestone 6): the shell and its pages reach
 * their program only through Host, so the Hydra app can render them.
 */
function setup() {
  const host = new FakeHost({ storage: '/storage', dist: '/dist', appRoot: '/app' });
  const imports: SettingsImports = { available: false, status: async () => ({ available: false, interrupted: false }), choose: async () => undefined, apply: async () => 0, undo: async () => {} };
  const packs = { state: async () => ({ packs: [] }), effectiveGates: async () => ({ gates: [] }), userFolder: async () => '/packs', places: () => ({}) } as unknown as PackService;
  const shell = new SettingsShell(host, imports, packs);
  const posted: { type?: string; [key: string]: unknown }[] = [];
  const post = async (message: unknown) => { posted.push(message as { type?: string }); return true; };
  shell.attach(post);
  return { host, shell, posted, post };
}

test('the Settings page reaches its program through the bridge or VS Code\'s webview API', () => {
  const { shell } = setup();
  const html = shell.html();
  assert.match(html, /const vscode = window\.hydraBridge \?\? acquireVsCodeApi\(\);/);
  assert.match(html, /script-src 'nonce-/);
  for (const page of shell.pages) assert.ok(html.includes(`data-page="${page.id}"`), page.id);
});

test('ready posts the appearance from the host, and opens the page asked for', async () => {
  const { host, shell, posted, post } = setup();
  host.theme = 'light';
  await shell.receive({ type: 'ready' }, post, 'heads');
  assert.deepEqual(posted[0], { type: 'appearance', mode: 'light', status: '' });
  assert.deepEqual(posted.at(-1), { type: 'showPage', id: 'heads' });
});

test('Dark / Light writes the user\'s workbench theme through the host, and refuses a workspace override', async () => {
  const { host, shell, posted, post } = setup();
  await shell.receive({ type: 'appearance', mode: 'light' }, post);
  assert.equal(host.sectionValues.get('workbench.colorTheme'), 'Hydra Light');
  assert.equal(host.sectionValues.get('window.autoDetectColorScheme'), false);
  assert.ok(posted.some(message => message.type === 'status' && message.text === 'Applied Hydra Light.'));
  const overridden = new FakeHost({ storage: '/s', dist: '/d', appRoot: '/a' });
  overridden.section = name => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => (name === 'workbench' ? { workspaceValue: 'Other' } : {}), update: async () => { throw new Error('never written'); } }) as never;
  const blocked = new SettingsShell(overridden, { available: false } as SettingsImports, {} as PackService);
  const answers: unknown[] = [];
  await blocked.receive({ type: 'appearance', mode: 'dark' }, async message => { answers.push(message); return true; });
  assert.match(String((answers[0] as { text: string }).text), /This workspace overrides appearance/);
});

test('pages change Hydra settings, run Hydra commands and open links through the host', async () => {
  const { host, shell, posted, post } = setup();
  await shell.receive({ type: 'setMaxConcurrentHelpers', value: 5 }, post);
  assert.equal(host.values.get('maxConcurrentHelpers'), 5);
  host.commandResults.set('hydra.stopAllAgents', () => true);
  await shell.receive({ type: 'stopAllAgents' }, post);
  assert.deepEqual(host.commands.map(command => command.id), ['hydra.stopAllAgents']);
  assert.deepEqual(posted.at(-1), { type: 'stopState', stopped: true });
  await shell.receive({ type: 'openHeadsGuide' }, post);
  assert.match(String(host.opened.at(-1)?.url), /^https:\/\//);
  await shell.receive({ type: 'iconTheme', value: 'seti' }, post);
  assert.equal(host.sectionValues.get('workbench.iconTheme'), 'seti');
  await shell.receive({ type: 'nonsense' }, post);
  assert.deepEqual(posted.at(-1), { type: 'error', text: 'Unknown settings action.' });
});

test('refreshPages posts only to an attached view', async () => {
  const { shell, posted, post } = setup();
  shell.detach(post);
  await shell.refreshPages(['heads']);
  assert.equal(posted.length, 0);
});

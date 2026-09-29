import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { machineSetting, type InspectableConfiguration } from '../src/core/machineSetting';

const fake = (inspected: Record<string, unknown>): InspectableConfiguration => ({ inspect: (key: string) => inspected[key] as never });

test('machineSetting reads the user value, then the default, and never a workspace value', () => {
  const config = fake({
    claudePath: { defaultValue: '', globalValue: 'C:\\tools\\claude.exe', workspaceValue: 'C:\\repo\\evil.exe', workspaceFolderValue: 'C:\\repo\\evil2.exe' },
    codexPath: { defaultValue: '', workspaceValue: 'C:\\repo\\evil.exe' },
    flag: { defaultValue: false, globalValue: true },
  });
  assert.equal(machineSetting<string>(config, 'claudePath'), 'C:\\tools\\claude.exe');
  assert.equal(machineSetting<string>(config, 'codexPath'), '');
  assert.equal(machineSetting<boolean>(config, 'flag'), true);
  assert.equal(machineSetting<string>(config, 'unknown'), undefined);
});

test('every setting that names an executable, folder or installer is machine or application scoped', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const properties: Record<string, { scope?: string; description?: string }> = Object.assign({}, ...[manifest.contributes.configuration].flat().map((section: { properties?: object }) => section.properties));
  const safe = (scope?: string) => scope === 'machine' || scope === 'application';
  const guarded = ['hydra.claudePath', 'hydra.codexPath', 'hydra.worktreeRoot', 'hydra.packs.folder', 'hydra.claudeMem.enabled', 'hydra.updates.check'];
  for (const key of guarded) assert.ok(safe(properties[key]?.scope), `${key} must be machine or application scope`);
  // Any other setting whose key or description reads like a path or command to run must be guarded too, so a new one can't slip in.
  for (const [key, spec] of Object.entries(properties)) {
    if (/(executable|\bpath\b|\bfolder\b|\bdirectory\b|\bcommand\b|\bscript\b)/i.test(`${key} ${spec.description ?? ''}`)) assert.ok(safe(spec.scope), `${key} looks like a path or command but is not machine/application scope`);
  }
});

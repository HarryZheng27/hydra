import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const appDir = path.join(__dirname, '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), 'utf8');

/** The rows of docs/THREAT_MODEL.md's "The Hydra app (unreleased)" table. */
function appRows(): string[] {
  const doc = read(appDir, '..', 'docs', 'THREAT_MODEL.md');
  const start = doc.indexOf('### The Hydra app (unreleased)');
  assert.ok(start >= 0, 'THREAT_MODEL.md has no app section');
  const end = doc.indexOf('\n### ', start + 1);
  return doc.slice(start, end < 0 ? undefined : end).split(/\r?\n/).filter(line => /^\| HSEC-\d+ \|/.test(line));
}

/** Every test('…') in app/tests and the root tests, and every check('…') in the smoke, by name. */
function testNames(): Set<string> {
  const names = new Set<string>();
  const sources = [
    ...fs.readdirSync(path.join(appDir, 'tests')).filter(name => name.endsWith('.test.ts')).map(name => read(appDir, 'tests', name)),
    // The app's chat logic lives in src/core/chat, tested by the root suite.
    ...fs.readdirSync(path.join(appDir, '..', 'tests')).filter(name => name.endsWith('.test.ts')).map(name => read(appDir, '..', 'tests', name)),
    read(appDir, 'smoke', 'run.mjs'),
  ];
  for (const source of sources) for (const match of source.matchAll(/\b(?:test|check)\('((?:[^'\\]|\\.)*)'/g)) names.add(match[1]!.replace(/\\'/g, "'"));
  return names;
}

test('every app control in the threat model names tests that exist', () => {
  const rows = appRows();
  assert.ok(rows.length >= 7, `expected the milestone 2 controls, found ${rows.length}`);
  const names = testNames();
  for (const row of rows) {
    const id = /^\| (HSEC-\d+) \|/.exec(row)![1];
    const testCell = row.split(' | ').at(-1) ?? '';
    const cited = [...testCell.matchAll(/`'([^`]+)'`/g)].map(match => match[1]!);
    assert.ok(cited.length > 0, `${id} names no test`);
    for (const name of cited) assert.ok(names.has(name), `${id} names a test that doesn't exist: ${name}`);
  }
});

test('the app controls cover the milestone 2 baseline', () => {
  const text = appRows().join('\n');
  for (const control of ['context isolation', 'sandbox', 'no Node integration', '<webview>', 'Content Security Policy', 'navigation', 'window.open', 'shell.openExternal', 'unknown', 'validator', '%APPDATA%\\Hydra App']) {
    assert.ok(text.includes(control), `no control mentions ${control}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { capDiff, dependencyBrief, isInterfaceChunk, maxDependencyDiff, type DependencyResult } from '../src/core/headStart';

/** Seam work, step 1: a dependent's brief carries the real code its dependencies landed. */
const chunk = (file: string, added: string[]) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${added.length} @@\n${added.map(line => `+${line}`).join('\n')}\n`;
const dependency = (extra: Partial<DependencyResult> = {}): DependencyResult => ({ id: 'a'.repeat(12), kind: 'head', title: 'Schema', summary: 'Added the tables.', commit: 'c'.repeat(40), changedFiles: ['src/db.ts'], ...extra });

test('capDiff: files that define exports and types come first; the rest follow in path order', () => {
  const raw = chunk('src/zeta.ts', ['const z = 1;']) + chunk('src/db.ts', ['export function open() {}']) + chunk('src/alpha.ts', ['const a = 1;']);
  const out = capDiff(raw, 10_000);
  assert.ok(out.indexOf('src/db.ts') < out.indexOf('src/zeta.ts'), 'the exporting file leads');
  assert.ok(out.indexOf('src/zeta.ts') < out.indexOf('src/alpha.ts'), 'the rest keep the diff\'s own order');
  assert.ok(isInterfaceChunk('src/types.ts', '') && isInterfaceChunk('lib/x.d.ts', '') && !isInterfaceChunk('src/util.ts', '+const a = 1;'));
});

test('capDiff: keeps whole files within the cap and names what it cut', () => {
  const raw = chunk('src/api.ts', ['export const a = 1;']) + chunk('src/big.ts', Array.from({ length: 400 }, (_, index) => `const v${index} = ${index};`)) + chunk('src/small.ts', ['const s = 1;']);
  const out = capDiff(raw, 1000);
  assert.ok(out.includes('src/api.ts') && out.includes('src/small.ts'), 'what fits stays whole');
  assert.ok(!out.includes('const v399'), 'a file too big for what is left is left out, never half-shown');
  assert.match(out, /Cut to fit 1 KB: 1 file not shown: src\/big\.ts/);
  assert.ok(out.length <= 1000 + 200, 'the cap plus its one note');
});

test('capDiff: secrets are redacted the way other brief content is', () => {
  const out = capDiff(chunk('src/config.ts', ['export const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";']), 10_000);
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), out);
});

test('dependencyBrief: the diff follows the summaries as the code they landed, and without one the brief is as it was', () => {
  const plain = dependencyBrief([dependency()]);
  assert.ok(!plain.includes('The code they landed'));
  const withDiff = dependencyBrief([dependency({ diff: capDiff(chunk('src/db.ts', ['export function open() {}']), 5000) })]);
  assert.ok(withDiff.startsWith(plain), 'the summaries come first, unchanged');
  assert.match(withDiff, /The code they landed[^\n]*\n\n### Schema\n```diff\ndiff --git a\/src\/db\.ts/);
  assert.match(withDiff, /\+export function open\(\) \{\}/);
});

test('dependencyBrief: the diff part never exceeds the cap, however much each dependency brings', () => {
  const big = 'x'.repeat(maxDependencyDiff);
  const out = dependencyBrief([dependency({ diff: big }), dependency({ title: 'Auth', diff: big })]);
  assert.ok(out.length < 4096 + maxDependencyDiff + 1000, `${out.length}`);
});

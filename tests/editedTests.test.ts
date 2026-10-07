import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultTestPatterns, editedTests, editedTestsNote, matchesTestPattern, parseEditedTests } from '../src/core/editedTests';
import { buildEvidenceMarkdown } from '../src/core/evidence';
import { git } from '../src/core/git';
import { loadGates, parseGatesConfig, runGateList, type Gate, type GateContext } from '../src/core/gates';
import { capDiff, reviewPrompt } from '../src/core/gates/review';
import type { ProbeOutput } from '../src/core/process';

/** Edited tests are evidence (docs/internal/Needs_You_Plan.md, Phase 3). */

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-edited-tests-'));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.invalid']); await git(root, ['config', 'user.name', 'Test']);
  const write = async (file: string, text: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  for (const [file, text] of Object.entries(files)) await write(file, text);
  await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'base']);
  const base = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const commit = async (message: string) => { await git(root, ['add', '-A']); await git(root, ['commit', '-qm', message]); return (await git(root, ['rev-parse', 'HEAD'])).trim(); };
  return { root, base, write, commit, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

test('the default patterns match tests and nothing else', () => {
  for (const file of ['foo.test.ts', 'src/foo.test.tsx', 'a/b/foo.spec.js', 'test/x.py', 'src/test/x.java', 'tests/a/b.ts', 'pkg/tests/x', 'src/__tests__/a.ts', 'x\\y\\z.test.ts']) assert.equal(matchesTestPattern(file), true, file);
  for (const file of ['src/foo.ts', 'src/contest/x.ts', 'latest.ts', 'src/testing.ts', 'docs/tests.md', 'src/foo.testing']) assert.equal(matchesTestPattern(file), false, file);
  assert.deepEqual([...defaultTestPatterns], ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**']);
});

test('a changed foo.test.ts is flagged, a new one is not, and a deleted one is', async () => {
  const r = await repo({ 'src/foo.test.ts': '1\n', 'src/bar.spec.ts': '1\n', 'src/keep.test.ts': '1\n', 'src/code.ts': '1\n' });
  try {
    await r.write('src/foo.test.ts', '2\n');
    await r.write('src/brand-new.test.ts', '1\n');
    await r.write('src/code.ts', '2\n');
    await rm(path.join(r.root, 'src', 'bar.spec.ts'));
    const commit = await r.commit('work');
    assert.deepEqual(await editedTests(r.root, r.base, { to: commit }), ['src/bar.spec.ts', 'src/foo.test.ts']);
    assert.deepEqual(await editedTests(r.root, r.base), ['src/bar.spec.ts', 'src/foo.test.ts'], 'against the working tree too');
    assert.equal(await editedTests(r.root, r.base, { to: 'not-a-commit' }), undefined, 'git failing is "can\'t say", never a throw');
  } finally { await r.close(); }
});

test('a renamed test counts as a deleted one, and a change to a test folder file counts', async () => {
  const r = await repo({ 'src/old.test.ts': 'same\n', 'tests/helper.ts': '1\n' });
  try {
    await git(r.root, ['mv', 'src/old.test.ts', 'src/new.test.ts']);
    await r.write('tests/helper.ts', '2\n');
    const commit = await r.commit('work');
    assert.deepEqual(await editedTests(r.root, r.base, { to: commit }), ['src/old.test.ts', 'tests/helper.ts']);
  } finally { await r.close(); }
});

test('custom patterns replace the defaults', async () => {
  const r = await repo({ 'src/a.test.ts': '1\n', 'checks/one.ts': '1\n' });
  try {
    await r.write('src/a.test.ts', '2\n'); await r.write('checks/one.ts', '2\n');
    const commit = await r.commit('work');
    assert.deepEqual(await editedTests(r.root, r.base, { to: commit, patterns: ['checks/**'] }), ['checks/one.ts'], 'the default **/*.test.* no longer applies');
    assert.deepEqual(parseEditedTests('M\0src/a.test.ts\0A\0src/n.test.ts\0D\0checks/z.ts\0', ['checks/*.ts']), ['checks/z.ts']);
  } finally { await r.close(); }
});

test('gates.json "tests" is validated and loaded', async () => {
  assert.deepEqual(parseGatesConfig({ tests: ['spec/**', ' **/*.check.* '], gates: [] }).tests, ['spec/**', '**/*.check.*']);
  assert.equal(parseGatesConfig({ gates: [] }).tests, undefined);
  for (const tests of [[], 'spec/**', [''], [3], ['x'.repeat(201)], Array.from({ length: 21 }, (_, index) => `t${index}/**`)]) assert.throws(() => parseGatesConfig({ tests, gates: [] }), /tests/, JSON.stringify(tests).slice(0, 40));
  const r = await repo({ '.hydra/gates.json': JSON.stringify({ tests: ['spec/**'], gates: [] }) });
  try { assert.deepEqual((await loadGates(r.root)).tests, ['spec/**']); } finally { await r.close(); }
});

test('the note names up to ten files and counts the rest', () => {
  assert.equal(editedTestsNote(undefined), undefined);
  assert.equal(editedTestsNote([]), undefined);
  assert.equal(editedTestsNote(['a.test.ts']), 'Changed existing tests: a.test.ts.');
  const many = Array.from({ length: 13 }, (_, index) => `t${index}.test.ts`);
  assert.match(editedTestsNote(many)!, /^Changed existing tests: t0\.test\.ts, .*t9\.test\.ts \(and 3 more\)\.$/);
  assert.ok(editedTestsNote(Array.from({ length: 50 }, () => 'x'.repeat(300)))!.length < 1500, 'short enough for a plan result\'s note');
});

test('the review prompt includes the list only when it is non-empty, fenced as untrusted', () => {
  const input = { provider: 'claude' as const, baseCommit: 'a'.repeat(40), diff: capDiff('+x\n'), earlier: [], screenshots: [], focus: '' };
  assert.doesNotMatch(reviewPrompt(input), /Changed existing tests/);
  assert.doesNotMatch(reviewPrompt({ ...input, editedTests: [] }), /Changed existing tests/);
  const prompt = reviewPrompt({ ...input, editedTests: ['src/a.test.ts', 'tests/b.ts'] });
  assert.match(prompt, /## Changed existing tests\nThese test files existed before this change, and the change edited or deleted them:\n<<<untrusted-([0-9a-f]{16})\nsrc\/a\.test\.ts\ntests\/b\.ts\n>>>end-untrusted-\1\n.*weaken a test so that it passes/);
});

test('a review gate is told which existing tests changed, and a change with none says nothing', async () => {
  const r = await repo({ 'src/a.test.ts': '1\n', 'src/a.ts': '1\n' });
  try {
    await r.write('src/a.test.ts', 'skip\n'); await r.write('src/new.test.ts', 'n\n');
    await r.commit('work');
    const prompts: string[] = [];
    const runReviewer = async (spec: { args: string[]; input: string }): Promise<ProbeOutput> => { prompts.push(spec.input); return { args: spec.args, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"verdict":"pass","summary":"ok","findings":[]}' }), stderr: '', exitCode: 0 }; };
    const gate: Gate = { id: 'review', type: 'review', required: true, reviewer: 'claude', focus: '' };
    const context = (extra: Partial<GateContext> = {}): GateContext => ({
      author: 'claude', logDirectory: path.join(r.root, '..', `logs-${Math.random().toString(16).slice(2)}`), executable: async provider => `fake-${provider}`, ...extra,
      runtime: { runReviewer, isolation: async () => ({ env: {}, claudePlugins: undefined } as never), pollMs: 25 },
    });
    const [result] = await runGateList([gate], r.root, r.base, context());
    assert.equal(result!.state, 'passed', 'it fails nothing on its own');
    assert.match(prompts[0]!, /Changed existing tests[\s\S]*src\/a\.test\.ts/);
    assert.doesNotMatch(prompts[0]!, /new\.test\.ts\n>>>/, 'the new test file is not flagged');
    await runGateList([gate], r.root, r.base, context({ testPatterns: ['nothing/**'] }));
    assert.doesNotMatch(prompts[1]!, /Changed existing tests/, 'custom patterns replace the defaults');
  } finally { await r.close(); }
});

test('View evidence shows the notes, with or without gate results', () => {
  const subject = { title: 'Job', worktree: 'C:/w', logDirectories: ['C:/l'], baseDirectory: 'C:/l', results: [], notes: ['Changed existing tests: a.test.ts.'] };
  assert.match(buildEvidenceMarkdown(subject), /No gates have run\.\n\n## Notes\n\n- Changed existing tests: a\.test\.ts\./);
  assert.doesNotMatch(buildEvidenceMarkdown({ ...subject, notes: undefined }), /Notes/);
});

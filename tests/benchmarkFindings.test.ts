import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { integrationFixJob } from '../src/core/integration';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { briefSections, hydraFindingRows, hydraReviews, hydraTiming, ownerOf, renderFindings, singleFindingRows, singleReviews } from '../scripts/benchmark-findings.mjs';

/** Plan v3, Phase A: the findings worksheet (docs/Benchmark.md, "Why a review failed"). Nothing here runs a model. */

type Finding = { severity: 'blocker' | 'major' | 'minor'; file?: string; line?: number; note: string };
const failedGate = (findings: Finding[], extra: Record<string, unknown> = {}) => ({
  at: '2026-10-01T10:08:00.000Z', tip: 'b'.repeat(40), failed: true, running: false,
  checks: [
    { id: 'test', kind: 'command', required: true, passed: true, state: 'passed', exitCode: 0, durationMs: 1, outputTail: '' },
    { id: 'rigor-review', kind: 'review', required: true, passed: false, state: 'failed', exitCode: 0, durationMs: 1, outputTail: '', summary: 'Reviewed by Codex. Broken.', findings },
  ],
  ...extra,
});
const jobs = [{ key: 'discounts', writeScope: ['src/discounts.js', 'test/discounts.test.js'] }, { key: 'api', writeScope: ['src/'] }];

test('a real fix brief\'s review findings come back with severity, file, line and note, in every shape a reviewer writes them', () => {
  const findings: Finding[] = [
    { severity: 'major', file: 'src/discounts.js', line: 12, note: 'Rounds the wrong way: see total().' },
    { severity: 'minor', note: 'No test for an empty cart.' },
    { severity: 'major', file: 'C:\\repo\\src\\api.js', line: 3, note: 'Absolute path.' },
    { severity: 'blocker', file: 'src/a b.js', note: 'No line.' },
  ];
  const fix = integrationFixJob({ title: 'Discounts', jobs: [] }, failedGate(findings) as never, 2)!;
  const sections = briefSections(fix.brief);
  assert.deepEqual(sections.map((section: { id: string; kind: string }) => [section.id, section.kind]), [['rigor-review', 'review']]);
  assert.deepEqual(sections[0].findings, findings);
  // A file:line:column keeps its line; a line in no known shape keeps its text.
  assert.deepEqual(briefSections('### r (review) failed\n- [major] a.ts:12:5: note\n- [minor] a.ts:12:').map((section: { findings: unknown[] }) => section.findings)[0], [
    { severity: 'major', file: 'a.ts', line: 12, note: 'note' }, { severity: 'minor', note: 'a.ts:12:', unparsed: true },
  ]);
  assert.equal(briefSections('### r (review) failed\n- [major] x: y\n…')[0].cut, true);
});

test('a finding\'s job: the longest write-scope match, with an empty entry or "." meaning the whole repository', () => {
  assert.equal(ownerOf('src/discounts.js', jobs), 'discounts');
  assert.equal(ownerOf('src\\orders.js', jobs), 'api');
  assert.equal(ownerOf('./src/orders.js', [{ key: 'x', writeScope: ['./src'] }]), 'x');
  assert.equal(ownerOf('README.md', jobs), undefined);
  assert.equal(ownerOf('README.md', [...jobs, { key: 'all', writeScope: [''] }]), 'all');
  assert.equal(ownerOf('src/discounts.js', [{ key: 'all', writeScope: ['.'] }, ...jobs]), 'discounts', 'a narrower scope still wins');
});

test('reviews and rows: the single agent\'s rounds, and a Hydra plan\'s from its fix briefs plus its final gate, numbered alike', () => {
  const single = { rounds: [{ review: { verdict: 'fail', findings: [{ severity: 'major', file: 'src/a.js', note: 'x' }] } }, { review: { verdict: 'pass', findings: [] } }] };
  assert.deepEqual(singleReviews(single, { task: 'd', run: 'r' }).map((review: { round: number; final: boolean; verdict: string }) => [review.round, review.final, review.verdict]), [[1, false, 'fail'], [2, true, 'pass']]);
  assert.deepEqual(singleFindingRows(single, { task: 'd', run: 'r' }).map((item: { round: number; severity: string }) => [item.round, item.severity]), [[1, 'major']]);
  const fix1 = integrationFixJob({ title: 'D', jobs: [] }, failedGate([{ severity: 'blocker', file: 'src/discounts.js', note: 'z' }]) as never, 2)!;
  const tip = 'c'.repeat(40);
  const plan = {
    startedAt: '2026-10-01T10:00:00.000Z', jobs: [...jobs, { key: 'integration-fix-1', brief: fix1.brief }],
    integration: { tip, landed: [{ key: 'discounts', at: '2026-10-01T10:02:00.000Z' }, { key: 'api', at: '2026-10-01T10:05:30.000Z' }, { key: 'integration-fix-1', at: '2026-10-01T10:09:00.000Z' }], gate: failedGate([{ severity: 'major', file: 'src/orders.js', note: 'w' }], { at: '2026-10-01T10:11:00.000Z', tip }) },
  };
  const reviews = hydraReviews(plan, { task: 'discounts', run: 'r1-hydra' });
  assert.deepEqual(reviews.map((review: { round: number; final: boolean; verdict: string; partial?: boolean }) => [review.round, review.final, review.verdict, !!review.partial]), [[1, false, 'fail', true], [2, true, 'fail', false]]);
  const hydra = hydraFindingRows(plan, { task: 'discounts', run: 'r1-hydra' });
  assert.deepEqual(hydra.map((item: { round: number; final: boolean; job?: string }) => [item.round, item.final, item.job]), [[1, false, 'discounts'], [2, true, 'api']]);
  // A fix that never landed leaves the gate record the one its brief quoted: not counted twice.
  const unlanded = { ...plan, integration: { ...plan.integration, landed: plan.integration.landed.slice(0, 2) } };
  assert.deepEqual(hydraReviews(unlanded, { task: 'd', run: 'r' }).map((review: { round: number; final: boolean }) => [review.round, review.final]), [[1, true]]);
  assert.equal(hydraReviews({ ...plan, integration: { ...plan.integration, gate: { ...plan.integration.gate, running: true } } }, { task: 'd', run: 'r' }).length, 1, 'a gate still running isn\'t a result');
  assert.deepEqual(hydraTiming(plan), { jobs: 2, landed: 2, firstLanding: 120, lastLanding: 330, fixLandings: [{ key: 'integration-fix-1', seconds: 540 }], gateEnd: 660 });
  const markdown = renderFindings([...singleReviews(single, { task: 'discounts', run: 'r1-single' }), ...reviews], [...singleFindingRows(single, { task: 'discounts', run: 'r1-single' }), ...hydra], [{ ...hydraTiming(plan), task: 'discounts', run: 'r1-hydra' }]);
  assert.ok(markdown.includes('| discounts | hydra | 1 | 1 | 1 | 1* | 1 | 0 | 0 |'), markdown);
  assert.ok(markdown.includes('| discounts | single | 2 | 1 | 0 | 0 | 0 | 0 | 0 |'), 'a review with no findings still counts');
  assert.ok(markdown.includes('| discounts | hydra | r1-hydra | 2 | yes | major | `src/orders.js` | api | | w |'), markdown);
  assert.ok(markdown.includes('| discounts | r1-hydra | 2 of 2 |  | 2m 00s | 5m 30s | integration-fix-1 9m 00s | 11m 00s |'), markdown);
  assert.ok(renderFindings([], [{ task: 't', setup: 'single', run: 'r', round: 1, severity: 'minor', note: 'a \\| b | c' }]).includes('| a \\\\\\| b \\| c |'), 'a backslash and a pipe can\'t split the row');
});

test('benchmark.mjs findings reads run folders and the plan store, writes the worksheet beside them, and refuses a glob that matches nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-findings-'));
  try {
    const single = path.join(root, 'bench-v2-discounts-r1-single'), hydra = path.join(root, 'bench-v2-discounts-r1-hydra'), lost = path.join(root, 'bench-v2-discounts-r2-hydra');
    await mkdir(single); await mkdir(hydra); await mkdir(lost);
    await writeFile(path.join(single, 'single-results.json'), JSON.stringify({ kind: 'single', task: 'discounts' }));
    await writeFile(path.join(single, 'single-review.json'), JSON.stringify({ rounds: [{ review: { verdict: 'fail', findings: [{ severity: 'major', file: 'src/api.js', note: 'Wrong total.' }] } }] }));
    await writeFile(path.join(hydra, 'hydra-results.json'), JSON.stringify({ kind: 'hydra', task: 'discounts', planId: 'abc123abc123' }));
    await writeFile(path.join(lost, 'hydra-results.json'), JSON.stringify({ kind: 'hydra', task: 'discounts', planId: 'ffffffffffff' }));
    const store = path.join(root, 'plans.json');
    await writeFile(store, JSON.stringify({ plans: [{ id: 'abc123abc123', startedAt: '2026-10-01T10:00:00.000Z', jobs, integration: { landed: [], gate: failedGate([{ severity: 'major', file: 'src/discounts.js', note: 'Off by one.' }]) } }] }));
    const script = path.join(process.cwd(), 'scripts', 'benchmark.mjs');
    const result = spawnSync(process.execPath, [script, 'findings', '--runs', path.join(root, 'bench-v2-*'), '--plan-store', store], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const markdown = await readFile(path.join(root, 'findings.md'), 'utf8');
    assert.ok(markdown.includes('| discounts | single | bench-v2-discounts-r1-single | 1 | yes | major | `src/api.js` |  | | Wrong total. |'), markdown);
    assert.ok(markdown.includes('| discounts | hydra | bench-v2-discounts-r1-hydra | 1 | yes | major | `src/discounts.js` | discounts | | Off by one. |'), markdown);
    assert.ok(markdown.includes('Skipped: bench-v2-discounts-r2-hydra (its plan isn\'t in the plan store: pass --plan-store).'), markdown);
    const none = spawnSync(process.execPath, [script, 'findings', '--runs', path.join(root, 'nothing-*'), '--plan-store', store], { encoding: 'utf8' });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /No run folders match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

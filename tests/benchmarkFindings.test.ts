import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { integrationFixJob } from '../src/core/integration';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { briefSections, hydraFindingRows, hydraTiming, ownerOf, renderFindings, singleFindingRows } from '../scripts/benchmark-findings.mjs';

/** Plan v3, Phase A: the findings worksheet (docs/Benchmark.md, "Why a review failed"). Nothing here runs a model. */

const failedGate = (findings: { severity: 'blocker' | 'major' | 'minor'; file?: string; line?: number; note: string }[]) => ({
  at: '2026-10-01T10:08:00.000Z', tip: 'b'.repeat(40), failed: true, running: false,
  checks: [
    { id: 'test', kind: 'command', required: true, passed: true, state: 'passed', exitCode: 0, durationMs: 1, outputTail: '' },
    { id: 'rigor-review', kind: 'review', required: true, passed: false, state: 'failed', exitCode: 0, durationMs: 1, outputTail: '', summary: 'Reviewed by Codex. Broken.', findings },
  ],
});
const jobs = [{ key: 'discounts', writeScope: ['src/discounts.js', 'test/discounts.test.js'] }, { key: 'api', writeScope: ['src/'] }];

test('a real fix brief\'s review findings come back with severity, file, line and note; each file names the job whose scope has it', () => {
  const gate = failedGate([{ severity: 'major', file: 'src/discounts.js', line: 12, note: 'Rounds the wrong way.' }, { severity: 'minor', note: 'No test for an empty cart.' }]);
  const fix = integrationFixJob({ title: 'Discounts', jobs: [] }, gate as never, 2)!;
  const sections = briefSections(fix.brief);
  assert.deepEqual(sections.map((section: { id: string; kind: string }) => [section.id, section.kind]), [['rigor-review', 'review']]);
  assert.deepEqual(sections[0].findings, [{ severity: 'major', file: 'src/discounts.js', line: 12, note: 'Rounds the wrong way.' }, { severity: 'minor', note: 'No test for an empty cart.' }]);
  assert.equal(ownerOf('src/discounts.js', jobs), 'discounts', 'the longest scope entry wins');
  assert.equal(ownerOf('src\\orders.js', jobs), 'api');
  assert.equal(ownerOf('README.md', jobs), undefined);
});

test('rows: the single agent\'s rounds, and a Hydra plan\'s rounds from its fix briefs plus its final gate, numbered alike', () => {
  const single = singleFindingRows({ rounds: [{ review: { verdict: 'fail', findings: [{ severity: 'major', file: 'src/a.js', note: 'x' }] } }, { review: { verdict: 'pass', findings: [{ severity: 'minor', note: 'y' }] } }] }, { task: 'discounts', run: 'r1-single' });
  assert.deepEqual(single.map((item: { round: number; final: boolean; severity: string }) => [item.round, item.final, item.severity]), [[1, false, 'major'], [2, true, 'minor']]);
  const fix1 = integrationFixJob({ title: 'D', jobs: [] }, failedGate([{ severity: 'blocker', file: 'src/discounts.js', note: 'z' }]) as never, 2)!;
  const plan = {
    startedAt: '2026-10-01T10:00:00.000Z', jobs: [...jobs, { key: 'integration-fix-1', brief: fix1.brief }],
    integration: { landed: [{ key: 'discounts', at: '2026-10-01T10:02:00.000Z' }, { key: 'api', at: '2026-10-01T10:05:30.000Z' }, { key: 'integration-fix-1', at: '2026-10-01T10:09:00.000Z' }], gate: { ...failedGate([{ severity: 'major', file: 'src/orders.js', note: 'w' }]), at: '2026-10-01T10:11:00.000Z' } },
  };
  const hydra = hydraFindingRows(plan, { task: 'discounts', run: 'r1-hydra' });
  assert.deepEqual(hydra.map((item: { round: number; final: boolean; job?: string; verdict: string }) => [item.round, item.final, item.job, item.verdict]), [[1, false, 'discounts', 'fail'], [2, true, 'api', 'fail']]);
  assert.deepEqual(hydraTiming(plan), { jobs: 2, firstLanding: 120, lastLanding: 330, fixLandings: [{ key: 'integration-fix-1', seconds: 540 }], gateEnd: 660 });
  const markdown = renderFindings([...single, ...hydra], [{ ...hydraTiming(plan), task: 'discounts', run: 'r1-hydra' }]);
  assert.ok(markdown.includes('| discounts | hydra | 1 | 1 | 1 | 1 | 0 | 0 |'), markdown);
  assert.ok(markdown.includes('| discounts | hydra | r1-hydra | 2 | yes | major | src/orders.js | api | | w |'), markdown);
  assert.ok(markdown.includes('| discounts | r1-hydra | 2 |  | 2m 00s | 5m 30s | integration-fix-1 9m 00s | 11m 00s |'), markdown);
});

test('benchmark.mjs findings reads run folders and the plan store, and writes the worksheet beside them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-findings-'));
  try {
    const single = path.join(root, 'bench-v2-discounts-r1-single'), hydra = path.join(root, 'bench-v2-discounts-r1-hydra');
    await mkdir(single); await mkdir(hydra);
    await writeFile(path.join(single, 'single-results.json'), JSON.stringify({ kind: 'single', task: 'discounts' }));
    await writeFile(path.join(single, 'single-review.json'), JSON.stringify({ rounds: [{ review: { verdict: 'fail', findings: [{ severity: 'major', file: 'src/api.js', note: 'Wrong total.' }] } }] }));
    await writeFile(path.join(hydra, 'hydra-results.json'), JSON.stringify({ kind: 'hydra', task: 'discounts', planId: 'abc123abc123' }));
    const store = path.join(root, 'plans.json');
    await writeFile(store, JSON.stringify({ plans: [{ id: 'abc123abc123', startedAt: '2026-10-01T10:00:00.000Z', jobs, integration: { landed: [], gate: failedGate([{ severity: 'major', file: 'src/discounts.js', note: 'Off by one.' }]) } }] }));
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'benchmark.mjs'), 'findings', '--runs', path.join(root, 'bench-v2-*'), '--plan-store', store], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const markdown = await readFile(path.join(root, 'findings.md'), 'utf8');
    assert.ok(markdown.includes('| discounts | single | bench-v2-discounts-r1-single | 1 | yes | major | src/api.js |  | | Wrong total. |'), markdown);
    assert.ok(markdown.includes('| discounts | hydra | bench-v2-discounts-r1-hydra | 1 | yes | major | src/discounts.js | discounts | | Off by one. |'), markdown);
  } finally { await rm(root, { recursive: true, force: true }); }
});

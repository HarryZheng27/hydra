// Plan v3, Phase A (docs/Benchmark.md, "Why a review failed"): every review finding of a set of runs, both setups and
// every round, in one table to sort by cause, and where each Hydra run's time went. Pure: benchmark.mjs findings reads
// the files and Hydra's plan store, and these turn them into rows and Markdown.
import { isFixJob } from './benchmark-lib.mjs';

/** The buckets Phase A sorts a finding into; the table leaves the column empty for a person (or an agent) to fill. */
export const findingBuckets = Object.freeze(['seam', 'spec miss', 'bug in one job', 'test gap', 'questionable']);

/**
 * The gates a fix brief lists as failed, each with its findings (pure): integrationFixJob's format
 * (src/core/integration.ts), `### <id> (<kind>) failed: <summary>` then `- [<severity>] <file>:<line>: <note>` lines.
 */
export function briefSections(brief) {
  const sections = [];
  for (const line of String(brief ?? '').split(/\r?\n/)) {
    const heading = /^### ([\w-]+) \((\w+)\) failed(?:: (.*))?$/.exec(line);
    if (heading) { sections.push({ id: heading[1], kind: heading[2], ...(heading[3] ? { summary: heading[3] } : {}), findings: [] }); continue; }
    const finding = /^- \[(blocker|major|minor)\](?: ([^\s:][^:]*?)(?::(\d+))?)?: (.*)$/.exec(line);
    if (finding && sections.length) sections[sections.length - 1].findings.push({ severity: finding[1], ...(finding[2] ? { file: finding[2] } : {}), ...(finding[3] ? { line: Number(finding[3]) } : {}), note: finding[4] });
  }
  return sections;
}

/** Which of a plan's own jobs wrote a file, by its write scope (pure): the job whose scope entry is the longest match. */
export function ownerOf(file, jobs) {
  if (!file) return undefined;
  const normal = String(file).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  let best;
  for (const job of jobs ?? []) for (const entry of job.writeScope ?? job.write_scope ?? []) {
    const scope = String(entry).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if ((normal === scope || normal.startsWith(`${scope}/`)) && (!best || scope.length > best.length)) best = { key: job.key, length: scope.length };
  }
  return best?.key;
}

const row = (base, finding) => ({ ...base, severity: finding.severity, ...(finding.file ? { file: finding.file } : {}), ...(finding.line ? { line: finding.line } : {}), note: String(finding.note ?? '') });

/**
 * The single agent's findings (pure), from single-review.json: one review per round, round 1 the first pass and the
 * last one the final review. A round's `fixed` says a fix round followed it.
 */
export function singleFindingRows(review, { task, run }) {
  const rounds = review?.rounds?.length ? review.rounds : review ? [{ review }] : [];
  return rounds.flatMap((round, index) => (round.review?.findings ?? []).map(finding => row({
    task, setup: 'single', run, round: index + 1, final: index === rounds.length - 1, verdict: round.review.verdict,
  }, finding)));
}

/**
 * A Hydra run's findings (pure): each fix job's brief holds the review it fixes (round N is `integration-fix-N`'s), and
 * the plan's integration gate record holds the final one. Each finding names the plan job whose write scope has its
 * file (`job`), from the plan's own jobs, or the jobs a plan run as one head did.
 */
export function hydraFindingRows(plan, { task, run }) {
  if (!plan) return [];
  const own = plan.singleHead?.jobs ?? (plan.jobs ?? []).filter(job => !isFixJob(job.key));
  const fixes = (plan.jobs ?? []).filter(job => isFixJob(job.key)).sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop()));
  const rows = [];
  fixes.forEach((fix, index) => {
    for (const section of briefSections(fix.brief).filter(item => item.kind === 'review')) {
      for (const finding of section.findings) rows.push({ ...row({ task, setup: 'hydra', run, round: index + 1, final: false, verdict: 'fail' }, finding), job: ownerOf(finding.file, own) });
    }
  });
  const review = (plan.integration?.gate?.checks ?? []).find(check => check.kind === 'review');
  for (const finding of review?.findings ?? []) {
    rows.push({ ...row({ task, setup: 'hydra', run, round: fixes.length + 1, final: true, verdict: review.state === 'passed' ? 'pass' : review.state === 'failed' ? 'fail' : 'not run' }, finding), job: ownerOf(finding.file, own) });
  }
  return rows;
}

const seconds = (from, at) => { const value = Math.round((Date.parse(at) - Date.parse(from)) / 1000); return Number.isFinite(value) ? value : undefined; };

/**
 * Where a Hydra run's time went, from its plan record (pure): when each of its own jobs and each fix job landed, and
 * when the integration gate last ran, in seconds from the plan's start. The finer split (head start, a job's own
 * gates, waiting on dependencies) is in Hydra's output log, which this doesn't read.
 */
export function hydraTiming(plan) {
  if (!plan?.startedAt) return undefined;
  const landed = {};
  for (const entry of plan.integration?.landed ?? []) { const value = seconds(plan.startedAt, entry.at); if (value !== undefined && !(landed[entry.key] <= value)) landed[entry.key] = value; }
  const ownTimes = Object.entries(landed).filter(([key]) => !isFixJob(key)).map(([, value]) => value);
  const fixTimes = Object.entries(landed).filter(([key]) => isFixJob(key)).sort(([a], [b]) => a.localeCompare(b));
  const gate = plan.integration?.gate?.at ? seconds(plan.startedAt, plan.integration.gate.at) : undefined;
  return {
    jobs: Object.keys(landed).filter(key => !isFixJob(key)).length, ...(plan.singleHead ? { singleHead: true } : {}),
    firstLanding: ownTimes.length ? Math.min(...ownTimes) : undefined, lastLanding: ownTimes.length ? Math.max(...ownTimes) : undefined,
    fixLandings: fixTimes.map(([key, value]) => ({ key, seconds: value })), gateEnd: gate,
  };
}

const minutes = value => typeof value === 'number' ? `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s` : '–';
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/**
 * The Phase A worksheet (pure): counts by task, setup and round, every finding with an empty bucket column, then the
 * Hydra timings. `runs` are `{ task, setup, run, ... }`, one per folder read, so a round with no findings still counts.
 */
export function renderFindings(rows, timings = []) {
  const lines = ['# Review findings', '', `Buckets: ${findingBuckets.join(', ')}. Fill the Bucket column; the counts below are by severity.`, ''];
  const key = item => `${item.task}\u0000${item.setup}\u0000${item.round}`;
  const groups = new Map();
  for (const item of rows) { if (!groups.has(key(item))) groups.set(key(item), []); groups.get(key(item)).push(item); }
  lines.push('| Task | Setup | Round | Runs with findings | Findings | Blocker | Major | Minor |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  const ordered = [...groups.values()].sort((a, b) => a[0].task.localeCompare(b[0].task) || a[0].setup.localeCompare(b[0].setup) || a[0].round - b[0].round);
  for (const group of ordered) {
    const count = severity => group.filter(item => item.severity === severity).length;
    lines.push(`| ${group[0].task} | ${group[0].setup} | ${group[0].round} | ${new Set(group.map(item => item.run)).size} | ${group.length} | ${count('blocker')} | ${count('major')} | ${count('minor')} |`);
  }
  lines.push('', '## Every finding', '', '| Task | Setup | Run | Round | Final | Severity | File | Job | Bucket | Note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const sorted = [...rows].sort((a, b) => a.task.localeCompare(b.task) || a.setup.localeCompare(b.setup) || a.run.localeCompare(b.run) || a.round - b.round);
  for (const item of sorted) lines.push(`| ${item.task} | ${item.setup} | ${item.run} | ${item.round} | ${item.final ? 'yes' : ''} | ${item.severity} | ${cell(item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '')} | ${cell(item.job)} | | ${cell(item.note)} |`);
  if (timings.length) {
    lines.push('', '## Where Hydra\'s time went', '', 'Seconds from the plan\'s start, from its plan record. Head starts, each job\'s own gates and waits on dependencies are in Hydra\'s output log.', '');
    lines.push('| Task | Run | Jobs | One head | First landing | Last own landing | Fix landings | Gate end |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const timing of [...timings].sort((a, b) => a.task.localeCompare(b.task) || a.run.localeCompare(b.run))) {
      lines.push(`| ${timing.task} | ${timing.run} | ${timing.jobs} | ${timing.singleHead ? 'yes' : ''} | ${minutes(timing.firstLanding)} | ${minutes(timing.lastLanding)} | ${timing.fixLandings.map(fix => `${fix.key} ${minutes(fix.seconds)}`).join(', ') || '–'} | ${minutes(timing.gateEnd)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

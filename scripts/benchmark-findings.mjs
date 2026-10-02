// Plan v3, Phase A (docs/Benchmark.md, "Why a review failed"): every review finding of a set of runs, both setups and
// every round, in one table to sort by cause, and where each Hydra run's time went. Pure: benchmark.mjs findings reads
// the files and Hydra's plan store, and these turn them into rows and Markdown.
import { isFixJob } from './benchmark-lib.mjs';

/** The buckets Phase A sorts a finding into; the table leaves the column empty for a person (or an agent) to fill. */
export const findingBuckets = Object.freeze(['seam', 'spec miss', 'bug in one job', 'test gap', 'questionable']);

/** One `- [severity] …` line of a fix brief (pure): file, line (a column after it is dropped) and note; a line in no known shape keeps its text as the note. */
function parseFindingLine(line) {
  const head = /^- \[(blocker|major|minor)\](.*)$/.exec(line);
  if (!head) return undefined;
  const rest = head[2];
  if (rest.startsWith(': ')) return { severity: head[1], note: rest.slice(2) };
  const located = /^ ((?:[A-Za-z]:)?[^:]*?)(?::(\d+))?(?::\d+)?: (.*)$/.exec(rest);
  if (located) return { severity: head[1], file: located[1], ...(located[2] ? { line: Number(located[2]) } : {}), note: located[3] };
  return { severity: head[1], note: rest.trim(), unparsed: true };
}

/**
 * The gates a fix brief lists as failed, each with its findings (pure): integrationFixJob's format
 * (src/core/integration.ts), `### <id> (<kind>) failed: <summary>` then `- [<severity>] <file>:<line>: <note>` lines.
 * `cut` says the brief hit its length limit, so the last section may be missing findings.
 */
export function briefSections(brief) {
  const sections = [];
  const text = String(brief ?? '');
  for (const line of text.split(/\r?\n/)) {
    const heading = /^### ([\w-]+) \((\w+)\) failed(?:: (.*))?$/.exec(line);
    if (heading) { sections.push({ id: heading[1], kind: heading[2], ...(heading[3] ? { summary: heading[3] } : {}), findings: [] }); continue; }
    const finding = parseFindingLine(line);
    if (finding && sections.length) sections[sections.length - 1].findings.push(finding);
  }
  if (text.endsWith('…') && sections.length) sections[sections.length - 1].cut = true;
  return sections;
}

const normalPath = value => String(value ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();

/**
 * Which of a plan's own jobs wrote a file, by its write scope (pure): the job whose scope entry is the longest match.
 * An empty entry or `.` is the whole repository, the shortest match of all.
 */
export function ownerOf(file, jobs) {
  if (!file) return undefined;
  const normal = normalPath(file);
  let best;
  for (const job of jobs ?? []) for (const entry of job.writeScope ?? job.write_scope ?? []) {
    const scope = normalPath(entry) === '.' ? '' : normalPath(entry);
    if ((scope === '' || normal === scope || normal.startsWith(`${scope}/`)) && (!best || scope.length > best.length)) best = { key: job.key, length: scope.length };
  }
  return best?.key;
}

const row = (base, finding) => ({ ...base, severity: finding.severity, ...(finding.file ? { file: finding.file } : {}), ...(finding.line ? { line: finding.line } : {}), note: String(finding.note ?? ''), ...(finding.unparsed ? { unparsed: true } : {}) });

/** The single agent's reviews (pure), from single-review.json: one per round, round 1 the first pass and the last one the final review. */
export function singleReviews(review, { task, run }) {
  const rounds = review?.rounds?.length ? review.rounds : review ? [{ review }] : [];
  return rounds.map((round, index) => ({ task, setup: 'single', run, round: index + 1, final: index === rounds.length - 1, verdict: round.review?.verdict ?? 'not run', findings: round.review?.findings ?? [] }));
}

/**
 * A Hydra run's reviews (pure). Each fix job's brief quotes the review it fixes (round N is `integration-fix-N`'s), at
 * most 20 findings a gate, cut at 4,000 characters: `partial` marks those rounds, whose counts are lower bounds, and
 * `cut` a brief that hit its limit. The plan's integration gate record holds the final review, unless it is stale: still
 * running, for another tip, or the one the last fix job quoted and never landed a fix for.
 */
export function hydraReviews(plan, { task, run }) {
  if (!plan) return [];
  const fixes = (plan.jobs ?? []).filter(job => isFixJob(job.key)).sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop()));
  const reviews = [];
  fixes.forEach((fix, index) => {
    const sections = briefSections(fix.brief);
    const review = sections.find(item => item.kind === 'review');
    reviews.push({ task, setup: 'hydra', run, round: index + 1, final: false, verdict: review ? 'fail' : sections.length ? 'not run' : 'unknown', findings: review?.findings ?? [], partial: true, ...(sections.some(item => item.cut) ? { cut: true } : {}) });
  });
  const integration = plan.integration;
  const gate = integration?.gate;
  const landed = new Set((integration?.landed ?? []).map(entry => entry.key));
  const lastFix = fixes[fixes.length - 1];
  const stale = !gate || gate.running || (gate.tip && integration.tip && gate.tip !== integration.tip) || (lastFix && !landed.has(lastFix.key));
  const check = stale ? undefined : (gate.checks ?? []).find(item => item.kind === 'review');
  if (check) reviews.push({ task, setup: 'hydra', run, round: fixes.length + 1, final: true, verdict: check.state === 'passed' ? 'pass' : check.state === 'failed' ? 'fail' : 'not run', findings: check.findings ?? [] });
  else if (reviews.length) reviews[reviews.length - 1].final = true;
  return reviews;
}

/** One row per finding of the given reviews (pure), with the plan job whose write scope holds its file when `jobs` are given. */
export function findingRows(reviews, jobs) {
  return reviews.flatMap(review => review.findings.map(finding => ({
    ...row({ task: review.task, setup: review.setup, run: review.run, round: review.round, final: review.final, verdict: review.verdict, ...(review.partial ? { partial: true } : {}) }, finding),
    ...(jobs ? { job: ownerOf(finding.file, jobs) } : {}),
  })));
}
/** The single agent's finding rows (pure). */
export const singleFindingRows = (review, where) => findingRows(singleReviews(review, where));
/** A Hydra run's finding rows (pure), each naming the plan job its file belongs to: of the plan's own jobs, or the jobs a plan run as one head did. */
export const hydraFindingRows = (plan, where) => findingRows(hydraReviews(plan, where), plan?.singleHead?.jobs ?? (plan?.jobs ?? []).filter(job => !isFixJob(job.key)));

const seconds = (from, at) => { const value = Math.round((Date.parse(at) - Date.parse(from)) / 1000); return Number.isFinite(value) ? value : undefined; };

/**
 * Where a Hydra run's time went, from its plan record (pure): when each of its own jobs and each fix job first landed,
 * and when the integration gate last ran, in seconds from the plan's start. The finer split (head start, a job's own
 * gates, waiting on dependencies) is in Hydra's output log, which this doesn't read.
 */
export function hydraTiming(plan) {
  if (!plan?.startedAt) return undefined;
  const landed = {};
  for (const entry of plan.integration?.landed ?? []) { const value = seconds(plan.startedAt, entry.at); if (value !== undefined && !(landed[entry.key] <= value)) landed[entry.key] = value; }
  const own = (plan.jobs ?? []).filter(job => !isFixJob(job.key));
  const ownTimes = own.map(job => landed[job.key]).filter(value => value !== undefined);
  const fixTimes = Object.entries(landed).filter(([key]) => isFixJob(key)).sort(([a], [b]) => Number(a.split('-').pop()) - Number(b.split('-').pop()));
  const gate = plan.integration?.gate?.at ? seconds(plan.startedAt, plan.integration.gate.at) : undefined;
  return {
    jobs: own.length, landed: ownTimes.length, ...(plan.singleHead ? { singleHead: true } : {}),
    firstLanding: ownTimes.length ? Math.min(...ownTimes) : undefined, lastLanding: ownTimes.length ? Math.max(...ownTimes) : undefined,
    fixLandings: fixTimes.map(([key, value]) => ({ key, seconds: value })), gateEnd: gate,
  };
}

const minutes = value => typeof value === 'number' ? `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s` : '–';
const cell = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const code = value => value ? `\`${String(value).replace(/`/g, "'").replace(/\|/g, '\\|')}\`` : '';

/**
 * The Phase A worksheet (pure): reviews and findings by task, setup and round (a review with no findings counts too),
 * every finding with an empty Bucket column, then the Hydra timings.
 */
export function renderFindings(reviews, rows, timings = []) {
  const lines = ['# Review findings', '', `Buckets: ${findingBuckets.join(', ')}. Fill the Bucket column.`, '',
    'Round 1 is the first-pass review and the last round the final one. Hydra\'s rounds before its final one are read from its fix jobs\' briefs, which quote at most 20 findings a gate and are cut at 4,000 characters: their counts are lower bounds, marked *, and a brief that was cut is marked "cut".', ''];
  const key = item => `${item.task}\u0000${item.setup}\u0000${item.round}`;
  const groups = new Map();
  for (const review of reviews) { if (!groups.has(key(review))) groups.set(key(review), { ...review, reviews: [], rows: [] }); groups.get(key(review)).reviews.push(review); }
  for (const item of rows) { if (!groups.has(key(item))) groups.set(key(item), { ...item, reviews: [], rows: [] }); groups.get(key(item)).rows.push(item); }
  lines.push('| Task | Setup | Round | Reviews | Failed | Findings | Blocker | Major | Minor |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const ordered = [...groups.values()].sort((a, b) => a.task.localeCompare(b.task) || a.setup.localeCompare(b.setup) || a.round - b.round);
  for (const group of ordered) {
    const count = severity => group.rows.filter(item => item.severity === severity).length;
    const lower = group.reviews.some(review => review.partial) ? '*' : '';
    const cut = group.reviews.filter(review => review.cut).length;
    lines.push(`| ${cell(group.task)} | ${group.setup} | ${group.round} | ${group.reviews.length} | ${group.reviews.filter(review => review.verdict === 'fail').length} | ${group.rows.length}${lower}${cut ? ` (${cut} cut)` : ''} | ${count('blocker')} | ${count('major')} | ${count('minor')} |`);
  }
  lines.push('', '## Every finding', '', '| Task | Setup | Run | Round | Final | Severity | File | Job | Bucket | Note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const sorted = [...rows].sort((a, b) => a.task.localeCompare(b.task) || a.setup.localeCompare(b.setup) || a.run.localeCompare(b.run) || a.round - b.round);
  for (const item of sorted) lines.push(`| ${cell(item.task)} | ${item.setup} | ${cell(item.run)} | ${item.round} | ${item.final ? 'yes' : ''} | ${item.severity} | ${code(item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '')} | ${cell(item.job)} | | ${cell(item.note)}${item.unparsed ? ' (line not in the usual shape)' : ''} |`);
  if (timings.length) {
    lines.push('', '## Where Hydra\'s time went', '', 'Seconds from the plan\'s start, from its plan record. Head starts, each job\'s own gates and waits on dependencies are in Hydra\'s output log.', '');
    lines.push('| Task | Run | Jobs landed | One head | First landing | Last own landing | Fix landings | Gate end |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const timing of [...timings].sort((a, b) => a.task.localeCompare(b.task) || a.run.localeCompare(b.run))) {
      lines.push(`| ${cell(timing.task)} | ${cell(timing.run)} | ${timing.landed} of ${timing.jobs} | ${timing.singleHead ? 'yes' : ''} | ${minutes(timing.firstLanding)} | ${minutes(timing.lastLanding)} | ${timing.fixLandings.map(fix => `${fix.key} ${minutes(fix.seconds)}`).join(', ') || '–'} | ${minutes(timing.gateEnd)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

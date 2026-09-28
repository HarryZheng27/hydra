// O9 (docs/Benchmark.md): the benchmark's pure parts, so tests can check them without an agent. scripts/benchmark.mjs
// is the effectful shell that prepares the repositories, runs Hydra and the single agent, and writes the results.

/** The default fixture's tasks: plan files in bench/fixture/.hydra/plans. */
export const tasks = Object.freeze(['discounts', 'shop-features']);

/**
 * Fixtures (--fixture): `shop`, the default, is bench/fixture (the tasks above); any other name is
 * bench/fixtures/<name>, whose tasks are the plan files in its own .hydra/plans.
 */
export const defaultFixture = 'shop';
export function fixturePath(root, name) {
  const fixture = name ?? defaultFixture;
  if (fixture === defaultFixture) return `${root}/bench/fixture`;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fixture)) throw new Error(`--fixture ${fixture} isn't a fixture name.`);
  return `${root}/bench/fixtures/${fixture}`;
}
/** A fixture's task, from --task and the fixture's plan files (pure): the default fixture's is discounts; another fixture with one plan defaults to it. */
export function pickTask(fixture, available, wanted) {
  const task = wanted ?? (fixture === defaultFixture || fixture === undefined ? 'discounts' : available.length === 1 ? available[0] : undefined);
  if (!task || !available.includes(task)) throw new Error(`--task is one of ${available.join(', ')}.`);
  return task;
}
/** Files in a fixture that only the harness reads: the single agent's prompt and the hidden check. prepare leaves them out of the repositories. */
export const harnessOnlyFiles = Object.freeze(['prompt.md', 'check.mjs']);
/** How a run is labelled in summaries: the task, prefixed with its fixture unless it's the default one. */
export const taskLabel = result => !result.fixture || result.fixture === defaultFixture ? (result.task ?? 'discounts') : `${result.fixture}/${result.task ?? result.fixture}`;

/**
 * The single agent's brief (pure): the plan file's own brief and every job's, in order, so both sides of the
 * benchmark are given exactly the same work. Each bench/fixtures/<name>/prompt.md is this, checked in, and
 * tests/benchmark.test.ts keeps the two the same.
 */
export function taskFromPlan(plan) {
  const lines = [`# ${plan.title}`, '', plan.brief ?? '', '', 'Do all of the following yourself, then make sure `npm test` passes.', ''];
  plan.jobs.forEach((job, index) => lines.push(`## ${index + 1}. ${job.title}`, '', job.brief, '', `Files: ${job.write_scope.join(', ')}`, ''));
  return lines.join('\n').trimEnd() + '\n';
}

/** Results files carry this, so a later format change can't be misread as the old one. */
export const resultsVersion = 1;
export const resultsStart = '<!-- benchmark-results:start -->';
export const resultsEnd = '<!-- benchmark-results:end -->';

/**
 * What watching a plan (hydra plan show --json, every few seconds) has seen so far (pure): each job's head ids in
 * order, conflicts predicted while heads ran (with other heads, or with the integration branch), the landing
 * conflicts that sent a job back (a new head for a job whose previous head had passed its gates, or a job held
 * with its conflict files), and, given `atSeconds` (seconds since the run started), when each job was first seen
 * landed on the integration branch.
 */
export function observePlan(previous, view, atSeconds) {
  const seen = previous ?? { heads: {}, predicted: {}, landingConflicts: {}, held: {}, landedAt: {} };
  const next = { heads: { ...seen.heads }, predicted: { ...seen.predicted }, landingConflicts: { ...seen.landingConflicts }, held: { ...seen.held }, landedAt: { ...seen.landedAt } };
  for (const job of view.jobs ?? []) {
    const head = job.head;
    const history = next.heads[job.key] ?? [];
    if (head?.job_id) {
      const last = history[history.length - 1];
      if (!last || last.id !== head.job_id) {
        // A new head for this job after one that finished its own work: its landing conflicted.
        if (last && last.state === 'done') next.landingConflicts[job.key] = (next.landingConflicts[job.key] ?? 0) + 1;
        next.heads[job.key] = [...history, { id: head.job_id, state: head.state }];
      } else next.heads[job.key] = [...history.slice(0, -1), { id: head.job_id, state: head.state }];
      const predicted = new Set(next.predicted[job.key] ?? []);
      for (const conflict of head.predicted_conflicts ?? []) for (const file of conflict.files ?? []) predicted.add(`head ${conflict.head}: ${file}`);
      for (const file of head.integration_conflict?.files ?? []) predicted.add(`${head.integration_conflict.branch}: ${file}`);
      if (predicted.size) next.predicted[job.key] = [...predicted].sort();
    }
    if (job.conflict_files?.length) next.held[job.key] = [...job.conflict_files];
  }
  if (typeof atSeconds === 'number') for (const key of view.integration?.landed ?? []) if (next.landedAt[key] === undefined) next.landedAt[key] = Math.round(atSeconds);
  return next;
}

/** A job the plan added itself, to fix what a failed integration gate found (src/core/integration.ts, integrationFixKey). */
export const isFixJob = key => /^integration-fix-\d+$/.test(String(key));
/** The review among the integration gate's checks: by kind, or, in results from before kinds were kept, by rigor's id. */
const reviewCheckOf = checks => (checks ?? []).find(check => check.kind === 'review' || (!check.kind && check.id === 'rigor-review'));

/**
 * Hydra's time to working code (pure): when the last of the plan's own jobs landed on the integration branch, in
 * seconds from the start. The fix jobs a failed integration gate adds don't count: they come after the work is
 * done. Null when any of the plan's own jobs never landed.
 */
export function workDoneSeconds(jobKeys, landedAtSeconds) {
  const keys = jobKeys.filter(key => !isFixJob(key));
  if (!keys.length || keys.some(key => typeof landedAtSeconds?.[key] !== 'number')) return null;
  return Math.max(...keys.map(key => landedAtSeconds[key]));
}

/**
 * When each job landed, from Hydra's own plan store (plans.json, whose integration.landed entries carry the time),
 * in seconds from `startedMs` (the benchmark's own start), else from the plan's start (pure). Exact, where watching
 * the plan is only as fine as its polling.
 */
export function landingFromStore(plan, startedMs) {
  const start = startedMs ?? Date.parse(plan.startedAt ?? plan.createdAt);
  const landedAtSeconds = {};
  for (const entry of plan.integration?.landed ?? []) {
    const seconds = Math.round((Date.parse(entry.at) - start) / 1000);
    if (Number.isFinite(seconds) && !(landedAtSeconds[entry.key] >= seconds)) landedAtSeconds[entry.key] = seconds;
  }
  return { startedAt: new Date(start).toISOString(), landedAtSeconds, jobKeys: (plan.jobs ?? []).map(job => job.key) };
}

/**
 * Hydra's run, summed up from the final plan view and what watching it saw (pure). `landing` (landingFromStore),
 * when Hydra's plan store could be read, gives exact landing times; otherwise they're as watching saw them.
 */
export function summarizeHydra({ view, observed, wallClockSeconds, passed, timedOut, task, fixture, startedAt, landing }) {
  const jobs = (view.jobs ?? []).map(job => ({
    key: job.key, status: job.status,
    ...(job.head ? { provider: job.head.provider, attempts: job.head.attempts } : {}),
    ...(job.head?.usage ? { usage: job.head.usage } : {}),
  }));
  let usd = 0, usdJobs = 0, inputTokens = 0, outputTokens = 0, tokenJobs = 0;
  for (const job of view.jobs ?? []) {
    const usage = job.head?.usage;
    if (usage?.cost_usd !== undefined) { usd += usage.cost_usd; usdJobs++; }
    if (usage?.input_tokens !== undefined || usage?.output_tokens !== undefined) { inputTokens += usage.input_tokens ?? 0; outputTokens += usage.output_tokens ?? 0; tokenJobs++; }
  }
  const integration = view.integration;
  const review = reviewCheckOf(integration?.gate?.checks);
  const landedAtSeconds = { ...(observed?.landedAt ?? {}), ...(landing?.landedAtSeconds ?? {}) };
  return {
    version: resultsVersion, kind: 'hydra', ...(fixture ? { fixture } : {}), ...(task ? { task } : {}), planId: view.plan_id, planState: view.state,
    ...(startedAt ? { startedAt } : {}), wallClockSeconds, timedOut: !!timedOut,
    timeToWorkingCodeSeconds: workDoneSeconds(jobs.map(job => job.key), landedAtSeconds),
    landedAtSeconds, landingTimesFrom: landing ? 'plan store' : 'watching',
    integrationGate: integration ? { label: integration.gate?.label, passed: !!passed, checks: (integration.gate?.checks ?? []).map(check => ({ id: check.id, ...(check.kind ? { kind: check.kind } : {}), state: check.state })) } : null,
    review: review ? { id: review.id, state: review.state, passed: review.state === 'passed', ...(review.summary ? { summary: String(review.summary).slice(0, 1000) } : {}) } : null,
    fixRounds: jobs.filter(job => isFixJob(job.key)).length,
    landed: integration?.landed ?? [],
    jobs,
    conflicts: {
      predicted: Object.values(observed?.predicted ?? {}).reduce((sum, files) => sum + files.length, 0),
      predictedByJob: observed?.predicted ?? {},
      landingConflicts: Object.values(observed?.landingConflicts ?? {}).reduce((sum, count) => sum + count, 0) + Object.keys(observed?.held ?? {}).length,
    },
    amendments: (view.amendments ?? []).length,
    cost: { usd: Math.round(usd * 1e4) / 1e4, usdJobs, inputTokens, outputTokens, tokenJobs, jobs: jobs.length },
  };
}

/** The single agent's run (pure). `agentOutput` is Claude Code's --output-format json result, when that's the agent. */
export function summarizeSingle({ agent, wallClockSeconds, exitCode, gatePassed, gateOutput, agentOutput, codexUsage, task, fixture, startedAt }) {
  const usd = typeof agentOutput?.total_cost_usd === 'number' ? agentOutput.total_cost_usd : undefined;
  return {
    version: resultsVersion, kind: 'single', ...(fixture ? { fixture } : {}), ...(task ? { task } : {}), agent, ...(startedAt ? { startedAt } : {}), wallClockSeconds, agentExitCode: exitCode,
    gate: { passed: !!gatePassed, outputTail: String(gateOutput ?? '').slice(-2000) },
    cost: { ...(usd !== undefined ? { usd } : {}), ...(codexUsage ? { inputTokens: codexUsage.inputTokens, outputTokens: codexUsage.outputTokens } : {}) },
    ...(typeof agentOutput?.num_turns === 'number' ? { turns: agentOutput.num_turns } : {}),
  };
}

/**
 * A fixture's hidden check (bench/fixtures/<name>/check.mjs), from its output and exit code (pure). The check prints
 * one line per check and ends with a JSON line: {"checks": <n>, "passed": <n>, "failed": ["<name>", …]}.
 */
export function parseCheckOutput(stdout, exitCode, seconds) {
  const text = String(stdout ?? '');
  const lines = text.trim().split(/\r?\n/);
  let summary;
  for (let index = lines.length - 1; index >= 0 && !summary; index--) {
    try { const value = JSON.parse(lines[index]); if (value && typeof value.checks === 'number') summary = value; } catch { /* not the summary line */ }
  }
  const timing = seconds !== undefined ? { seconds } : {};
  if (!summary) return { passed: false, error: `the check printed no summary (exit ${exitCode})`, ...timing, outputTail: text.slice(-2000) };
  const failed = Array.isArray(summary.failed) ? summary.failed.map(String) : [];
  return { passed: exitCode === 0 && !failed.length && summary.passed === summary.checks, checks: summary.checks, passedChecks: summary.passed, failed, ...timing, outputTail: text.slice(-2000) };
}

/**
 * The review of a single agent's result (benchmark.mjs review) from the checks run on it (pure): the project's
 * command gates, then one review by the other agent, as a plan's integration gate runs them.
 */
export function summarizeReview({ checks, durationMs, startedAt, base, head, committedLeftovers, fixture, task }) {
  const review = checks.find(check => check.kind === 'review');
  const verdict = !review ? 'not run' : review.state === 'passed' ? 'pass' : review.state === 'failed' ? 'fail' : 'not run';
  return {
    version: resultsVersion, kind: 'single-review', ...(fixture ? { fixture } : {}), ...(task ? { task } : {}), startedAt, durationSeconds: Math.round(durationMs / 1000),
    base, head, committedLeftovers: !!committedLeftovers,
    verdict, gatesPassed: checks.every(check => !(check.required && check.state === 'failed')),
    ...(review?.reviewer ? { reviewer: review.reviewer } : {}),
    ...(review?.summary ? { summary: review.summary } : {}),
    findings: review?.findings ?? [],
    checks: checks.map(check => ({ id: check.id, kind: check.kind, state: check.state, required: check.required, durationSeconds: Math.round((check.durationMs ?? 0) / 1000), ...(check.summary ? { summary: String(check.summary).slice(0, 1000) } : {}) })),
  };
}
/** The single results with their review's verdict and timing added (pure). */
export function withReview(single, review) {
  const count = severity => review.findings.filter(finding => finding.severity === severity).length;
  return {
    ...single,
    review: {
      verdict: review.verdict, passed: review.verdict === 'pass', gatesPassed: review.gatesPassed, durationSeconds: review.durationSeconds,
      ...(review.reviewer ? { reviewer: review.reviewer } : {}), findings: { blocker: count('blocker'), major: count('major'), minor: count('minor') },
    },
  };
}

// ---- summarize: many runs, grouped by task and setup ----

export const setups = Object.freeze(['single', 'single+review', 'hydra']);

/**
 * One row per setup a results file stands for (pure): a single run is "single", and also "single+review" once
 * reviewed; a Hydra run is "hydra". `fallback` fills Hydra's time to working code for results from before it was
 * recorded (landingFromStore on the plan in Hydra's store).
 */
export function runRows(result, folder, fallback) {
  if (result.kind === 'single') {
    const base = {
      folder, task: taskLabel(result), workSeconds: result.gate?.passed ? result.wallClockSeconds : null, totalSeconds: result.wallClockSeconds,
      usd: result.cost?.usd, gatePassed: !!result.gate?.passed, checkPassed: result.check ? !!result.check.passed : undefined,
    };
    const rows = [{ ...base, setup: 'single' }];
    if (result.review) rows.push({ ...base, setup: 'single+review', totalSeconds: result.wallClockSeconds + (result.review.durationSeconds ?? 0), reviewPassed: !!result.review.passed, reviewSeconds: result.review.durationSeconds });
    return rows;
  }
  if (result.kind === 'hydra') {
    let work = result.timeToWorkingCodeSeconds;
    if (work === undefined && fallback) work = workDoneSeconds(fallback.jobKeys?.length ? fallback.jobKeys : (result.jobs ?? []).map(job => job.key), fallback.landedAtSeconds);
    const review = result.review ?? (() => { const check = reviewCheckOf(result.integrationGate?.checks); return check ? { passed: check.state === 'passed' } : undefined; })();
    return [{
      folder, task: taskLabel(result), setup: 'hydra', workSeconds: work ?? null, totalSeconds: result.wallClockSeconds,
      usd: result.cost?.usdJobs ? result.cost.usd : undefined, gatePassed: !!result.integrationGate?.passed,
      reviewPassed: review ? !!review.passed : undefined, fixRounds: result.fixRounds ?? (result.jobs ?? []).filter(job => isFixJob(job.key)).length,
      checkPassed: result.check ? !!result.check.passed : undefined,
    }];
  }
  return [];
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
/** "median (min–max)" of the numbers among `values`, with "k of n" when some runs have none (pure). */
export function spread(values, format) {
  const numbers = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!numbers.length) return '–';
  const [low, high] = [Math.min(...numbers), Math.max(...numbers)];
  const text = numbers.length === 1 ? format(numbers[0]) : `${format(median(numbers))} (${format(low)}–${format(high)})`;
  return numbers.length < values.length ? `${text}; ${numbers.length} of ${values.length} runs` : text;
}
/** "k/n" of the booleans among `values` (pure); "–" when none apply. */
export function rate(values) {
  const known = values.filter(value => typeof value === 'boolean');
  return known.length ? `${known.filter(Boolean).length}/${known.length}` : '–';
}

const duration = seconds => minutes(seconds);
const dollars = value => `$${value.toFixed(2)}`;
const count = value => String(Math.round(value * 10) / 10);

/**
 * The summary of many runs (pure): a table per task and setup with the median and min–max of time to working code,
 * total time and reported cost, then the gate, review and check pass rates and fix rounds; then every run, one line
 * each, so nothing is hidden behind a median.
 */
export function renderSummary(rows) {
  const order = setup => setups.indexOf(setup);
  const groups = new Map();
  for (const row of [...rows].sort((a, b) => a.task.localeCompare(b.task) || order(a.setup) - order(b.setup) || a.folder.localeCompare(b.folder))) {
    const key = `${row.task}\u0000${row.setup}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const lines = ['| Task | Setup | Runs | Time to working code | Total time | Cost reported | Gate passed | Review passed | Fix rounds | Check passed |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const group of groups.values()) {
    const { task, setup } = group[0];
    lines.push(`| ${task} | ${setup} | ${group.length} | ${spread(group.map(row => row.workSeconds), duration)} | ${spread(group.map(row => row.totalSeconds), duration)} | ${spread(group.map(row => row.usd), dollars)} | ${rate(group.map(row => row.gatePassed))} | ${rate(group.map(row => row.reviewPassed))} | ${spread(group.map(row => row.fixRounds), count)} | ${rate(group.map(row => row.checkPassed))} |`);
  }
  lines.push('', 'Time to working code: for one agent, its run when `npm test` passed after it; for Hydra, when the last of the plan\'s own jobs landed. Total time adds the review for single+review, and for Hydra runs until the integration gate settled. A median over an even count is the mean of the middle two.', '');
  lines.push('| Run | Task | Setup | Working code | Total | Cost | Gate | Review | Fix rounds | Check |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const yes = value => value === undefined ? '–' : value ? 'passed' : 'failed';
  for (const group of groups.values()) for (const row of group) {
    lines.push(`| ${row.folder} | ${row.task} | ${row.setup} | ${typeof row.workSeconds === 'number' ? duration(row.workSeconds) : '–'} | ${duration(row.totalSeconds ?? 0)} | ${row.usd !== undefined ? dollars(row.usd) : '–'} | ${yes(row.gatePassed)} | ${yes(row.reviewPassed)} | ${row.fixRounds ?? '–'} | ${yes(row.checkPassed)} |`);
  }
  return lines.join('\n') + '\n';
}

/** A glob segment (`*` and `?` only) as a regular expression (pure); case-insensitive, as Windows paths are. */
export function globSegment(segment) {
  return new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

const minutes = value => { const seconds = Math.round(value); return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`; };
const cost = result => {
  const parts = [];
  if (result.cost?.usd !== undefined && (result.kind === 'single' || result.cost.usdJobs)) parts.push(`$${result.cost.usd.toFixed(2)}${result.kind === 'hydra' && result.cost.usdJobs < result.cost.jobs ? ` (${result.cost.usdJobs} of ${result.cost.jobs} jobs)` : ''}`);
  if (result.cost?.inputTokens || result.cost?.outputTokens) parts.push(`${result.cost.inputTokens} in / ${result.cost.outputTokens} out tokens`);
  return parts.join(', ') || 'not reported';
};

/** The results section of docs/Benchmark.md (pure): every run, failures included, newest first. */
export function renderResults(runs) {
  if (!runs.length) return 'No run has been published yet.';
  const sorted = [...runs].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const lines = [];
  for (const run of sorted) {
    const { hydra, single } = run;
    const task = hydra?.task ?? single?.task ?? 'discounts';
    lines.push(`### ${run.at.slice(0, 10)}${run.label ? `: ${run.label}` : ''}`, '', 'Task: `' + task + '`' + (hydra ? ` (${hydra.jobs.length} jobs)` : '') + '.', '');
    lines.push('| | Hydra (plan, unattended) | One agent alone |', '| --- | --- | --- |');
    lines.push(`| Wall-clock | ${hydra ? minutes(hydra.wallClockSeconds) + (hydra.timedOut ? ' (timed out)' : '') : '–'} | ${single ? `${minutes(single.wallClockSeconds)} (${single.agent})` : '–'} |`);
    lines.push(`| Gates at the end | ${hydra ? (hydra.integrationGate ? `${hydra.integrationGate.label}${hydra.integrationGate.passed ? '' : ' (did not pass)'}` : 'no integration gate') : '–'} | ${single ? (single.gate.passed ? '`npm test` passed' : '`npm test` failed') : '–'} |`);
    lines.push(`| Conflicts predicted / caught at landing | ${hydra ? `${hydra.conflicts.predicted} / ${hydra.conflicts.landingConflicts}` : '–'} | n/a |`);
    lines.push(`| Amendments | ${hydra ? hydra.amendments : '–'} | n/a |`);
    lines.push(`| Cost (as the providers reported it) | ${hydra ? cost(hydra) : '–'} | ${single ? cost(single) : '–'} |`);
    if (hydra) lines.push(`| Plan | ${hydra.planState}; ${hydra.jobs.filter(job => job.status === 'done').length} of ${hydra.jobs.length} jobs done | |`);
    lines.push('');
    if (run.notes) lines.push(run.notes, '');
  }
  return lines.join('\n').trimEnd();
}

/** docs/Benchmark.md with its results section replaced (pure); throws when the markers are missing. */
export function withResults(doc, runs) {
  const start = doc.indexOf(resultsStart), end = doc.indexOf(resultsEnd);
  if (start < 0 || end < start) throw new Error('docs/Benchmark.md has no results markers.');
  return `${doc.slice(0, start + resultsStart.length)}\n${renderResults(runs)}\n${doc.slice(end)}`;
}

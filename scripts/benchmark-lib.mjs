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

/** The Hydra run's default budget in dollars (`--usd`), and what Hydra assumes one job costs: it refuses to add a job when the job count times this would pass the budget. */
export const defaultUsd = 80;
export const jobCostUsd = 5;
/** How many automatic fix rounds Hydra's integration gate has (`hydra.plans.integrationFixRounds`, `defaultIntegrationFixRounds` in src/core/integration.ts): the single agent gets as many (`review --fix-rounds`). */
export const defaultFixRounds = 2;

/**
 * How long to wait before the next look at the plan (pure). Every `hydra plan show` makes Hydra check the process
 * table (2 to 6 seconds of PowerShell on Windows), so the watching starts at `baseMs` (10 seconds by default) and
 * backs off while the plan is steady: x1.5 after 3 looks with nothing new, x2 after 6, x3 after 9. Anything new
 * (`steadyPolls` back to 0) goes back to the base.
 */
export const defaultPollSeconds = 10;
export function pollDelayMs(baseMs, steadyPolls) {
  const steady = Math.max(0, steadyPolls | 0);
  const factor = steady >= 9 ? 3 : steady >= 6 ? 2 : steady >= 3 ? 1.5 : 1;
  return Math.round(baseMs * factor);
}
/** What about a plan view changes when something happened (pure): the state, each job's status and head state, what landed, and the gate. Two equal signatures are a steady plan. */
export function planSignature(view) {
  return JSON.stringify([
    view?.state, (view?.jobs ?? []).map(job => [job.key, job.status, job.head?.job_id, job.head?.state, job.head?.attempts]),
    view?.integration?.landed?.length, view?.integration?.tip, view?.integration?.gate?.label, view?.integration?.gate?.running, (view?.amendments ?? []).length,
  ]);
}

/**
 * Where the tools the harness runs usually live when they aren't on PATH (pure): Claude Code's installer, Hydra's
 * installer, and npm's global folder for Codex (Hydra's own findProvider looks on PATH only).
 */
export function defaultToolLocations(name, env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const join = (...parts) => parts.filter(Boolean).join('\\');
    if (name === 'claude') return env.USERPROFILE ? [join(env.USERPROFILE, '.local', 'bin', 'claude.exe')] : [];
    if (name === 'hydra') return env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Hydra', 'bin', 'hydra.cmd')] : [];
    if (name === 'codex') return env.APPDATA ? [join(env.APPDATA, 'npm', 'codex.cmd'), join(env.APPDATA, 'npm', 'codex.exe')] : [];
    return [];
  }
  if (name === 'claude' && env.HOME) return [`${env.HOME}/.local/bin/claude`];
  return [];
}
/**
 * The command that runs a tool (pure apart from `exists`): what the flag says, else the tool on PATH (as Hydra's
 * findProvider looks: name.exe, .cmd, .bat on Windows), else its usual install location if a file is there, else the
 * bare name. `source` says which, and the harness logs it.
 */
export function resolveTool(name, { flag, env = process.env, platform = process.platform, exists = () => false } = {}) {
  if (flag) return { command: flag, source: `--${name}`, explicit: true };
  const separator = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const directory of String(env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = `${directory.replace(/[\\/]+$/, '')}${platform === 'win32' ? '\\' : '/'}${name}${extension}`;
      if (exists(candidate)) return { command: name, source: `PATH (${candidate})`, onPath: true, path: candidate };
    }
  }
  for (const candidate of defaultToolLocations(name, env, platform)) if (exists(candidate)) return { command: candidate, source: `default install location (${name} is not on PATH)` };
  return { command: name, source: `not found on PATH or in its usual install location; trying "${name}"`, missing: true };
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
  const end = endFromStore(plan, start);
  return { startedAt: new Date(start).toISOString(), landedAtSeconds, jobKeys: (plan.jobs ?? []).map(job => job.key), ...(end ? { end } : {}) };
}

/**
 * When the plan ended, from Hydra's own timestamps rather than the poll that noticed it (pure): the integration gate
 * record's `at` (the last gate run, after every fix round) when the gate isn't still running, else the plan's
 * `updatedAt` once its state is no longer running. In seconds from `startedMs`, with `source` naming which one.
 * Undefined when the record has neither, so the caller keeps the poll time.
 */
export function endFromStore(plan, startedMs) {
  const start = startedMs ?? Date.parse(plan.startedAt ?? plan.createdAt);
  const gate = plan.integration?.gate;
  const candidates = [];
  if (gate?.at && !gate.running) candidates.push({ at: gate.at, source: 'integration gate record' });
  if (plan.updatedAt && plan.state && plan.state !== 'running') candidates.push({ at: plan.updatedAt, source: 'plan settle time' });
  for (const { at, source } of candidates) {
    const seconds = Math.round((Date.parse(at) - start) / 1000);
    if (Number.isFinite(seconds) && seconds >= 0) return { seconds, source };
  }
  return undefined;
}

/**
 * The end of a Hydra run (pure): Hydra's own time (`end`, from endFromStore) unless it is missing, comes before the last
 * landing, or is later than the poll that saw the plan settled (`pollSeconds`, give or take a little clock skew), in
 * which case it is the poll time, marked as such.
 */
export function endOfRun(end, pollSeconds, lastLandingSeconds) {
  const usable = end && Number.isFinite(end.seconds) && end.seconds >= (lastLandingSeconds ?? 0) && (pollSeconds === undefined || end.seconds <= pollSeconds + 5);
  return usable ? { seconds: end.seconds, from: end.source } : { seconds: pollSeconds, from: 'polling' };
}

/** The findings a fix brief lists under one gate, counted by severity (pure). */
const findingCounts = lines => ({ blocker: lines.filter(line => line.startsWith('- [blocker]')).length, major: lines.filter(line => line.startsWith('- [major]')).length, minor: lines.filter(line => line.startsWith('- [minor]')).length });

/**
 * Hydra's first-pass review, the one on the round-1 integration gate (pure). Hydra's final review comes after up to
 * `hydra.plans.integrationFixRounds` automatic fix rounds; the first-pass one is what compares with a single agent's
 * first review. The plan record overwrites its gate result each round, and so does the reviewer's reply file
 * (`plan-<id>-integration/rigor-review-reply.txt` is the last round's), so the robust source is the fix job the plan
 * added after round 1, `integration-fix-1`: its brief lists every gate that failed, with the review's findings
 * (integrationFixJob in src/core/integration.ts). So:
 * - no fix job: the first gate is the final one, and `finalReview` (the results' `review`) is the first-pass review;
 * - `integration-fix-1` with its brief (`fixBrief`, from Hydra's plan store): a review section in it is a first-pass
 *   review that failed, with its findings; without one, a command gate failed first and the review never ran;
 * - `integration-fix-1` without its brief: the gate failed, and nothing says how the review did (`ran` is undefined).
 * `passed` is left out when the review didn't run or isn't known.
 */
export function firstReviewOf({ jobKeys, fixBrief, finalReview }) {
  const fixes = (jobKeys ?? []).filter(isFixJob);
  if (!fixes.length) {
    if (!finalReview) return undefined;
    const passed = finalReview.state !== undefined ? reviewOutcome(finalReview.state) : finalReview.passed;
    return { source: 'the final gate (no fix round ran)', ran: passed !== undefined, ...(passed !== undefined ? { passed } : {}) };
  }
  if (typeof fixBrief !== 'string') return { source: 'integration-fix-1 exists but its brief is not in the plan store', gateFailed: true };
  const sections = [];
  for (const line of fixBrief.split(/\r?\n/)) {
    const heading = /^### ([\w-]+) \((\w+)\) failed(?:: (.*))?$/.exec(line);
    if (heading) sections.push({ id: heading[1], kind: heading[2], summary: heading[3], lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
  }
  const review = sections.find(section => section.kind === 'review');
  // The brief is cut at 4000 characters (with an ellipsis): a review section after a long command section may be the part that was cut.
  if (!review && fixBrief.endsWith('…')) return { source: 'the round 1 fix brief, cut at its length limit', gateFailed: true };
  if (!review) return { source: 'the round 1 fix brief', gateFailed: true, ran: false, notRunReason: 'a command gate failed first' };
  return { source: 'the round 1 fix brief', gateFailed: true, ran: true, passed: false, findings: findingCounts(review.lines), ...(review.summary ? { summary: review.summary.slice(0, 500) } : {}) };
}

/**
 * Hydra's run, summed up from the final plan view and what watching it saw (pure). `landing` (landingFromStore),
 * when Hydra's plan store could be read, gives exact landing times; otherwise they're as watching saw them.
 * `storedPlan`, the plan from Hydra's store, gives the first-pass review (firstReviewOf).
 */
export function summarizeHydra({ view, observed, wallClockSeconds, passed, timedOut, task, fixture, startedAt, landing, storedPlan }) {
  const jobs = (view.jobs ?? []).map(job => ({
    key: job.key, status: job.status,
    ...(job.head ? { provider: job.head.provider, attempts: job.head.attempts } : {}),
    ...(job.head?.usage ? { usage: job.head.usage } : {}),
    // Time its head waited on the provider (rate limits, retries), so a comparison can subtract or flag it.
    ...(job.head?.provider_wait_ms ? { providerWaitMs: job.head.provider_wait_ms } : {}),
  }));
  let usd = 0, usdJobs = 0, inputTokens = 0, outputTokens = 0, tokenJobs = 0, fixUsd = 0;
  for (const job of view.jobs ?? []) {
    const usage = job.head?.usage;
    if (usage?.cost_usd !== undefined) { usd += usage.cost_usd; usdJobs++; if (isFixJob(job.key)) fixUsd += usage.cost_usd; }
    if (usage?.input_tokens !== undefined || usage?.output_tokens !== undefined) { inputTokens += usage.input_tokens ?? 0; outputTokens += usage.output_tokens ?? 0; tokenJobs++; }
  }
  const integration = view.integration;
  const review = reviewCheckOf(integration?.gate?.checks);
  const landedAtSeconds = { ...(observed?.landedAt ?? {}), ...(landing?.landedAtSeconds ?? {}) };
  const finalReview = review ? { state: review.state } : undefined;
  // The run ends when Hydra says the plan settled, not when a poll noticed; a timed-out run ended at its poll.
  const landedTimes = Object.entries(landedAtSeconds).filter(([key]) => !isFixJob(key)).map(([, seconds]) => seconds);
  const ended = timedOut ? { seconds: wallClockSeconds, from: 'polling' } : endOfRun(landing?.end, wallClockSeconds, landedTimes.length ? Math.max(...landedTimes) : 0);
  const firstReview = firstReviewOf({ jobKeys: jobs.map(job => job.key), fixBrief: storedPlan?.jobs?.find(job => job.key === 'integration-fix-1')?.brief, finalReview });
  return {
    version: resultsVersion, kind: 'hydra', ...(fixture ? { fixture } : {}), ...(task ? { task } : {}), planId: view.plan_id, planState: view.state,
    // Small plans run as one head (docs/Heads.md): Hydra decides from the plan's shape; the harness only records it.
    mode: view.mode === 'single-head' ? 'single-head' : 'jobs', ...(view.mode === 'single-head' ? { modeReason: view.mode_reason, singleHeadJobs: view.single_head_jobs ?? [] } : {}),
    ...(startedAt ? { startedAt } : {}), wallClockSeconds: ended.seconds, wallClockFrom: ended.from, timedOut: !!timedOut,
    timeToWorkingCodeSeconds: workDoneSeconds(jobs.map(job => job.key), landedAtSeconds),
    landedAtSeconds, landingTimesFrom: landing ? 'plan store' : 'watching',
    integrationGate: integration ? { label: integration.gate?.label, passed: !!passed, checks: (integration.gate?.checks ?? []).map(check => ({ id: check.id, ...(check.kind ? { kind: check.kind } : {}), state: check.state })) } : null,
    review: review ? { id: review.id, state: review.state, ...(reviewOutcome(review.state) !== undefined ? { passed: reviewOutcome(review.state) } : { ran: false, ...(usageLimited(review.summary) ? { usageLimit: true } : {}) }), ...(review.summary ? { summary: String(review.summary).slice(0, 1000) } : {}) } : null,
    ...(firstReview ? { firstReview } : {}),
    fixRounds: jobs.filter(job => isFixJob(job.key)).length,
    landed: integration?.landed ?? [],
    jobs,
    conflicts: {
      predicted: Object.values(observed?.predicted ?? {}).reduce((sum, files) => sum + files.length, 0),
      predictedByJob: observed?.predicted ?? {},
      landingConflicts: Object.values(observed?.landingConflicts ?? {}).reduce((sum, count) => sum + count, 0) + Object.keys(observed?.held ?? {}).length,
    },
    amendments: (view.amendments ?? []).length,
    // The plan's own jobs and its fix jobs (agent work); the review is Codex's, which reports tokens, not dollars, and isn't counted on either side.
    cost: { usd: Math.round(usd * 1e4) / 1e4, usdJobs, inputTokens, outputTokens, tokenJobs, jobs: jobs.length, ...(fixUsd ? { fixUsd: Math.round(fixUsd * 1e4) / 1e4 } : {}) },
  };
}

/**
 * The single agent's run (pure). `agentOutput` is Claude Code's --output-format json result, when that's the agent:
 * its `subtype` and `is_error` are kept, since an agent can stop with an error and still exit 0.
 */
export function summarizeSingle({ agent, wallClockSeconds, exitCode, gatePassed, gateOutput, agentOutput, codexUsage, task, fixture, startedAt }) {
  const usd = typeof agentOutput?.total_cost_usd === 'number' ? agentOutput.total_cost_usd : undefined;
  const agentResult = agentOutput && (agentOutput.subtype !== undefined || agentOutput.is_error !== undefined) ? { ...(agentOutput.subtype !== undefined ? { subtype: String(agentOutput.subtype) } : {}), isError: agentOutput.is_error === true, ...(agentOutput.is_error === true && agentOutput.result ? { message: String(agentOutput.result).slice(0, 500) } : {}) } : undefined;
  return {
    version: resultsVersion, kind: 'single', ...(fixture ? { fixture } : {}), ...(task ? { task } : {}), agent, ...(startedAt ? { startedAt } : {}), wallClockSeconds, wallClockFrom: 'process exit', agentExitCode: exitCode,
    ...(agentResult ? { agentResult } : {}),
    gate: { passed: !!gatePassed, outputTail: String(gateOutput ?? '').slice(-2000) },
    cost: { ...(usd !== undefined ? { usd } : {}), ...(codexUsage ? { inputTokens: codexUsage.inputTokens, outputTokens: codexUsage.outputTokens } : {}) },
    ...(typeof agentOutput?.num_turns === 'number' ? { turns: agentOutput.num_turns } : {}),
    // Kept so `review` can resume the agent with the review's findings (--fix-rounds).
    ...(agentOutput?.session_id ? { sessionId: String(agentOutput.session_id) } : {}),
  };
}

/** The single agent's own settings when it's Claude Code (pure): every user plugin turned off, as a head's are (#260). */
export function singleSettings(pluginIds) {
  const ids = [...new Set(pluginIds ?? [])].filter(id => /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)).sort();
  return ids.length ? { enabledPlugins: Object.fromEntries(ids.map(id => [id, false])) } : {};
}
/** What the single Claude Code agent may run without asking: the project's tools and reading, not anything. It includes cd, grep and echo, because a compound command (`cd x && npm test 2>&1 | tail`) is allowed only when every part is, the same shapes a head runs. */
export const singleAllowedTools = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(cd:*)', 'Bash(grep:*)', 'Bash(echo:*)', 'Bash(sort:*)', 'Bash(diff:*)', 'Bash(pwd:*)']);
/**
 * The single Claude Code agent's command line (pure), isolated like a head: its settings file (no user plugins),
 * no MCP servers but the empty config's (--strict-mcp-config), and the allowed tools above. The brief goes to stdin.
 */
export function singleClaudeArgs({ settingsFile, mcpConfigFile, resume }) {
  return ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--settings', settingsFile, '--strict-mcp-config', '--mcp-config', mcpConfigFile, '--allowedTools', singleAllowedTools.join(','), ...(resume ? ['--resume', resume] : [])];
}

/**
 * What the single agent is told when its review failed (pure), formatted like Hydra's fix brief (integrationFixJob in
 * src/core/integration.ts): one section per required gate that failed, with the review's findings (up to 20) or a
 * command gate's last output, then what to do about them. tests/benchmarkFairness.test.ts keeps the sections the
 * same as Hydra's. `checks` are the gate checks the review ran (JobCheckResult).
 */
export function singleFixBrief(planTitle, checks) {
  const state = check => check.state ?? (check.passed ? 'passed' : 'failed');
  const failed = (checks ?? []).filter(check => check.required && state(check) === 'failed');
  if (!failed.length) return undefined;
  const oneLine = text => String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
  const sections = failed.map(check => {
    const kind = check.kind ?? 'command';
    const lines = [`### ${check.id} (${kind}) failed${check.summary ? `: ${oneLine(check.summary)}` : ''}`];
    for (const finding of (check.findings ?? []).slice(0, 20)) lines.push(`- [${finding.severity}]${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''}: ${oneLine(finding.note)}`);
    if (kind === 'command' && String(check.outputTail ?? '').trim()) lines.push('Last output:', '```', String(check.outputTail).trim().slice(-1500), '```');
    return lines.join('\n');
  });
  const brief = [
    `You finished the work on plan "${planTitle}", but the integration gate's review of the combined work failed.`,
    'Fix the blocker and major findings below, across whatever files that takes, without undoing what you built; minor ones are optional, so leave them unless a fix is quick and safe. Keep every existing test passing, and add tests for what you fix. Then finish as usual: the gate runs again on the result.',
    '',
    ...sections,
  ].join('\n');
  return brief.length > 4000 ? `${brief.slice(0, 3999)}…` : brief;
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

/** A review check's outcome (pure): true when it passed, false when it failed, undefined when it didn't run. */
export const reviewOutcome = state => state === 'passed' ? true : state === 'failed' ? false : undefined;
/** Whether a review that didn't run was stopped by a usage limit, from its reason (the review gate says "hit its usage limit"). */
export const usageLimited = text => /usage limit|rate limit|\b429\b/i.test(String(text ?? ''));

/**
 * The review of a single agent's result (benchmark.mjs review) from the checks run on it (pure): the project's
 * command gates, then one review by the other agent, as a plan's integration gate runs them. A review that didn't
 * run (no reviewer, a usage limit, a timeout, or a command gate failed first) is "not run", never a failure.
 */
export function summarizeReview({ checks, durationMs, startedAt, base, head, committedLeftovers, fixture, task }) {
  const review = checks.find(check => check.kind === 'review');
  const verdict = !review ? 'not run' : review.state === 'passed' ? 'pass' : review.state === 'failed' ? 'fail' : 'not run';
  const reason = verdict !== 'not run' ? undefined : review?.summary ?? 'The project has no review gate.';
  return {
    version: resultsVersion, kind: 'single-review', ...(fixture ? { fixture } : {}), ...(task ? { task } : {}), startedAt, durationSeconds: Math.round(durationMs / 1000),
    base, head, committedLeftovers: !!committedLeftovers,
    verdict, ran: verdict !== 'not run', ...(reason ? { notRunReason: String(reason).slice(0, 1000), usageLimit: usageLimited(reason) } : {}),
    gatesPassed: checks.every(check => !(check.required && check.state === 'failed')),
    ...(review?.reviewer ? { reviewer: review.reviewer } : {}),
    ...(review?.summary ? { summary: review.summary } : {}),
    findings: review?.findings ?? [],
    checks: checks.map(check => ({ id: check.id, kind: check.kind, state: check.state, required: check.required, durationSeconds: Math.round((check.durationMs ?? 0) / 1000), ...(check.summary ? { summary: String(check.summary).slice(0, 1000) } : {}) })),
  };
}
/** The single results with their review's verdict and timing added (pure). `passed` is left out when the review didn't run. */
export function withReview(single, review) {
  const count = severity => review.findings.filter(finding => finding.severity === severity).length;
  const passed = review.verdict === 'pass' ? true : review.verdict === 'fail' ? false : undefined;
  return {
    ...single,
    review: {
      verdict: review.verdict, ...(passed !== undefined ? { passed } : {}), ran: review.verdict !== 'not run', ...(review.usageLimit ? { usageLimit: true } : {}),
      gatesPassed: review.gatesPassed, durationSeconds: review.durationSeconds,
      ...(review.reviewer ? { reviewer: review.reviewer } : {}), findings: { blocker: count('blocker'), major: count('major'), minor: count('minor') },
    },
  };
}

/**
 * The single results with the whole review loop added (pure): the first review, then up to `allowed` rounds of
 * (the agent resumed with the findings, then a review again), as Hydra's integration gate does with its fix jobs.
 * `rounds` is one entry per review: `{ review: summarizeReview's result, fix?: { seconds, usd, exitCode } }` where
 * `fix` is the agent's fix run that followed that review. The last review is the final one; `skipped` says why a fix
 * couldn't run; `after` is `{ gatePassed, checkPassed }` on the fixed repository, when a fix ran.
 * Adds to `review`: `firstPass` (the first review), `fixRounds`, `fixRoundsAllowed`, `passedWithinRounds`, the time
 * of all reviews (`durationSeconds`) and of the fixes (`fixSeconds`), and adds the fixes' cost as `cost.fixUsd`.
 */
export function withReviewLoop(single, { rounds, allowed = defaultFixRounds, skipped, after }) {
  const first = rounds[0].review, last = rounds[rounds.length - 1].review;
  const fixes = rounds.map(round => round.fix).filter(Boolean);
  const outcome = review => review.verdict === 'pass' ? true : review.verdict === 'fail' ? false : undefined;
  const count = (review, severity) => review.findings.filter(finding => finding.severity === severity).length;
  const usds = fixes.map(fix => fix.usd).filter(value => typeof value === 'number');
  const fixUsd = usds.length ? Math.round(usds.reduce((sum, value) => sum + value, 0) * 1e4) / 1e4 : undefined;
  const { fixUsd: _stale, ...cost } = single.cost ?? {};
  const withFinal = withReview({ ...single, cost }, last);
  return {
    ...withFinal,
    ...(fixUsd !== undefined ? { cost: { ...withFinal.cost, fixUsd } } : {}),
    review: {
      ...withFinal.review,
      durationSeconds: rounds.reduce((sum, round) => sum + (round.review.durationSeconds ?? 0), 0),
      firstPass: { verdict: first.verdict, ran: first.verdict !== 'not run', ...(outcome(first) !== undefined ? { passed: outcome(first) } : {}), findings: { blocker: count(first, 'blocker'), major: count(first, 'major'), minor: count(first, 'minor') } },
      fixRounds: fixes.length, fixRoundsAllowed: allowed, passedWithinRounds: last.verdict === 'pass' && fixes.length <= allowed,
      ...(fixes.length ? { fixSeconds: fixes.reduce((sum, fix) => sum + (fix.seconds ?? 0), 0), fixes: fixes.map(fix => ({ seconds: fix.seconds, ...(typeof fix.usd === 'number' ? { usd: fix.usd } : {}), exitCode: fix.exitCode })) } : {}),
      ...(skipped ? { fixSkipped: skipped } : {}),
      ...(after ? { afterFix: after } : {}),
    },
  };
}

// ---- summarize: many runs, grouped by task and setup ----

export const setups = Object.freeze(['single', 'single+review', 'hydra']);

/**
 * One row per setup a results file stands for (pure): a single run is "single", and also "single+review" once
 * reviewed; a Hydra run is "hydra". `fallback` fills Hydra's time to working code for results from before it was
 * recorded (landingFromStore on the plan in Hydra's store).
 * Working code needs the gate to have passed, and when the fixture has a hidden check, the check too: every
 * fixture passes `npm test` untouched, so a run that stopped halfway would otherwise get a time. A single agent that
 * reported an error has none either. A review that didn't run has `reviewPassed` undefined and `reviewNotRun` set.
 */
export function runRows(result, folder, fallback) {
  const checkPassed = result.check ? !!result.check.passed : undefined;
  if (result.kind === 'single') {
    const working = !!result.gate?.passed && checkPassed !== false && !result.agentResult?.isError;
    const base = {
      folder, task: taskLabel(result), workSeconds: working ? result.wallClockSeconds : null, totalSeconds: result.wallClockSeconds,
      usd: result.cost?.usd, gatePassed: !!result.gate?.passed, checkPassed,
    };
    const rows = [{ ...base, setup: 'single' }];
    if (result.review) {
      const review = result.review;
      const ran = review.ran ?? review.verdict !== 'not run';
      const reviewPassed = ran && typeof review.passed === 'boolean' ? review.passed : undefined;
      // Results from before the fix loop have one review: it is the first pass and the final one, with no fix rounds.
      const first = review.firstPass ?? { ran, ...(reviewPassed !== undefined ? { passed: reviewPassed } : {}) };
      const fixRounds = review.fixRounds ?? 0;
      const total = result.wallClockSeconds + (review.durationSeconds ?? 0) + (review.fixSeconds ?? 0);
      // After the loop, working code is what the fixed repository's gate and hidden check say (when a fix ran), else the first run's.
      const workingAfter = review.afterFix ? !!review.afterFix.gatePassed && review.afterFix.checkPassed !== false && !result.agentResult?.isError : working;
      // Cost counts the agent's work and its fix rounds, as Hydra's does (its fix jobs are jobs); the review itself (Codex, tokens only) is on neither side.
      const usd = result.cost?.usd !== undefined || result.cost?.fixUsd !== undefined ? (result.cost?.usd ?? 0) + (result.cost?.fixUsd ?? 0) : undefined;
      rows.push({
        ...base, setup: 'single+review', totalSeconds: total, usd, workAfterSeconds: workingAfter ? total : null,
        gatePassed: review.afterFix ? !!review.afterFix.gatePassed : base.gatePassed, checkPassed: review.afterFix && review.afterFix.checkPassed !== undefined ? review.afterFix.checkPassed : checkPassed,
        reviewPassed, reviewNotRun: !ran, reviewSeconds: review.durationSeconds,
        firstReviewPassed: first.ran === false ? undefined : first.passed, firstReviewNotRun: first.ran === false,
        fixRounds, fixRoundsAllowed: review.fixRoundsAllowed ?? defaultFixRounds, passedWithin: reviewPassed === undefined ? undefined : reviewPassed && fixRounds <= (review.fixRoundsAllowed ?? defaultFixRounds),
      });
    }
    return rows;
  }
  if (result.kind === 'hydra') {
    let work = result.timeToWorkingCodeSeconds;
    if (work === undefined && fallback) work = workDoneSeconds(fallback.jobKeys?.length ? fallback.jobKeys : (result.jobs ?? []).map(job => job.key), fallback.landedAtSeconds);
    if (result.check && !(checkPassed && result.integrationGate?.passed)) work = null;
    // Results written before Hydra's own end time was kept ended at the poll that noticed: correct them from the plan store.
    let wall = result.wallClockSeconds;
    if ((!result.wallClockFrom || result.wallClockFrom === 'polling') && !result.timedOut && fallback?.end) {
      const landed = Object.entries(fallback.landedAtSeconds ?? {}).filter(([key]) => !isFixJob(key)).map(([, seconds]) => seconds);
      wall = endOfRun(fallback.end, result.wallClockSeconds, landed.length ? Math.max(...landed) : 0).seconds;
    }
    const review = result.review ?? (() => { const check = reviewCheckOf(result.integrationGate?.checks); return check ? { state: check.state } : undefined; })();
    const reviewPassed = !review ? undefined : review.state !== undefined ? reviewOutcome(review.state) : review.passed;
    const jobKeys = (result.jobs ?? []).map(job => job.key);
    const first = result.firstReview ?? firstReviewOf({ jobKeys, fixBrief: fallback?.fixBrief, finalReview: review });
    const fixRounds = result.fixRounds ?? jobKeys.filter(isFixJob).length;
    return [{
      folder, task: taskLabel(result), setup: 'hydra', workSeconds: work ?? null,
      // The plan ends when its integration gate has settled, after every fix round: that is the time after the review loop.
      workAfterSeconds: work === null || work === undefined ? null : wall, totalSeconds: wall,
      usd: result.cost?.usdJobs ? result.cost.usd : undefined, gatePassed: !!result.integrationGate?.passed,
      reviewPassed, reviewNotRun: !!review && reviewPassed === undefined, fixRounds,
      firstReviewPassed: first?.ran === false ? undefined : first?.passed, firstReviewNotRun: first?.ran === false,
      fixRoundsAllowed: defaultFixRounds, passedWithin: reviewPassed === undefined ? undefined : reviewPassed && fixRounds <= defaultFixRounds,
      checkPassed,
      ...(result.mode === 'single-head' ? { singleHead: true } : {}),
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
/** The review pass rate of a group (pure): passed of those that ran, then how many didn't run. */
export function reviewRate(rows, passedKey = 'reviewPassed', notRunKey = 'reviewNotRun') {
  const text = rate(rows.map(row => row[passedKey]));
  const notRun = rows.filter(row => row[notRunKey]).length;
  return notRun ? `${text}; ${notRun} not run` : text;
}
/** "k/n" of the booleans among `values` (pure); "–" when none apply. */
export function rate(values) {
  const known = values.filter(value => typeof value === 'boolean');
  return known.length ? `${known.filter(Boolean).length}/${known.length}` : '–';
}

const duration = seconds => minutes(seconds);
const dollars = value => `$${value.toFixed(2)}`;
const count = value => String(Math.round(value * 10) / 10);

const summaryNotes = [
  'Working code, before the review loop: for one agent, its run, when `npm test` and the hidden check passed after it and it reported no error; for Hydra, when the last of the plan\'s own jobs landed (the check runs on the integration branch\'s final tip), when the integration gate and the hidden check passed.',
  'After the review loop: when the review and its fix rounds are done and the work is still working: for `single+review`, the agent\'s run plus every review and fix round, when `npm test` and the check pass on the fixed repository; for Hydra, when the plan\'s integration gate settled after its fix rounds.',
  'First-pass review: the first review of the work, before any fix round (Hydra\'s is the round 1 integration gate\'s, read from the plan\'s `integration-fix-1` job). Final review: the last one, after up to the allowed fix rounds: Hydra\'s integration gate adds fix jobs by itself, and the single agent gets the same number (`review --fix-rounds`), resumed with the findings. Passed within N fix rounds: the final review passed after at most N rounds.',
  'A review that didn\'t run (no reviewer, a usage limit, a timeout, or a gate failed first) isn\'t in a pass rate; how many didn\'t run follows it.',
  'Cost counts the agent\'s work and its fix rounds on both sides (Hydra\'s fix jobs, the single agent\'s resumed runs); the review itself, by Codex, reports tokens and no dollars, and is counted on neither.',
  'Total time adds every review and fix round for `single+review`, and for Hydra runs until the integration gate settled. A median over an even count is the mean of the middle two.',
].join(' ');
/**
 * The summary of many runs (pure): a table per task and setup with the median and min–max of time to working code
 * (before the review loop and after it), total time and reported cost, then the gate, first-pass review, final review
 * and "passed within N fix rounds" pass rates, fix rounds and the hidden check; then every run, one line each, so
 * nothing is hidden behind a median.
 */
export function renderSummary(rows) {
  const order = setup => setups.indexOf(setup);
  const groups = new Map();
  for (const row of [...rows].sort((a, b) => a.task.localeCompare(b.task) || order(a.setup) - order(b.setup) || a.folder.localeCompare(b.folder))) {
    const key = `${row.task}\u0000${row.setup}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  // N in "passed within N fix rounds": what the runs were allowed (Hydra's hydra.plans.integrationFixRounds, review --fix-rounds).
  const allowed = Math.max(defaultFixRounds, ...rows.map(row => row.fixRoundsAllowed ?? 0));
  const lines = [
    `| Task | Setup | Runs | Working code, before the review loop | Working code, after the review loop | Total time | Cost (agent work, fix rounds included) | Gate passed | First-pass review | Final review | Passed within ${allowed} fix rounds | Fix rounds | Check passed |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const group of groups.values()) {
    const { task, setup } = group[0];
    // A single agent's run without a review has no review columns.
    const reviewed = setup !== 'single';
    lines.push(`| ${task} | ${setup} | ${group.length} | ${spread(group.map(row => row.workSeconds), duration)} | ${spread(group.map(row => row.workAfterSeconds), duration)} | ${spread(group.map(row => row.totalSeconds), duration)} | ${spread(group.map(row => row.usd), dollars)} | ${rate(group.map(row => row.gatePassed))} | ${reviewed ? reviewRate(group, 'firstReviewPassed', 'firstReviewNotRun') : '–'} | ${reviewed ? reviewRate(group) : '–'} | ${reviewed ? rate(group.map(row => row.passedWithin)) : '–'} | ${spread(group.map(row => row.fixRounds), count)} | ${rate(group.map(row => row.checkPassed))} |`);
  }
  lines.push('', summaryNotes, '');
  // Small plans run as one head: say which Hydra runs did, task by task, so "ran as one head in 5/5 runs" is read off here.
  for (const group of groups.values()) {
    if (group[0].setup !== 'hydra' || !group.some(row => row.singleHead)) continue;
    lines.push(`Hydra ran ${group[0].task} as one head in ${group.filter(row => row.singleHead).length}/${group.length} runs.`, '');
  }
  lines.push('| Run | Task | Setup | Working code (before review loop) | Working code (after review loop) | Total | Cost | Gate | First-pass review | Final review | Fix rounds | Check |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const yes = value => value === undefined ? '–' : value ? 'passed' : 'failed';
  const reviewed = row => row.reviewNotRun ? 'not run' : yes(row.reviewPassed);
  const firstReviewed = row => row.firstReviewNotRun ? 'not run' : yes(row.firstReviewPassed);
  const time = seconds => typeof seconds === 'number' ? duration(seconds) : '–';
  for (const group of groups.values()) for (const row of group) {
    lines.push(`| ${row.folder} | ${row.task} | ${row.setup} | ${time(row.workSeconds)} | ${time(row.workAfterSeconds)} | ${duration(row.totalSeconds ?? 0)} | ${row.usd !== undefined ? dollars(row.usd) : '–'} | ${yes(row.gatePassed)} | ${firstReviewed(row)} | ${reviewed(row)} | ${row.fixRounds ?? '–'} | ${yes(row.checkPassed)} |`);
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

/**
 * The register functions an export provides, in any shape (pure): a function, an array, an object of functions, or
 * nested arrays and objects of them. bench/fixtures/kanban-app/check.mjs uses it for src/routes/index.js, since
 * SPEC.md section 17 says only that the index "exports the register functions".
 */
export function registerFunctions(exported, depth = 0) {
  if (typeof exported === 'function') return [exported];
  if (!exported || typeof exported !== 'object' || depth > 4) return [];
  return Object.values(exported).flatMap(item => registerFunctions(item, depth + 1));
}

/** docs/Benchmark.md with its results section replaced (pure); throws when the markers are missing. */
export function withResults(doc, runs) {
  const start = doc.indexOf(resultsStart), end = doc.indexOf(resultsEnd);
  if (start < 0 || end < start) throw new Error('docs/Benchmark.md has no results markers.');
  return `${doc.slice(0, start + resultsStart.length)}\n${renderResults(runs)}\n${doc.slice(end)}`;
}

// O9 (docs/Benchmark.md): the benchmark's pure parts, so tests can check them without an agent. scripts/benchmark.mjs
// is the effectful shell that prepares the repositories, runs Hydra and the single agent, and writes the results.

/** The benchmark's tasks: plan files in bench/fixture/.hydra/plans. */
export const tasks = Object.freeze(['discounts', 'shop-features']);

/**
 * The single agent's brief (pure): the plan file's own brief and every job's, in order, so both sides of the
 * benchmark are given exactly the same work.
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
 * order, conflicts predicted while heads ran (with other heads, or with the integration branch), and the landing
 * conflicts that sent a job back (a new head for a job whose previous head had passed its gates, or a job held
 * with its conflict files).
 */
export function observePlan(previous, view) {
  const seen = previous ?? { heads: {}, predicted: {}, landingConflicts: {}, held: {} };
  const next = { heads: { ...seen.heads }, predicted: { ...seen.predicted }, landingConflicts: { ...seen.landingConflicts }, held: { ...seen.held } };
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
  return next;
}

/** Hydra's run, summed up from the final plan view and what watching it saw (pure). */
export function summarizeHydra({ view, observed, wallClockSeconds, passed, timedOut, task }) {
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
  return {
    version: resultsVersion, kind: 'hydra', ...(task ? { task } : {}), planId: view.plan_id, planState: view.state, wallClockSeconds, timedOut: !!timedOut,
    integrationGate: integration ? { label: integration.gate?.label, passed: !!passed, checks: (integration.gate?.checks ?? []).map(check => ({ id: check.id, state: check.state })) } : null,
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
export function summarizeSingle({ agent, wallClockSeconds, exitCode, gatePassed, gateOutput, agentOutput, codexUsage, task }) {
  const usd = typeof agentOutput?.total_cost_usd === 'number' ? agentOutput.total_cost_usd : undefined;
  return {
    version: resultsVersion, kind: 'single', ...(task ? { task } : {}), agent, wallClockSeconds, agentExitCode: exitCode,
    gate: { passed: !!gatePassed, outputTail: String(gateOutput ?? '').slice(-2000) },
    cost: { ...(usd !== undefined ? { usd } : {}), ...(codexUsage ? { inputTokens: codexUsage.inputTokens, outputTokens: codexUsage.outputTokens } : {}) },
    ...(typeof agentOutput?.num_turns === 'number' ? { turns: agentOutput.num_turns } : {}),
  };
}

const minutes = seconds => `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
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

# Quality benchmark: instructions for an agent

This file tells an agent (Claude Code or Codex) how to run Hydra's quality benchmark from start to finish without help. A person starts it with something like:

> Follow bench/QUALITY_RUN.md and finish the quality benchmark.

The full reference for every command is [docs/Benchmark.md](../docs/Benchmark.md). This file is the procedure; that file is the truth when they disagree.

## The goal

Find out whether a Hydra plan produces **better work** than one agent alone, not just faster work. For one fixture, run three paired runs (Hydra plan vs. one Claude Code agent), review both sides the same way, then write a summary that compares quality first and speed second.

Done means:
- three non-void paired runs of `kanban-app` exist under `.bench/q1/`, each with `hydra-results.json`, `single-results.json` and `single-review.json`;
- `.bench/q1/summary.md` and `.bench/q1/findings.md` exist;
- `.bench/q1/REPORT.md` exists, written by you (format at the end of this file);
- you have told the person the verdict in two or three sentences.

## Rules

1. **Never change what is being measured.** Don't edit anything under `bench/`, `scripts/benchmark*`, the fixture's `check.mjs`, `SPEC.md`, gates or plans, or the prepared repositories under `.bench/`. Don't help either side, fix their code, or retry a run because you dislike its result.
2. **Run one thing at a time.** Never run the Hydra side and the single side at the same time; they share usage limits and would slow each other down.
3. **Don't publish or commit.** Don't run `benchmark.mjs publish`, don't commit, don't push. The person decides what gets published.
4. **Report honestly.** If Hydra loses, say so plainly. A failed or void run is reported, never hidden.
5. **Stop and ask** only for the cases listed under "When to stop". Otherwise keep going until done.

## Before you start

Run these from the repository root in PowerShell. Stop and tell the person if any check fails.

1. **Windows.** This benchmark only runs on Windows.
2. **Latest main, clean tree.** `git status` shows no changes, and `git pull` has been run on `main`.
3. **Dependencies.** Run `npm.cmd ci` once.
4. **Hydra installed.** `%LOCALAPPDATA%\Programs\Hydra\bin\hydra.cmd` exists.
5. **Both CLIs signed in.** `claude --version` and `codex --version` print versions. The Hydra side uses both providers, and the review uses Codex. If either says it isn't signed in, stop: the person must sign in themselves. Never handle their credentials.
6. **Machine stays awake.** Ask the person once, at the start, to plug in and turn off sleep. A run the machine sleeps through is void (exit code 4) and must be redone.

## Running long commands

The `hydra` and `single` steps can each take up to two hours, longer than a normal tool timeout. Run every benchmark command **in the background**, send its output to a log file, and check on it every few minutes until the process exits. Then read its exit code and the last lines of its log.

Run every command in a **clean shell**, so the agent CLI the harness starts doesn't think it is nested inside your session:

```powershell
powershell -NoProfile -Command "Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE$|VSCODE_)' } | ForEach-Object { Remove-Item ('Env:' + $_.Name) }; <command> *> <log file>; exit $LASTEXITCODE"
```

## One paired run

Do this for `N` = 1, 2 and 3, in order. `R` is `.bench/q1/kanban-N`.

| Step | Command | Expect |
| --- | --- | --- |
| 1. Prepare | `node scripts/benchmark.mjs prepare --fixture kanban-app --out R` | Exit 0. `R/hydra` and `R/single` exist. |
| 2. Open Hydra | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-open.ps1 -Folder R/hydra -WaitSeconds 120` | Exit 0: a Hydra window owns the folder. |
| 3. Hydra side | `node scripts/benchmark.mjs hydra --repo R/hydra` | Up to about 2.5 hours. Writes `R/hydra/hydra-results.json`. |
| 4. Single side | `node scripts/benchmark.mjs single --repo R/single` | Up to about 2 hours. Writes `R/single/single-results.json`. |
| 5. Review | `node scripts/benchmark.mjs review --results R` | Codex reviews the single side, with up to two fix rounds. Writes `single-review.json`. |

Run each step only after the one before it has exited.

### What each exit code means

| Code | Meaning | What you do |
| --- | --- | --- |
| 0 | Done | Go to the next step. |
| 1 | The run failed, or a review didn't run | Read the log. If it's a setup problem (CLI not found, not signed in, Hydra window not open), fix only the setup, if you can, and redo that step. If the work itself failed, that is a result: record it and go on. |
| 2 | Wrong command usage | Re-read docs/Benchmark.md and correct the command. |
| 3 | A provider hit its usage limit | Stop. Tell the person which provider, and that the benchmark can resume once the limit resets. |
| 4 | Void: the machine slept | Redo the whole paired run: `node scripts/benchmark.mjs prepare --fixture kanban-app --out R --replace-void`, then steps 2 to 5 again. |

If the same run comes back void twice, stop and tell the person the machine keeps sleeping.

## After all three runs

```powershell
node scripts/benchmark.mjs summarize --runs ".bench/q1/kanban-*" --out .bench/q1/summary.md
node scripts/benchmark.mjs findings  --runs ".bench/q1/kanban-*" --out .bench/q1/findings.md
```

Then read `summary.md` and `findings.md` and write `.bench/q1/REPORT.md`.

## REPORT.md

Keep it under a page. Lead with the verdict. Use these sections:

1. **Verdict.** One or two sentences: on this fixture, did Hydra produce better, equal or worse work than one agent, and at what cost in time and money?
2. **Quality first.** A table of the median and range for both setups, from `summary.md`:
   - hidden check score;
   - first-pass review: passed or failed, and how many findings;
   - final review after fix rounds;
   - `npm test` at the end.
3. **Then speed and cost.** Median and range of total time and reported cost, both sides.
4. **Why reviews failed.** From `findings.md`, the three most common kinds of findings on each side. Sort each one into a bucket: seam between jobs, spec miss, bug in one job, test gap, or questionable finding.
5. **Problems during the run.** Void runs, failed steps, usage limits, anything odd, with the run it happened in.
6. **What to do next.** One or two concrete suggestions that follow from the numbers. If Hydra lost on quality, say that plainly.

## When to stop and ask the person

- A check under "Before you start" fails and you can't fix it without their sign-in or decision.
- Exit code 3: a usage limit.
- The same run is void twice.
- Something would require breaking a rule above.

Otherwise, keep going until every item under "The goal" is done.

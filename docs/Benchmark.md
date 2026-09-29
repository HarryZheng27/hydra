# Hydra's benchmark

A public, reproducible check of Hydra's orchestration claims. The same multi-part change is made twice, from the same starting commit:
- by a Hydra plan, run unattended;
- by one agent working alone.

Every run is published here, failures included.

## The tasks

A **fixture** is a starting repository; a **task** is one of its plan files (`.hydra/plans/<task>.json`), chosen with `--task`. `--fixture <name>` picks the fixture: `shop`, the default, is `bench/fixture`; any other name is `bench/fixtures/<name>`.

### `shop` (`bench/fixture`)

A small shop in plain Node with no dependencies: a catalog, orders, an HTTP API as one function, an HTML order page, tests, a README, and one gate (`npm test`, in `.hydra/gates.json`).

**`discounts` (the default):** discount codes across the shop, as six jobs in a diamond. Most jobs wait on another, so it mostly measures coordination, not parallel speed:

| Job | Changes | Depends on |
| --- | --- | --- |
| `discounts` | `src/discounts.js` and its tests | — |
| `api` | `src/orders.js`, `src/api.js` | `discounts` |
| `ui` | `src/ui.js` | `discounts` |
| `api-tests` | `test/orders.test.js`, `test/api.test.js` | `api` |
| `ui-tests` | `test/ui.test.js` | `ui`, `api` |
| `docs` | `README.md` | `api`, `ui` |

**`shop-features`:** seven independent features, each its own module with its own tests, then one job that wires them into the API and the README. The seven can all run at once, so this is where parallel work can pay off:

| Job | Changes | Depends on |
| --- | --- | --- |
| `search`, `inventory`, `tax`, `shipping`, `reviews`, `export`, `receipt` | `src/<feature>.js` and `test/<feature>.test.js` each | — |
| `wire` | `src/api.js`, `test/api.test.js`, `README.md` | all seven |

### The larger fixtures (`bench/fixtures`)

Three tasks of about an hour for one strong agent, each splitting into a wide stage of jobs that run at once and one or two jobs that bring them together. Each fixture is plain Node with no dependencies (`npm test` is `node --test`, so it works offline), and has:
- the starting code, with its tests passing;
- `README.md`, describing the task, and `SPEC.md`, which is exact about every function, output and error message, so both setups build the same thing;
- `.hydra/gates.json` (`npm test`) and one plan, named after the fixture, with no two jobs sharing a file;
- `prompt.md`, the single agent's brief, which is the plan's (`taskFromPlan`, below; a test keeps them the same);
- `check.mjs`, a hidden acceptance check (below).

| Fixture | The work | Jobs |
| --- | --- | --- |
| `kanban-app` | A kanban board with an HTTP API and a client: columns with WIP limits, cards with ordering and archiving, labels, due dates, search filters, CSV and JSON export, persistence to a JSON file, and the client's methods | 8 at once (each a domain module with its routes and tests, or persistence, or the client), then `server` (every route and a data file), then `e2e` (a whole board through the client, across a restart) |
| `cli-toolkit` | A command-line toolkit's subcommands: `csv-stats`, `json-query`, `wrap`, `date-diff`, `checksum`, `table`, `case` | 7 at once (one per subcommand), then `cli` (argument parsing, dispatch, help, exit codes) |
| `module-refactor` | Six billing modules that each carry private copies of money, date, CSV and validation helpers, which differ in small, tested ways: extract a shared core and move every module onto it, behaviour unchanged | 3 core jobs at once, then 6 module moves at once, then `finish` (a core index, a structure test and the README) |

Each plan leaves room for Hydra's two rounds of integration fixes within its 12-job limit and the default $80 budget (Hydra refuses to add a job when the job count times $5 would pass the budget).

**The hidden check.** `bench/fixtures/<name>/check.mjs` is never copied into the repositories the agents work in. After each setup, the harness runs `node check.mjs <result>`: for the single agent on its repository, and for Hydra on a clone of the plan's integration branch at its tip (`hydra-final`, beside the repository). It exercises what `SPEC.md` specifies (importing the modules, calling the API, running the command line) and ends with a JSON line of how many checks passed; the result goes into the results file as `check`. For `module-refactor` it also runs the modules' original tests, taken from the fixture, on the result's code, so an edited test can't pass for them.

**The single agent** gets the same work as one brief: the fixture's `prompt.md`, or for `shop` one generated from the plan file: the plan's brief, then every job's title, brief and files, in order (`taskFromPlan` in `scripts/benchmark-lib.mjs`). So both sides always get exactly the same work. The first published run predates this: its single agent got a hand-written brief of the same work.

## What is measured

- **Wall-clock time:** from starting the plan until its integration gate has a result, against the single agent's own run.
- **Time to working code:** for Hydra, when the last of the plan's own jobs landed on the integration branch (fix jobs don't count), from Hydra's plan store when it can be read (`landingTimesFrom: "plan store"`), else as watching the plan saw it; for the single agent, its run, when `npm test` passed after it and it reported no error (Claude Code's `is_error` and `subtype` are kept as `agentResult`). With a hidden check, working code also needs the check to pass, for both setups: every fixture passes `npm test` untouched, so a run that stopped halfway would otherwise get a time.
- **Gates at the end:**
  - for Hydra, the integration gate's result on every job's work merged together;
  - for the single agent, `npm test` on its result.
- **The review:** Hydra's integration gate includes one review of the whole change by the other agent. `benchmark.mjs review` runs the same review on the single agent's result, so both have a verdict (below). A review that didn't run (no reviewer, a usage limit, a timeout, or a gate failed before it) is "not run", never a failure: `summarize` leaves it out of the pass rate and counts it beside it.
- **Fix rounds:** the jobs a failed integration gate added to fix what it found (`integration-fix-<n>`).
- **The hidden check:** how many of the fixture's acceptance checks passed.
- **Conflicts:**
  - predicted: conflicts Hydra predicted while heads ran, with each other or with the plan's integration branch;
  - caught at landing: jobs sent back because their work couldn't merge onto the integration branch.
- **Amendments:** changes made to the plan while it ran.
- **Cost, as the providers reported it:**
  - Claude Code reports each run's cost in dollars. Hydra keeps it per head, and the single agent's comes from `claude -p --output-format json`.
  - Codex reports tokens, not dollars, so a Codex run shows tokens.
  - A job that reported nothing counts as nothing, and the table says how many jobs did report.

## How to run it

Running it spends real subscription usage, and the Hydra run is best recorded, so it is run by hand. You need Hydra (with the `hydra` command on `PATH`: the installer's **Add to PATH**), and Claude Code or Codex signed in.

1. `node scripts/benchmark.mjs prepare [--fixture <name>] [--out <dir>]`: makes two fresh repositories of the fixture under `.bench/run-<time>/` (`hydra` and `single`), each with one commit, leaving out `prompt.md` and `check.mjs`. It records the fixture and task in `benchmark.json` in the run folder, so the next commands needn't be told again.
2. Open the `hydra` folder in Hydra, trust it, and start recording. From a shell that runs inside a Hydra window, open it with `scripts/bench-open.ps1` (below).
3. `node scripts/benchmark.mjs hydra --repo .bench/run-<time>/hydra`:
   - runs `hydra plan run <task> --unattended` (`--task discounts` by default for `shop`, or the fixture's only plan; with a 120-minute and $80 budget by default: `--minutes`, `--usd`);
   - watches the plan until its integration gate has a result;
   - reads when each job landed from Hydra's plan store (`%APPDATA%\Hydra\User\globalStorage\…\plans\plans.json`, or `--plan-store <file>`);
   - runs the fixture's hidden check on the integration branch's tip;
   - writes `hydra-results.json` and the plan's report.
4. `node scripts/benchmark.mjs single --repo .bench/run-<time>/single`: runs one agent (`--agent claude` by default, or `codex`) on the same task's brief, then `npm test` and the hidden check, and writes `single-results.json`. The agent, `npm test` and the check each have a time limit (`--minutes`, 10 minutes, 5 minutes); past it the whole process tree is killed, and something a finished command left running can't hold the run open.
5. `node scripts/benchmark.mjs review --results .bench/run-<time>`: the single agent's review (below).
6. `node scripts/benchmark.mjs publish --results .bench/run-<time> --label "<what changed>"`: adds the run to `bench/results.json` and to the results below. Review the diff and commit it, with a link to the recording in `--notes` if there is one.

### The single agent

The single Claude Code agent runs as isolated as a head, so the two setups work under the same conditions:

```
claude -p --output-format json --permission-mode acceptEdits --settings <run>/single-settings.json --strict-mcp-config --mcp-config <run>/single-mcp.json --allowedTools Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(node:*),Bash(git:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(mkdir:*)
```

- `single-settings.json` turns off every one of your Claude Code plugins, the same list a head turns off (`userClaudePlugins`, from Hydra's own code); `single-mcp.json` has no MCP servers, and `--strict-mcp-config` keeps out your own.
- The brief goes to stdin. The two files are written beside the repository, so the agent never commits them; `single-results.json` records the isolation.
- Unlike a head, the single agent runs **unsandboxed** in the run folder: its allowed commands run as you. Run it only on benchmark folders.
- `--claude <path>` points at Claude Code when it isn't `claude` on `PATH` (for example `%USERPROFILE%\.local\bin\claude.exe`); the isolation still applies.
- `--command "<command line>"` replaces all of this (a CLI installed elsewhere, other flags); the brief still goes to stdin. A Codex agent (`--agent codex`) runs as `codex exec --json -s workspace-write`.

### Opening a benchmark folder: `scripts/bench-open.ps1`

A window opened from a shell inside a Hydra window inherits that shell's `ELECTRON_RUN_AS_NODE`, its `VSCODE_*` variables and its `PATH`: it can attach to the wrong instance, or not find `claude.exe`, so every head fails with "Claude Code CLI not found". This script opens a folder in the installed Hydra (`%LOCALAPPDATA%\Programs\Hydra\bin\hydra.cmd`) from a clean environment: `PATH` rebuilt from the Machine and User values in the registry, `ELECTRON_RUN_AS_NODE` and every `VSCODE_*` variable removed, and no console window.

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-open.ps1 -Folder .bench/run-<time>/hydra -WaitSeconds 120
```

With `-WaitSeconds`, it then runs `hydra status` in the folder (from the same clean environment) until a Hydra window owns it, and fails if none does in time. A `hydra status` that hangs is killed after 30 seconds, and the next try starts. `-Hydra <path>` points at another `hydra.cmd`.

### The single agent's review: `benchmark.mjs review`

`node scripts/benchmark.mjs review --results .bench/run-<time>` runs the gates a plan's integration gate runs, on the single agent's result: the project's command gates, then one review of the whole change by the other agent (Codex reviews Claude Code's work), with the same title and brief a plan's integration review gives the reviewer. It is Hydra's own code (`integrationGates`, `runGateList`, the review gate), bundled from `src/` with esbuild when it runs (`scripts/benchmark-review.ts`, built into `.bench/.build`), and it finds the reviewer's CLI as Hydra does: on `PATH`, or `--codex <path>` (`--claude <path>` for Claude Code).

- The review sees `base..HEAD`, where the base is the repository's first commit (`--base` to change it). Work the agent left uncommitted is committed first, and `committedLeftovers` says so.
- It writes `single-review.json` (the verdict, every check with its duration, the findings, and where the reviewer's prompt and reply are kept) and adds `review` to `single-results.json`: the verdict, whether it passed, its duration and the findings by severity.
- The gates are read from the fixture, as Hydra reads a plan's gates from the lead folder, never from the repository under review, whose agent could have changed them.
- Like any review gate, it runs for at most 5 minutes. A review that doesn't run is recorded with `verdict: "not run"`, `ran: false` and the reason, and the command then exits 1, or 3 when a usage limit stopped it (`usageLimit: true`), so a night of runs notices and stops.

### Repeat runs and summaries: `benchmark.mjs summarize`

Runs are kept one folder each (`prepare --out <folder>`). `node scripts/benchmark.mjs summarize --runs "<glob or folders, comma-separated>"` reads every `*-results.json` in them and groups the runs by task and setup:
- `single`: one agent alone;
- `single+review`: the same runs once reviewed, their total time including the review;
- `hydra`: Hydra's plan.

For each group it gives the median and the range (min–max) of time to working code, total time and reported cost, the gate, review and hidden-check pass rates, and fix rounds; then one line per run, so nothing hides behind a median. It prints the table and writes it to `summary.md` beside the run folders (`--out` to change that). For Hydra results written before landing times were recorded, it takes them from Hydra's plan store (`--plan-store`).

```
node scripts/benchmark.mjs summarize --runs ".bench/overnight/bench-p1-*"
```

### SWE-bench Verified (`benchmark.mjs swebench`; not run end to end yet)

`scripts/benchmark-swebench.mjs` runs a seeded slice of SWE-bench Verified with one setup, end to end and resumable, and grades it in the cloud with `sb-cli`, so nothing is graded locally and no Docker is needed. Hydra's parallelism helps little on one issue; this measures whether its brief, gates and final review keep or improve quality.

**Prerequisites**
- Node and git (as for the rest of the benchmark), and network access to the instances' source repositories and the dataset host.
- For running: Claude Code signed in (`single`); for `hydra`, the installed Hydra (`%LOCALAPPDATA%\Programs\Hydra\bin\hydra.cmd`) and Windows, since each instance's folder is opened with `scripts/bench-open.ps1`. `--out` must be inside a folder Hydra trusts (including subfolders), or every window stops at the trust prompt.
- For grading: Python 3 with `pip install sb-cli`, `sb-cli` on `PATH`, and an API key in `SWEBENCH_API_KEY` (`sb-cli gen-api-key <email>`, then `sb-cli verify-api-key <code>` from the email).
- Python's `datasets` is **not** needed: the instance list comes from the datasets server's JSON API by default (below).

**Run a slice** (one folder per setup; the same `--seed` and `--n` give the same instances):

```
node scripts/benchmark.mjs swebench --n 30 --seed 1 --setup single --out .bench/<trusted>/swebench-s1-single
node scripts/benchmark.mjs swebench --n 30 --seed 1 --setup hydra  --out .bench/<trusted>/swebench-s1-hydra
```

For each instance it:
1. **Selects** (once per folder): fetches the 500 instances, draws `--n` with `--seed` (mulberry32 over the sorted ids, so the dataset's order doesn't matter), and caches them with only `instance_id`, `repo`, `base_commit`, `problem_statement` and `version` in `<out>/instances.json`; the gold patch, test patch and hints never reach the folder. A resumed run reads the cache and needs no network.
2. **Clones** `<out>/<instance_id>/repo` at `base_commit` from one bare mirror per repository (`.bench/swebench-mirrors/<owner>__<name>.git`, or `--mirrors <dir>`; cloned once, fetched only when a commit is missing). The repository is a new one that fetches a single temporary ref at the base commit from the mirror, so it holds only the base commit and its history: no remote, no tags, no alternates, and none of the later commits (the fix among them), not even by hash. Writing that pack costs a little CPU per instance; a clone, shared or not, would bring the whole history.
3. **Runs the setup** with the issue as the brief (`prompt.md` beside the repository):
   - `single`: `benchmark.mjs single --prompt <instance>/prompt.md --gate none`, the isolated `claude -p` described above (`--agent`, `--claude`, `--command` and `--gate` pass through);
   - `hydra`: writes the one-job plan (`.hydra/plans/swebench.json`, write scope `['.']`, standard rigor), opens the folder with `scripts/bench-open.ps1 -WaitSeconds 180` (`--open none` if you open it yourself), then `benchmark.mjs hydra --fixture none --task swebench` (`--usd`, 10 by default, `--hydra`, `--plan-store`, `--poll` pass through). **Each instance opens its own window, and the runner can't close it**: the `hydra` command has no command that closes a window, and killing the process would take every Hydra window with it. So run the hydra setup in batches (below).
   - `--minutes` is the time limit per instance (60 by default).
4. **Captures the patch**: `git diff <base_commit>` to the working tree, new files included (`single`), or to the plan's integration tip (`hydra`), leaving out `.hydra`, into `<instance>/model.patch`.
5. **Records** `<instance>/instance.json`: `status` (`done` or `error`), the error, seconds in all and for the agent, the reported cost in USD, and the patch size; the setup's own `single-results.json` or `hydra-results.json` sits beside it. Then it rewrites `<out>/predictions.jsonl`, one line per instance run (`instance_id`, `model_name_or_path`, `model_patch`; `--model` names it, `hydra-benchmark-<setup>` by default). A failed instance is still a prediction, with whatever patch it left (maybe empty), so it counts as unresolved.

**Resuming**: run the same command again. Instances with a record are skipped; `--retry-errors yes` runs the failed ones again, and an instance that was interrupted (no record) starts again from a fresh folder. `--only <id,id>` runs just those, and `--limit <k>` at most k of the ones left. A folder refuses a different `--seed`, `--n` or `--setup`.

**Usage limits**: the run stops and exits 3 when a limit stopped an instance: the error says so, Claude Code's own result is an error that says so, Hydra's final review didn't run for one, or Hydra's plan didn't finish and its report names one. That instance gets no record and no prediction (only `usage-limit.txt` in its folder), so the same command, run again once the limit resets, starts it over. A plan that finished after waiting out a rate limit isn't stopped.

**Batches and cleanup for the hydra setup**:
1. `node scripts/benchmark.mjs swebench --n 30 --seed 1 --setup hydra --out <dir> --limit 5`: five instances, five windows.
2. Close the windows that batch opened (their folders are `<dir>/<instance_id>/repo`). Leave your own windows open.
3. Run the same command again for the next five, until its last line shows 0 not run.

With `--open none` the runner opens no window: open each instance's `repo` yourself with `bench-open.ps1`, run it with `--only <id>`, and close it before the next. When the slice is graded, the instance folders and `.bench/swebench-mirrors` can be deleted; keep `instances.json`, `predictions.jsonl`, `resolved.json` and the `sb-cli-reports` folder.

`node scripts/benchmark.mjs swebench predictions --out <dir>` rewrites the predictions file from the records.

**Grade**:

```
node scripts/benchmark.mjs swebench-submit --out .bench/<trusted>/swebench-s1-single [--run-id <id>] [--wait 120]
```

It first checks that `predictions.jsonl` has lines, `SWEBENCH_API_KEY` is set and `sb-cli` runs, and fails naming everything missing. Then it runs `sb-cli submit swe-bench_verified test --predictions_path <out>/predictions.jsonl --run_id <id> --output_dir <out>/sb-cli-reports`, which waits for the grading and writes `swe-bench_verified__test__<id>.json`. While that report still has pending instances, it runs `sb-cli get-report swe-bench_verified test <id> --output_dir <out>/sb-cli-reports --overwrite 1` once a minute, for up to `--wait` minutes. It writes `<out>/resolved.json`: resolved, selected, the rate over the selected instances, sb-cli's counts, and the resolved ids when the report lists them. Running it again after a submit only fetches the report. `summarize --runs <folders>` adds a SWE-bench table with the resolved rate per folder and per setup.

**Verified, and assumed**
- Verified against sb-cli's README and source (September 2026): `pip install sb-cli`; `SWEBENCH_API_KEY`; the subset `swe-bench_verified` and split `test`; `submit`'s `--predictions_path`, `--run_id` and `--output_dir`, and that it waits for grading and writes a report by default (`--wait_for_evaluation 1`, `--gen_report 1`); predictions may be JSONL (any file not ending `.json`) with those three keys, and a subset of instances is accepted; `get-report <subset> <split> <run_id> --output_dir --overwrite`; the report's file name; and the count keys it prints (`resolved_instances`, `submitted_instances`, `total_instances`, `pending_instances`, `completed_instances`, `error_instances`, `failed_instances`). `total_instances` is the whole split, so the rate here is over the sample, not sb-cli's "resolved (total)".
- Assumed, not verified: that the report JSON also lists per-instance ids (`resolved_ids`, `unresolved_ids`, `error_ids`, as the local harness's report does). Without them, `resolved.json` has the counts only; `sb-cli get-report` output is kept in `sb-cli-reports`.
- The dataset: `princeton-nlp/SWE-bench_Verified` through the dataset host's rows API (`datasetRowsUrl` in the script: `config=default`, `split=test`, `offset`, `length=100`) was checked to answer 500 rows, 100 a page. The rows API has no Python dependency but depends on the service being up; each page is retried 4 times. `--source python` lists the dataset with Python's `datasets` instead (`pip install datasets`; `--python <path>`), as a fallback.
- Not run end to end against a real instance, a real Hydra window or sb-cli yet: the tests drive the whole loop with local git repositories and fakes for the dataset, the agent, Hydra and sb-cli.

## What it doesn't show

- **One task, one run:** a single run of one task is an anecdote, not a distribution. Runs are kept, not replaced, so a pattern (or its absence) can show over time; `summarize` shows the spread of repeat runs.
- **Wall-clock depends on the moment:** it depends on the providers' load then, and on how many heads Hydra may run at once (`hydra.maxConcurrentHelpers`, 3 by default, up to 8). With 3, `shop-features`' seven independent jobs run three at a time; say which you used in the run's `--notes`.
- **Cost is what the providers report:** there's no independent meter.
- **The hidden check is only as good as its cases:** it checks what `SPEC.md` specifies, the same for both setups, and not everything a reviewer might.

## Results

<!-- benchmark-results:start -->
### 2026-09-28: second run, a wider task

Task: `shop-features` (8 jobs).

| | Hydra (plan, unattended) | One agent alone |
| --- | --- | --- |
| Wall-clock | 20m 55s | 9m 46s (claude) |
| Gates at the end | Passed required gates | `npm test` passed |
| Conflicts predicted / caught at landing | 0 / 0 | n/a |
| Amendments | 0 | n/a |
| Cost (as the providers reported it) | $5.23 | $2.43 |
| Plan | done; 8 of 8 jobs done | |

On the wider task, one Claude Code agent was still faster (9m 46s against 20m 55s) and cheaper ($2.43 against $5.23). Hydra's run landed all eight jobs with no conflicts predicted or caught and no amendments. Three jobs needed a second or third attempt after their gates sent work back. The combined work passed its integration gate with 95 tests; the single agent's has 72. Hydra ran with up to 8 heads at once (hydra.maxConcurrentHelpers 8). Each job pays for its own worktree, gates (including a review gate) and landing, so parallelism doesn't yet beat one agent on a task that one agent finishes in under ten minutes. Not recorded on video.

### 2026-09-28: first run

Task: `discounts` (6 jobs).

| | Hydra (plan, unattended) | One agent alone |
| --- | --- | --- |
| Wall-clock | 8m 13s | 1m 36s (claude) |
| Gates at the end | Passed required gates | `npm test` passed |
| Conflicts predicted / caught at landing | 0 / 0 | n/a |
| Amendments | 0 | n/a |
| Cost (as the providers reported it) | $1.30 | $0.57 |
| Plan | done; 6 of 6 jobs done | |

On a task this small, one Claude Code agent was faster (1m 36s against 8m 13s) and cheaper ($0.57 against $1.30): six jobs each pay for their own worktree, gate run and landing, and the integration gate runs on top. Hydra's run had every job land first time (no conflicts predicted or caught, no amendments), and the combined work passed `npm test` (26 tests; the single agent's has 23). Parallelism can't pay off when the whole task takes one agent under two minutes; a larger task is the next thing to measure. Not recorded on video.
<!-- benchmark-results:end -->

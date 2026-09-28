# Hydra's benchmark

A public, reproducible check of Hydra's orchestration claims. The same multi-part change is made twice, from the same starting commit:
- by a Hydra plan, run unattended;
- by one agent working alone.

Every run is published here, failures included.

## The tasks

The fixture (`bench/fixture`) is a small shop in plain Node with no dependencies: a catalog, orders, an HTTP API as one function, an HTML order page, tests, a README, and one gate (`npm test`, in `.hydra/gates.json`). Each task is a plan file in `bench/fixture/.hydra/plans`, chosen with `--task`.

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

**The single agent** gets the same work as one brief, generated from the plan file: the plan's brief, then every job's title, brief and files, in order (`taskFromPlan` in `scripts/benchmark-lib.mjs`). So both sides always get exactly the same work. The first published run predates this: its single agent got a hand-written brief of the same work.

## What is measured

- **Wall-clock time:** from starting the plan until its integration gate has a result, against the single agent's own run.
- **Gates at the end:**
  - for Hydra, the integration gate's result on every job's work merged together;
  - for the single agent, `npm test` on its result.
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

1. `node scripts/benchmark.mjs prepare`: makes two fresh repositories of the fixture under `.bench/run-<time>/` (`hydra` and `single`), each with one commit.
2. Open the `hydra` folder in Hydra, trust it, and start recording.
3. `node scripts/benchmark.mjs hydra --repo .bench/run-<time>/hydra`:
   - runs `hydra plan run <task> --unattended` (`--task discounts` by default, or `shop-features`; with a 120-minute and $60 budget by default: `--minutes`, `--usd`);
   - watches the plan until its integration gate has a result;
   - writes `hydra-results.json` and the plan's report.
4. `node scripts/benchmark.mjs single --repo .bench/run-<time>/single`: runs one agent (`--agent claude` by default, or `codex`) on the same `--task`'s brief, then `npm test`, and writes `single-results.json`.
5. `node scripts/benchmark.mjs publish --results .bench/run-<time> --label "<what changed>"`: adds the run to `bench/results.json` and to the results below. Review the diff and commit it, with a link to the recording in `--notes` if there is one.

## What it doesn't show

- **One task, one run:** a single run of one task is an anecdote, not a distribution. Runs are kept, not replaced, so a pattern (or its absence) can show over time.
- **Wall-clock depends on the moment:** it depends on the providers' load then, and on how many heads Hydra may run at once (`hydra.maxConcurrentHelpers`, 3 by default, up to 8). With 3, `shop-features`' seven independent jobs run three at a time; say which you used in the run's `--notes`.
- **Cost is what the providers report:** there's no independent meter.

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

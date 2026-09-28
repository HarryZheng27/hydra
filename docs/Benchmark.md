# Hydra's benchmark

A public, reproducible check of Hydra's orchestration claims. The same multi-part change is made twice, from the same starting commit:
- by a Hydra plan of six jobs, run unattended;
- by one agent working alone.

Every run is published here, failures included.

## The task

The fixture (`bench/fixture`) is a small shop in plain Node with no dependencies: a catalog, orders, an HTTP API as one function, an HTML order page, tests, a README, and one gate (`npm test`, in `.hydra/gates.json`). The task adds discount codes across all of it.

The Hydra run uses the plan file `bench/fixture/.hydra/plans/discounts.json`, which has six jobs in a diamond:

| Job | Changes | Depends on |
| --- | --- | --- |
| `discounts` | `src/discounts.js` and its tests | — |
| `api` | `src/orders.js`, `src/api.js` | `discounts` |
| `ui` | `src/ui.js` | `discounts` |
| `api-tests` | `test/orders.test.js`, `test/api.test.js` | `api` |
| `ui-tests` | `test/ui.test.js` | `ui`, `api` |
| `docs` | `README.md` | `api`, `ui` |

The single agent gets the same work as one brief, `bench/task.md`.

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
   - runs `hydra plan run discounts --unattended` (by default with a 120-minute and $60 budget: `--minutes`, `--usd`);
   - watches the plan until its integration gate has a result;
   - writes `hydra-results.json` and the plan's report.
4. `node scripts/benchmark.mjs single --repo .bench/run-<time>/single`: runs one agent (`--agent claude` by default, or `codex`) on `bench/task.md`, then `npm test`, and writes `single-results.json`.
5. `node scripts/benchmark.mjs publish --results .bench/run-<time> --label "<what changed>"`: adds the run to `bench/results.json` and to the results below. Review the diff and commit it, with a link to the recording in `--notes` if there is one.

## What it doesn't show

- **One task, one run:** a single run of one task is an anecdote, not a distribution. Runs are kept, not replaced, so a pattern (or its absence) can show over time.
- **Wall-clock depends on the moment:** it depends on the providers' load then, and on how many heads Hydra may run at once (`hydra.maxConcurrentHelpers`, 3 by default).
- **Cost is what the providers report:** there's no independent meter.

## Results

<!-- benchmark-results:start -->
No run has been published yet.
<!-- benchmark-results:end -->

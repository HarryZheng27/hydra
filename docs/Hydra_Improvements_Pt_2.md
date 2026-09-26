# Hydra improvements, part 2: product and release parity

Status (2026-09-26): Step A built (see "As built"); Steps B–E to follow, in order. `Hydra_Improvements.md` stays the record for security hardening and release trust; this file starts where that one ends.

## Why this exists

A competing multi-agent workbench presents itself as complete and downloadable. Its public README (checked 2026-09-26) describes:
- a coordinator that turns a brief into a job graph and hands ready jobs to idle lanes;
- a view across every open project;
- an editor and a browser for each lane;
- automatic gate feedback, with up to three attempts before a job blocks;
- macOS, Windows and Linux packages.

Those are its own claims, not tested by us, and its FAQ adds three limits:
- its Windows and Linux test gate has no OS sandbox;
- Windows paths aren't tested yet;
- its builds aren't code-signed.

So the comparison should be about workflows people can see working, and about delivery, not a blanket claim that one is better built or safer.

Hydra already overlaps a lot:
- heads in worktrees, and plans that respect dependencies;
- unattended heads, and a live Agents canvas;
- lane terminals, three gate types, and gate feedback for heads;
- packs, provider handoff, and a native Windows IDE.

`Hydra_Improvements.md` made its security and release metadata stronger. The differences below are about what users see and how Hydra is delivered.

**Sources:** [Hydra heads and lanes](Heads.md), [Hydra's release procedure](Releases.md), [Hydra's implementation status](Implementation_Status.md), [Hydra improvements](Hydra_Improvements.md), and the other product's public README and architecture guide.

## What is already covered

| The other product claims | Hydra today | Conclusion |
| --- | --- | --- |
| Parallel agents in separate worktrees | Heads and lanes use separate worktrees and branches. | Already strong. Prove it in the installed app rather than rebuild it. |
| A dependency graph and a visual planner | Plans have jobs, dependencies and cycle refusal, and Run plan is safe to repeat. Heads start when their dependencies do. | Broadly equal for planned head work. |
| Independent gates and three attempts | Heads run command, screenshot and review gates. A failure goes back to the head, up to the configured attempts. | Broadly equal for heads. Lane merges and manual lane jobs finish differently. |
| Packs | Project packs add roles, gates, MCP servers and skills, and are opt-in. | Already strong. |
| Usage-limit handoff | Heads and lanes continue between Claude and Codex in the same worktree. A chat's handoff is copied for you. | Already strong, though with fewer providers. |
| Release integrity | Releases carry `SHA256SUMS` and a provenance attestation, and the update-signing tooling exists. | Tooling built. Production signing, hosting, installing and a signed upgrade are still open. |

## Decisions (Nico, 2026-09-26)

1. **The Windows journey runs on Claude only.** Every step uses Claude heads and lanes. Codex runs at most one short review gate, because its weekly budget is low. The signing and update steps stay with the release owner.
2. **Dispatching to lanes is an opt-in mode for each plan.** It uses the existing job graph and worktrees, and manual lanes stay as they are.
3. **Hydra stays Windows-only for now.** There's no demand data yet. This is revisited when users ask for another platform, or someone who maintains that platform joins.
4. **A lane's preview uses VS Code's built-in Simple Browser.** No new browser engine.

## Order

The steps run in the order the comparison recommends. The journey (item 1) comes before the new orchestration (item 3) and the cross-project view (item 4). Item 2 comes first, because the journey should show honest evidence.

| Step | Item | What |
| --- | --- | --- |
| A | 2 | Truthful gate status for every job |
| B | 1 | The Windows journey, run and recorded |
| C | 3 | Opt-in dispatch of plan jobs to lanes |
| D | 4 | A read-only view across projects |
| E | 5 | A preview for each lane |
| — | 6 | The platform decision (made above) |

## Step A: truthful gate status for every job (item 2)

Today there are four ways a job can finish without every check proving it:
- A project with no gates accepts a head after only the scope check.
- A reviewer or browser that can't run marks its gate **not run**, which never fails the head.
- A lane Merge can offer **Merge anyway**.
- A manual lane job waits for you to mark it done.

These are fair policies, but a plain "done" can be read as "independently proven".

**Build:**
- **An evidence status** is worked out from a job's checks and how it was accepted: `evidenceStatus(checks, how)` in `src/core/jobs.ts`. It is one of:

  | Status | Shown as | When |
  | --- | --- | --- |
  | `passed` | Passed required gates | every required gate passed, and no gate was skipped |
  | `partial` | Some gates not run | required gates passed, but at least one gate didn't run |
  | `none` | No gates configured | the project has no gates |
  | `none-chosen` | No gates (project choice) | the project's `gates.json` deliberately lists none |
  | `override` | Human override | Merge anyway or Mark done anyway after a failure |

  It is stored with the **commit** it describes:
  - on a head's result;
  - on a lane's last gate record, and on its merge;
  - on a plan job's result.
- **One label everywhere** the result appears: the canvas node, the lane tile, the plan view's job, the Agents tree and View evidence.
- **Old results aren't relabelled.** A job finished before this change shows no status.
- **A lane whose HEAD moves** past the recorded commit shows "Checks are for an older commit".
- **PR handoff:** Open PR adds a short "Checks" section to the pull request body through GitHub's compare `body` parameter. It gives the status, each gate's result and the commit.
- **A deliberate starter choice:** when a project has no `gates.json`, the first head acceptance or lane merge offers once:
  - "Add a test gate": detected from the `test` script in `package.json`, and written to `.hydra/gates.json`;
  - "No gates for this project": written as `{"gates": []}`;
  - "Not now".

  Settings → Gates gets the same "Starter gates" action.

**Where:**
- `src/core/jobs.ts`, `helperService.ts` (acceptance), `lanes.ts`, `laneService.ts`;
- `extensionLanes.ts` (`gatesBefore`, `markJobDone`, `pushLane`'s compare URL);
- `planRunner.ts` (plan job views);
- `webview/AgentsCanvas.tsx`, `webview/LanesView.tsx`;
- `src/core/hydraTree.ts`, `src/core/evidence.ts`, `src/settings/pages/gates.ts`.

**Tests:**
- Each status comes from the right checks.
- A skipped required gate is never `passed`.
- A new commit makes a lane's status stale.
- The compare URL's body carries the checks.
- The starter prompt writes the right `gates.json` and doesn't ask again.

**Live checks:** in a probe, look at the same commit's status on the canvas, the lane tile, the plan and the PR body:
1. A lane merged with a passing gate.
2. The same lane after a new commit.
3. A Merge anyway.
4. A project with no gates.

## Step B: the Windows journey (item 1)

The release owner's inputs aren't needed to prove the rest:
- a code-signing certificate, an update host and key custody;
- then the native install step and a signed upgrade from one version to the next.

This step runs the journey on the installed app and records what's proven and what's still open.

**Run** in an isolated profile on the installed `Hydra.exe`, with Nico's Claude subscription sign-in and no API keys:
1. Onboarding, from a fresh profile.
2. A plan with two dependent heads, where the second uses the first's result.
3. A command gate that fails once, which the head then fixes.
4. A lane: work, gates, merge. Then Open PR, as far as the compare URL; no real PR on a public repository.
5. A window reload while a head runs, and what Hydra says afterwards.
6. A keyboard-only pass over the Agents view, a lane tile and Settings: focus order, visible focus and labels. Also a contrast check of the main text in dark and light themes.
7. A usage-limit handoff can't be caused on purpose. It's recorded as covered by the existing tests unless a real limit happens.

**Record:** `docs/Windows_Journey.md`. It lists the exact build (commit and version), what each step showed, the evidence status (Step A) of each job, and what stays open, with who owns it.

**Where:** main session only. It spends real usage and needs judgement.

## Step C: opt-in dispatch of plan jobs to lanes (item 3)

**Build:** a per-plan setting, **Auto-dispatch to lanes**:
- **Settings:**
  - **Lanes at once:** 1–4, the lane slots;
  - **Provider:** Claude by default;
  - **Attempts:** 3 by default.
- **Assignment:**
  - A lane job that's ready goes to the next idle slot as a fresh lane from its base commit.
  - A slot is idle when no job of this plan is running in it.
  - Each job is assigned exactly once, keyed by plan, job and attempt, as lane jobs already are.
- **When the lane's agent calls `hydra_job_ready`:**
  - Hydra runs the gates itself.
  - If they pass, it marks the job done with its commit and evidence status.
  - If they fail, it types the exact failures into that lane, using the Send to lane text, and counts an attempt.
  - When the attempts run out, the job fails, and the jobs after it are skipped with the reason.
- **Respects everything that already holds:** dependencies, write scopes (in the brief), Stop all (5.3) and a window reload. Restarting adopts the lanes that already exist, never starts duplicates.
- **You stay in charge:**
  - The lane tile says "Auto-dispatched · attempt 2 of 3".
  - You can type into the lane, mark the job done yourself, cancel it, or turn the mode off.
  - Turning it off leaves running lanes alone.
- **Unchanged:** manual lanes, and plans without the setting.

**Where:** `plans.ts` (setting), `planRunner.ts`, `laneService.ts`, `extensionLanes.ts`, `helperService.ts` (`hydra_job_ready`), and the plan UI in the webview.

**Tests**, with a fake terminal: two slots and three dependent jobs.
- Each job is assigned once.
- The dependency order holds.
- A gate failure goes back to the same lane.
- Retries are bounded, and then the job blocks and skips what follows.
- Stop and restart don't dispatch twice.
- A manual override wins.

**Live checks:**
- A two-job plan with one Claude lane slot and a gate that fails first.
- Turning the mode off partway through.

## Step D: a read-only view across projects (item 4)

**Build:**
- **Each window publishes a small summary** beside its discovery record, as `helpers/windows/<id>.summary.json`:
  - its folder, with the name shown only locally;
  - counts of running heads, lanes and plans;
  - blocked jobs and their reasons;
  - each job's evidence status (Step A);
  - its providers;
  - `updatedAt`.

  It's written on change, at most once a second, with a heartbeat every 60 seconds.
- **Hydra: Show All Projects** lists every window's summary. It's read-only.
  - A window whose process is gone, or whose heartbeat is over 3 minutes old, shows as "Not responding" or "Closed", never as running.
  - **Open** focuses the owning window by opening its folder, which VS Code focuses when it's already open.
- **Never over the network:** only the owning window changes its jobs, and there's no endpoint for other windows. The summaries are plain files in Hydra's global storage, where heads can't write.

**Where:** `src/core/helperDiscovery.ts`, a new `src/core/projectSummary.ts`, `src/core/hydraTree.ts` (reused lines) and `src/extension.ts`.

**Tests:**
- Summaries are written and debounced.
- A window whose process is gone, or whose heartbeat is stale, is never shown as running.
- The view is read-only: no command changes another window.

**Live checks:**
- Two probe windows on two repositories: one shows both.
- Close one, and it shows as closed.

## Step E: a preview for each lane (item 5)

**Build:**
- **Lane menu → Preview app:**
  - It starts the project's dev server in that lane's worktree, on a free port the lane owns, passed as `PORT` and `{port}`.
  - The command comes from the project's screenshots gate, or is asked for once and saved in `.hydra/preview.json`.
  - It waits until the server responds, then opens the page in VS Code's Simple Browser.
  - One preview per lane.
- **The tile shows** "Preview on :port", with Stop.
- **The server stops** when you press Stop, close the lane, or Stop all, and when the window closes.
- **Two lanes preview side by side** on different ports, each from its own worktree.
- **From the same tile**, you can open the lane's changed files, its diff and its gate evidence, including screenshots at three widths.
- **The page is untrusted content** (threat model): it runs in the Simple Browser's own sandboxed view, with no Hydra access.

**Where:** a new `src/core/lanePreview.ts` (reusing `freePort`, `startApp` and `waitUntilReady` from the screenshots gate), `laneService.ts` (lifecycle), `extensionLanes.ts` and `webview/LanesView.tsx`.

**Tests:**
- The port is chosen and passed.
- Readiness is awaited.
- Two lanes get different ports.
- Closing a lane stops only its own server.
- Stop all stops every preview.

**Live checks:**
- Two lanes previewing a tiny server that prints its own worktree name.
- Close one: the other keeps running.

## Item 6: platforms

Decided above: Windows only for now. Before Hydra supports another platform, that platform needs:
- its own repeatable CI;
- a clean-machine install and upgrade;
- provider integration, and correct worktree paths;
- sandbox behaviour;
- signing or notarization;
- accessibility;
- a documented rollback.

A cross-platform Electron build alone doesn't count.

## Later candidates

- **Already done** in `Hydra_Improvements.md`, Step 5: a global stop, the audit log of denials, approvals and stops, and one shared redactor.
- **Another CLI provider**, for example OpenCode: only if users ask for it, and only if Hydra can keep the same gates, sandbox, usage-limit and resume rules for it.
- **Choosing an account per lane, and showing its usage:** only once the provider's own subscription behaviour can be checked without reading credentials or starting API-billed turns.

## When to use subagents

The main session (Opus) owns each step's plan, review, live checks, local gate, PR, merge and refresh.

| Work | Who | How |
| --- | --- | --- |
| Step A | One **Sonnet** subagent | In its own worktree. The main session reviews the diff line by line. |
| Step B | **Opus**, main session | It spends real usage, and each result needs judgement. |
| Step C | One **Opus** subagent | It's new orchestration across plans, lanes and gates, where a mistake starts work twice or never. |
| Step D | One **Sonnet** subagent | It shares no files with Step C, so the two run side by side. |
| Step E | One **Sonnet** subagent | After Step C merges, since both touch the lane service and tile. |
| Looking things up | Search directly, or an **Explore** subagent | Never for review or judgement. |

The rules for every subagent in `Hydra_Improvements.md` apply here too:
- targeted tests only;
- never run the `claude` or `codex` CLIs;
- never touch `~/.claude` or `~/.codex`;
- commit in small steps;
- report what was built, and what wasn't.

## Acceptance

Each step is done when:
- its unit tests pass;
- its live checks pass in an isolated probe window, with Nico's settings unchanged;
- the local gate passes;
- its PR merges with CI green;
- the installed app is refreshed.

Step B is done when `docs/Windows_Journey.md` records each step's evidence and each open item's owner.

## Decision rule

Don't call Hydra "better" because of a feature checklist. Compare the same end-to-end task on current public builds:
- time to start;
- how clear each agent's and job's state is;
- work finished and checked;
- recovery from a failure or a usage limit;
- accessibility;
- resource use;
- whether install and update can be trusted.

Hydra should win first on a reliable Windows IDE workflow, with honest evidence and safe recovery. Add surface only where the comparison shows a real cost to users.

## As built

### Step A (2026-09-26)

Built by one Sonnet subagent (`hydra-wt/evidence`). The main session reviewed the diff line by line, fixed what it found and ran the live checks.

**What it does:**
- **One status:** `evidenceStatus` (`src/core/jobs.ts`) gives each accepted job one of these, from its checks and how it was accepted:
  - `passed`: Passed required gates;
  - `partial`: Some gates not run;
  - `none`: No gates configured;
  - `none-chosen`: No gates (project choice);
  - `override`: Human override.

  A required gate that didn't run never counts as `passed`.
- **Where it's stored, with its commit:**
  - on a head's result (`HelperService.done`);
  - on a lane's last gate record: when gates run, when you choose Merge anyway or Mark done anyway, and when a merge ran no gates;
  - on a plan job's result.
- **Old records** keep no status; nothing is relabelled.
- **One label everywhere:**
  - the canvas node (a head, and a plan's lane job);
  - the lane tile, and the compact row of an exited lane;
  - the Agents tree;
  - the top line of View evidence;
  - the "### Checks" section of the pull request body, through GitHub's compare `body` parameter.
- **Stale checks:** a lane whose HEAD has moved past the recorded commit says "Checks are for an older commit" and keeps its status.
- **Starter gates:**
  - **Where:** Settings → Gates has "Starter gates". When a project has no `.hydra/gates.json`, the first lane merge or accepted head offers the same choice once, without blocking.
  - **The choices:** "Add a test gate": `npm test`, the only choice when `package.json` has a test script. "No gates for this project": `{"gates": []}`. "Not now".

**Fixed in review:**
- **A lane merged with no gates had no status.** It merged in a project with no gates, or one that doesn't gate lanes, so no gates ran and nothing was recorded, leaving exactly the unlabelled "done" this step removes. `recordNoGates` now records `none` or `none-chosen` for the merged commit.
- **A pack's gates didn't count** when the project had no `gates.json` of its own, so such a job read "No gates configured". Any effective gate now counts as configured.
- **An exited lane's compact row** didn't show the status. Tile and row now share one `EvidenceChip`.
- **The tree label had no test.** `tests/hydraTree.test.ts` now checks the lane, stale-lane and head labels.

**Live checks (probe window):**
1. **A passing gate:** a lane committed `ok.txt`, and Run gates made its tile read "Passed required gates".
2. **A new commit:** the tile then read "Passed required gates — Checks are for an older commit".
3. **An override:**
   - Removing `ok.txt` made the gate fail, and Merge offered Merge anyway.
   - After the merge, the tile read "Human override" with `✗ has-ok`.
   - The lane record holds `override` for the merged commit (`637e8b2`, equal to `mergedHead`).
4. **A project with no gates:**
   - The merged lane reads "No gates configured".
   - The one-time offer appeared with "Add a test gate (npm test)", and choosing it wrote the gate.
   - A lane merged afterwards ran `npm test` as a gate on Windows and recorded `passed`. Its exited row shows the status.
5. **Config:** Nico's Claude and Codex settings were unchanged. `~/.claude.json` gained a project entry for the fixture, left alone because editing it can race running Claude sessions.

**Not checked live here:**
- **The canvas and plan view labels:** they need heads and a plan, and Step B's journey exercises them with real heads.
- **The pull request body:** this needs a GitHub remote. Unit tests cover its content and the size limit.

**Tests:**
- `tests/evidenceStatus.test.ts`: 13.
- `tests/hydraTree.test.ts`: 9, including the new one.
- Unchanged and passing: `lanes` 11, `laneGit` 9, `helperService` 21, `planRunner` 15, `planLanes` 11, `gates` 16, `audit` 11.

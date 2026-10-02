# Hydra heads

You chat with Claude in the Claude Code extension, or with Codex in the Codex extension. When a task has independent pieces, the agent hands them to **Hydra heads**: separate agents that Hydra runs in their own git worktrees, checks, and hands back. The agent you're chatting with is the **lead**, and it merges the heads' work with git.

You don't have to ask for heads. Hydra tells the lead to decide by itself: before a code change, it checks whether the work splits into independent pieces with separate files (a feature and its tests, frontend and backend, several unrelated fixes). If there are two or more pieces worth a few minutes each, it starts one head per piece without asking or announcing it; the heads appear on Hydra's Agents view. Small, tightly coupled or question-only tasks stay with the lead. You can still ask for heads, or ask it not to use them.

This replaces the old Auto delegation, which read a `HYDRA_DELEGATION_V1` line out of chat text. How it was designed and verified is in [Official_Extensions_Plan.md](internal/Official_Extensions_Plan.md).

## Connecting Claude Code and Codex

**On the first run, Hydra does it for you.** The first time the Hydra app opens a trusted project:
- It connects whichever agents are already on this computer: `claude` or `codex` on your `PATH`, or the path set in `hydra.claudePath`/`hydra.codexPath` (user settings only: a repository's own settings can't set them, nor `hydra.worktreeRoot`, `hydra.packs.folder`, `hydra.claudeMem.enabled` or `hydra.updates.check`).
- It installs their extensions as it goes, with its progress in a notification.
- It happens once. An agent that's already connected with its extension installed here is left alone; one connected from another editor gets its extension here and is pointed at this Hydra. One that fails says why, with a button to **Connectors**.
- An agent that isn't installed yet is connected with **Connect**, once you've installed it.

**By hand:** connect in onboarding (step 03, Providers) or in **Hydra Settings → Connectors**, which also shows the exact entries Hydra wrote. Each agent has one row with a single **Connect to Hydra** button:

1. It installs the official extension if it's missing. It tries the extension gallery first. If the gallery can't install it, for any reason, Hydra downloads it straight from Open VSX instead. (Open VSX's gallery answers "Server returned 406" for some platform-specific extensions, Claude Code among them.)
2. It connects the extension to Hydra.

**Where to start:** Hydra's first launch shows its side bar (New lane, New plan, Open Agent Manager) and opens the welcome wizard. Finishing the wizard, or choosing **Set up later**, opens the Agent Manager. Later on, **Alt+Shift+A**, the **Agent Manager / Editor** switch in the title bar, or the status bar item switches between the two.

The row also has Disconnect and Sign in. Claude Code and Codex keep their own sign-in and billing.

**Memory (claude-mem), opt-in:** the Claude row in Settings → Connectors has a separate **Memory (claude-mem)** toggle for [claude-mem](https://github.com/thedotmack/claude-mem), a third-party memory plugin. It's off by default (`hydra.claudeMem.enabled`), and Connect never touches it on its own. Turning it on asks once, then:
- installs Bun into `~/.bun/bin` from Bun's official release, if missing;
- installs claude-mem through `claude plugin` if missing, or updates it;
- installs claude-mem's dependencies.

Hydra redistributes neither Bun nor claude-mem. Turning the toggle off only stops Hydra from managing it; anything already installed stays, and a **Repair** button (shown once the setting is on) re-runs the same setup to fix or update it. claude-mem runs in your chats and lanes; heads don't load it (see Limits and permissions).

Connecting adds Hydra as a user-level tool server named `hydra`. That's per user, never per project; nothing is written inside a repository.

| Agent | What Hydra writes | Undone by Disconnect |
| --- | --- | --- |
| Claude Code | `claude mcp add-json -s user hydra …` (stored by Claude in `~/.claude.json`), and an `"mcp__hydra"` allow rule in `~/.claude/settings.json` | Yes. `settings.json` is restored byte for byte |
| Codex | A marked `[mcp_servers.hydra]` block at the end of `~/.codex/config.toml`, and a marked "Hydra heads" block with the same delegation guidance at the end of `~/.codex/AGENTS.md` (Codex may not read MCP instructions) | Yes. Both files are restored byte for byte; an `AGENTS.md` that Hydra created is removed |

- **What the tool server is:** `dist/hydra-mcp.cjs`, run by Hydra's own executable with `ELECTRON_RUN_AS_NODE=1`, so Node doesn't need to be installed.
- **Hydra updates:** if an update moves Hydra's executable, Hydra refreshes an existing connection on its next start. Apart from the first run above, it never connects anything you didn't.
- **When heads are available:** only while a Hydra window has that folder open. Otherwise the actions answer "Hydra isn't open for this folder".

## What the agents can do

**The lead:**

| Action | What it does |
| --- | --- |
| `hydra_start_head` | Start a head, given `title`, `brief`, `write_scope` (repository paths it may change), `idempotency_key`, and optionally `provider`, `model`, `depends_on` and `limits`. Returns a job id at once. A repeated key returns the same job instead of starting another. |
| `hydra_wait_for_heads` | Wait until the heads finish or ask a question, then return their results. It keeps the lead's turn open; Claude and Codex both resume by themselves when it returns. `max_wait_s` defaults to 1800. |
| `hydra_get_head` / `hydra_list_heads` | State, summary, branch, commit, changed files and check results. |
| `hydra_reply_to_head` | Answer a head that asked a question. |
| `hydra_cancel_head` | Stop a head. Its branch is kept. |

**A head:**

| Action | What it does |
| --- | --- |
| `hydra_done` | Report the work finished. Hydra commits anything left uncommitted, refuses changes outside the write scope, and runs the checks, all inside the call. If something fails, the head is told what to fix, with up to 3 attempts. |
| `hydra_stuck` | Ask the lead one question. The call waits, and the lead's answer comes back as its result. If nobody answers, Hydra answers instead: at once in an unattended plan, after 20 minutes otherwise (see [When nobody answers](#when-nobody-answers)). |
| `hydra_progress` | A short note for the dashboard. |

**A head's first message** is the brief plus, so it doesn't spend its first turns rediscovering the project: its worktree, branch and base commit, the paths it may change, and what the heads or jobs it depends on did. It also gets a **Repository** section — the base commit's tracked files, one per line (an unusual name with a control character, a backslash or a quote in it is shown quoted, never raw), or, past ~200 paths or ~6000 characters, collapsed to top-level directories with a file count each (capped at 60 directory lines) — and the project's gate commands from `.hydra/gates.json`, stated as "Hydra runs these gates after you call hydra_done." With no command gate, `package.json`'s own `test` script gets its own honest line instead — Hydra doesn't run it, so the head is told to run it itself before `hydra_done`, and isn't told to "run only what your change touches" (nothing else would test the rest). A few lines of working guidance come with it, worded for what this particular head has: Claude heads are told to prefer Read, Grep or Glob over `cat`/`ls`/`find`, that their shell already starts in the worktree (so no `cd`), which command shapes Claude Code denies them (see "Limits and permissions"), to pipe output to `tail`/`grep`/`head` rather than save it to a file, and to rerun a denied command in a simpler shape instead of giving up on the shell; Codex heads, which have no such tools, only hear to batch shell commands, since each one starts slowly here; a Claude head with no shell at all hears to use Read, Grep or Glob instead, since there's nothing to batch. A generous timeout for a slow test command, rather than retrying it after it times out, always applies. None of it is file contents, and the whole addition is capped, so it can't grow the brief open-ended.

## Lifecycle

```
queued → starting → running → checking → done
                       ⇅          │
                    blocked       └→ running (checks failed, attempts left)
any unfinished state → failed or cancelled
```

- **The state table:** every change is checked against one allowed-transitions table in `src/core/jobs.ts`, written atomically, and kept in the job's history.
- **Queueing:** heads wait in a queue up to `hydra.maxConcurrentHelpers` (default 3). A head whose dependency failed or was cancelled fails too.
- **Silent stops:** a head that stops without calling `hydra_done` or `hydra_stuck` is nudged once, then failed. A head process that exits is failed.
- **After a restart:** heads that were running are failed with the reason, because no head process survives a restart.
- **Waiting on the provider:** a running head can also be waiting on its provider. See [Waiting on the provider](#waiting-on-the-provider).
- **Never blocked for good:** a blocked head goes back to running when its question is answered, including when Hydra answers it itself. See [When nobody answers](#when-nobody-answers).
- **Silent heads:** a running head whose stream goes silent mid-turn is recorded, nudged, and then failed. See [A silent head](#a-silent-head).

### When nobody answers

`hydra_stuck` blocks the head until someone answers: the lead with `hydra_reply_to_head`, or you with **Answer question…** on the canvas. Both work as before. When nobody does, the head doesn't stay blocked:

- **In an unattended plan,** nobody is watching, so Hydra answers at once: "Nobody is watching this plan, so no one will answer. Decide within your scope and brief. If something outside your write scope needs changing, finish your own part and describe what needs changing in hydra_done's summary. Then call hydra_done." The head never waits.
- **Otherwise,** the question waits 20 minutes. If no answer comes by then, or the head's own call ends first (its MCP call timeout, or its CLI cancels the call), the head goes back to **running** with the same kind of answer ("No answer came within 20m, so carry on without one…"), and `hydra_done` is accepted again.

Back to running, rather than failed, because the head is still alive and its work is still in its worktree. It can usually decide within its brief, and its gates still check the result. Before this, a head whose call timed out stayed **blocked**: every `hydra_done` it sent was refused ("can't report done while it is blocked"), and it burned its whole 30-minute work clock doing nothing.

Why a Hydra-side wait instead of a shorter MCP timeout: the head's MCP timeout (an hour) covers every Hydra tool, including `hydra_done`, whose gates can take many minutes. Shortening it would cut those off too.

Each automatic answer is recorded:

- on the job, as a reply marked `auto` (`unattended` or `no-answer`) with the question it answered, and in its history;
- for the lead, as `auto_answered` in `hydra_get_head` and `hydra_list_heads`. A late `hydra_reply_to_head` is refused and says when the head stopped waiting and why;
- in the plan's report, under the job and under **Needs you** ("its question was answered automatically; check its summary…");
- in the audit log, as `kind: "auto"`.

Time spent blocked still doesn't count toward the head's work time.

### A silent head

A head's CLI can go quiet with a turn still open: a response stream the provider stopped sending, with no retry notice for [Waiting on the provider](#waiting-on-the-provider) to see. One benchmark head wrote "I'll finish up now" and then produced nothing for 25 minutes, until its CLI gave up on the stream by itself. Hydra's watchdog, checked every few seconds, now handles this:

"Silent" means no **model output**: for Claude Code, an assistant message, a partial-message chunk or a tool's result; for Codex, any item event. Retry notices count too, since the CLI is still working and [Waiting on the provider](#waiting-on-the-provider) shows that wait.

| Silent for (Claude Code / Codex) | What Hydra does |
| --- | --- |
| 3 minutes / 3 minutes | Records it as a wait on the provider: "No response from Claude for 3m" on the card, in the heads list and in `hydra_get_head` (`provider_wait.silent: true`). The wait ends at the model's next output. Its time adds to `providerWaitMs` and the plan report like any other wait. |
| 5 minutes / 10 minutes | Nudges the head, once per silence. **Claude Code:** Hydra sends a stream-json `interrupt` control request, and sends a "continue where you left off" message only after the interrupted turn has ended. That turn's `result` isn't counted as the head stopping. Until then, nothing the CLI sends counts as output: its answer to the interrupt, the partial text it flushes, and its "[Request interrupted by user]" line are all the interrupt's doing. **Codex:** Hydra stops the stalled `codex exec` and resumes its thread with the same message. |
| 10 minutes / 15 minutes | Fails the attempt ("No response from Claude for 10m: its stream went silent with no tool running…") instead of letting it hang. Nothing retries it on its own. Like any failed job, a plan's job shows in `hydra_plan_wait`'s `needs_attention`, the jobs that don't depend on it carry on, and the lead or you can retry it (`hydra_plan_amend`'s `retry`, or **Retry failed jobs**). |

- **What never counts as silence:**
  - a tool call in flight: a `tool_use` without its `tool_result` yet (Claude Code), or an item started and not completed (Codex). A long `npm test`, or a head's own `hydra_stuck` or `hydra_done`, is work;
  - the gap after a turn ends. A head that stops without reporting is still nudged once and then failed, as before.
- **What doesn't reset the count:** the lines a nudge itself causes. For Claude Code, that's everything from the interrupt to the interrupted turn's `result`, then the next turn's `system` init. For Codex, it's a resumed exec's `thread.started` and `turn.started`. A `user` line counts only when it carries a tool's result. So a head nudged once and still hung is failed, not interrupted again every few minutes. Only new model output starts a new silence.
- **Where the thresholds live:** `claudeSilenceLimits` and `codexSilenceLimits` in `src/core/headSilence.ts`.

**Long responses.** Claude heads run with `--include-partial-messages`, so a response being written, such as a large file in one Write, streams a line per chunk and is never taken for silence. The head's log keeps a count of those chunks (`partial`), not the chunks themselves. `codex exec --json` has no partial output: a long message or a large file change arrives only when it's complete, and a nudge stops the exec, which throws that work away. That's why Codex waits 10 minutes before a nudge.

### Waiting on the provider

A head whose CLI is retrying against its provider stays **running**, but produces nothing until a request gets through. That can take many minutes when the account is rate-limited. Hydra reads it from the head's own stream:

- **Claude Code:** `{"type":"system","subtype":"api_retry","attempt","max_retries","retry_delay_ms","error_status","error"}` lines while it retries. A `{"type":"rate_limit_event","rate_limit_info":{"status","resetsAt","rateLimitType","utilization",…}}` line starts a wait only when its `status` is `rejected`; while a wait is open, it adds the limit window, how much of it is used, and when it resets.
- **Codex:** an error line or error item whose message reads `Reconnecting... n/m (…)`.

The wait is dated from the last line before the first retry, which is when the stalled request went out. The wait ends at the next ordinary line, or when the process ends. While it lasts, the head's job keeps `providerWait`: since when, the retry count and attempt, whether the provider said it's a rate or usage limit, and any reset time or detail. It shows:

- on the head's card on the Agents canvas, in the heads list and in the Hydra tree: "Waiting on your Claude usage limit for 13m (retry 3)", or "Waiting on Claude's servers for 2m (retry 3 of 10)" when the provider only dropped the request;
- in `hydra_get_head` and `hydra_list_heads` as `provider_wait` (`message`, `since`, `retries`, `attempt`, `max_retries`, `limit`, `resets_at`, `detail`, `waited_ms`).

Every wait that ends adds to the job's `providerWaitMs`, returned as `provider_wait_ms`. A plan's report lists the jobs slowed by provider limits and their total wait, and the benchmark keeps each job's `providerWaitMs` so a comparison can subtract or flag it. A wait still counts toward the head's time limit.

This only covers a CLI that is still retrying. A turn that ends on a usage limit is a hard limit, handled as described in [When a provider hits its limit](#when-a-provider-hits-its-limit), and nothing about that changes.

## Limits and permissions

- **Starting point:** each head gets a new worktree and branch from the lead folder's **current HEAD**. If that folder has uncommitted changes, the lead is warned that the head won't see them.
- **Limits** (the lead can change them per job): by default 30 minutes of work (time spent waiting for an answer doesn't count), 60 turns and 5 USD. Change the defaults in **Hydra Settings → Heads**. The turn and cost caps apply to Claude only.
- **No permission prompts:** heads never ask anyone.
  - **Claude:** `--permission-mode dontAsk` with an explicit tool list: file tools that write only inside the worktree, Bash only in Codex's Windows sandbox (see Security), never PowerShell, and Hydra's head actions; web tools only for a role that has them. Anything else is denied and the head carries on. Only your user settings load (`--setting-sources user`), so your user-level allow rules in `~/.claude/settings.json` still apply to heads. Your plugins (claude-mem, for example) are turned off for heads: a head can't use their tools, and their hooks would slow every head command down. Your settings' own hooks are off too, and your `CLAUDE.md` and auto memory don't load (see "Your sign-in only" below). A role's skills and your sign-in are unaffected.
  - **Claude head shell commands Claude Code denies:** a head's settings block reads outside its worktree (`blockReadsOutsideWorkingDirectories`, see Security). With that block on, Claude Code must work out every path a Bash command touches before running it; when it can't, the command needs approval, which `dontAsk` turns into a denial ("…denied because Claude Code is running in don't ask mode") that the `Bash` allow rule doesn't override. Measured on Claude Code 2.1.282: `cd <worktree> && node --test … 2>&1 | tail` (a `cd` together with a redirect, even `2>&1`), any `for`/`while` loop, and a redirect to `/tmp` or `"$TMPDIR/…"` are denied; the same commands without the `cd`, `&&` chains and pipes to `tail`/`grep`/`head` run. Heads used to start every test run with `cd <worktree>`, were denied, and stopped using the shell, so the first message now tells them their shell already starts in the worktree, which shapes are denied, and to retry a denied command in a simpler shape. The read block itself stays: it is what keeps a head's file tools inside its worktree in every path spelling.
  - **Codex:** `codex exec` with the `workspace-write` sandbox and approval `never`. On Windows that sandbox blocks writes to a worktree's `.git` metadata, which is why Hydra does the commit.
- **Your sign-in only (HSEC-71):** heads and reviewers run with your login and nothing else of yours: no personal instructions, memories, plugins, hooks or MCP servers. That includes the `hydra` entry Hydra adds to your Codex `config.toml` for the lead, whose tools start heads. A head's only servers are Hydra's head bridge and its role's servers; a reviewer has none.
  - **Codex** heads and reviewers use Hydra's own Codex home, `codex-home` in Hydra's storage. It holds a hard link to your `auth.json`, so a token refresh by either side reaches the other and your sign-in never goes stale; a copy would log one of them out on the first refresh. It also holds links to your Windows sandbox set-up, so Codex doesn't need an administrator to set it up again. Your `AGENTS.md`, skills, memories and sessions aren't there. Codex also runs with `--ignore-user-config`, with the features that reach past the task turned off (connected apps, plugins, hooks, memories, browser and computer use) and no skills listing. Your `model`, `model_reasoning_effort`, `service_tier` and `windows.sandbox` settings still apply. A head's `-m` model still wins.
  - When there's no `auth.json` to link (you sign in with an API key or a keyring), the link fails, or Hydra's copy holds a later sign-in than yours (a link that split; Hydra won't overwrite it, and logs that you may need to run `codex login`), Codex uses your own home with the same flags. Your `config.toml` still stays out, but your `AGENTS.md` loads. Hydra logs why, and a head keeps its sessions in whichever home it started with.
  - **Claude** heads and reviewers run with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so no `CLAUDE.md` or auto memory loads. Their settings file turns every hook off (`disableAllHooks`) and your plugins off. A reviewer also gets `--disable-slash-commands` (no skills) and `--strict-mcp-config` with no servers. Your sign-in, model and user permission settings still load.
- **Stop everything (heads only):** **Hydra: Stop All Heads** in the command palette, **Stop all heads** in **Hydra Settings → Heads**, or **Stop all** on the dashboard. Cancels every running head; heads may still start again right away.
- **Stop everything, for good (5.3):** **Hydra: Stop All Agents** (command palette, or **Stop all agents** in **Hydra Settings → Heads**) cancels every head (and its gates), ends every lane's process while keeping the lane and its worktree, and refuses new heads, lane launches and plan advances with the reason — until **Hydra: Resume Agents** clears it. It asks to confirm first, unless called with `{ confirm: false }`. The stop is saved for the workspace (it survives a reload) and a status bar item, **Hydra stopped**, shows while it's on; click it to resume.

## When a provider hits its limit

A head that hits its provider's usage limit fails at once, with that as its reason. It doesn't spend a check attempt and it isn't nudged — the limit isn't its fault. The same detection covers a Claude Code or Codex chat in the official extension hitting its own limit.

Either way Hydra shows one notification: which provider hit its limit (and when it resets, if known) and a **Continue in <Other provider>** button (**Set up <Other provider>** instead, if it isn't connected yet), plus **View handoff** and **Wait**. The handoff — the ask, files touched, git state, and what looked unfinished — is assembled mechanically (no model call) and saved under Hydra's global storage, not in the repository.

For a head, **Continue in** switches its provider and restarts it **in the same worktree and branch**, with the handoff appended to its brief, so partial work isn't lost. The lead sees it running again through `hydra_wait_for_heads` like any other head. For a chat, Hydra copies the handoff to the clipboard and opens the other provider's chat (Hydra never types into it); paste the handoff there to continue. Turn the notification off with `hydra.limits.offerHandoff`.

## Gates

No agent grades its own work. When a head calls `hydra_done`, its changes pass the scope check and then this project's **gates** before they're accepted ([Gates_Plan.md](internal/Gates_Plan.md)).

**Where gates come from:** the **lead's** folder, never a head's worktree, so a head can't edit them away. Put them in `.hydra/gates.json`, or edit them in **Hydra Settings → Gates**:

```json
{
  "maxAttempts": 3,
  "lanes": "onMerge",
  "gates": [
    { "id": "unit", "type": "command", "command": ["npm", "test"], "timeoutSeconds": 600 },
    { "id": "ui", "type": "screenshots", "start": ["npm", "run", "dev", "--", "--port", "{port}"], "url": "http://localhost:{port}/", "widths": [390, 768, 1280], "required": false },
    { "id": "review", "type": "review", "reviewer": "other" }
  ]
}
```

**The three kinds:**
- **command:** runs in the head's worktree and must exit 0.
- **screenshots:** Hydra starts your app on a free port (it replaces `{port}` and sets `PORT`), then captures each width in a headless Edge or Chrome. The gate fails on a page that never gets ready, HTTP errors, console errors or an empty page.
- **review:** a second agent reviews the brief and the diff read-only. By default it's the other agent: Codex reviews Claude's work, and the other way round. Only blocker or major findings fail it.

**How results are handled:**
- **Order:** gates run as command, then screenshots, then review. Once a required gate fails, the rest are skipped.
- **Not blocking:** `required: false` gates are reported but never block.
- **Not run:** a reviewer or browser that can't run (not installed, rate-limited, timed out) marks its gate **not run**. That never fails the head. A reviewer that crashed (Codex exiting with code 1, say) or replied with something Hydra couldn't read is tried once more first, and the gate's summary says so; a timeout or a usage limit isn't retried.
- **Failures:** they go back to the head with the output and findings, up to `maxAttempts`.

**Seeing the results:** gate chips (**✓ unit · ✓ ui · ✗ review**) sit on the head's card. **View evidence** in its menu opens the output, findings (linked to file:line) and screenshots.

**Compatibility:** an older `.hydra/checks.json` still works, read as command gates. With neither file, a head is accepted after the scope check.

**Evidence status:** a plain "done" can be read as "independently proven" even when it isn't, so every finished head, lane and plan job also carries one truthful label, worked out from its checks and how it was accepted:

| Status | Shown as | When |
| --- | --- | --- |
| `passed` | Passed required gates | every required gate passed, and no gate was skipped |
| `partial` | Some gates not run | required gates passed, but at least one gate didn't run |
| `none` | No gates configured | the project has no gates file at all |
| `none-chosen` | No gates (project choice) | `.hydra/gates.json` deliberately lists none |
| `override` | Human override | Merge anyway or Mark done anyway after a failure |

It's stored with the commit it describes, on the head's result, the lane's last gates record and merge, and the plan job's result. Results from before this change carry no status and are never relabelled. A lane whose HEAD has moved past its recorded commit shows "Checks are for an older commit" instead of a made-up one. The same label appears on the canvas node, the lane tile, the plan view, the Agents tree and View evidence's first line, and Open PR adds a short "### Checks" section (the status, each gate's ✓/✗/– result and the commit) to the pull request body through GitHub's compare page `body` parameter.

**Starter gates:** a project with no `.hydra/gates.json` at all gets offered a deliberate choice once — from the first head that finishes, or the first lane merge, in it — between "Add a test gate" (`npm test`, detected from `package.json`'s `test` script), "No gates for this project" (writes `{"gates": []}`, so the project reads as a deliberate choice rather than unconfigured), and "Not now". The same choice is in **Settings → Gates → Starter gates**, any time.

**What a head starts from:**
- **Dependencies:** a head with `depends_on` starts from the finished work of the heads it waited on, merged into one commit when there are several. Its brief includes their summaries. If they conflict, it fails before starting and names the files.
- **Lanes:** a head started from a lane starts from the lane's latest commit.

## The Agents view

Also called the **Agent Manager**. It takes the whole window: only the title bar stays, and the side bars, panel, status bar and tabs step aside until you switch back to the Editor, which comes back exactly as you left it. Opening a diff, a log or a lane preview from it switches to the Editor. Open it with **Alt+Shift+A**, the **Agent Manager / Editor** switch in the title bar, or the status bar item. (Alt+Shift+A replaces the editor's own Toggle Block Comment shortcut.) In the Editor, the button next to the switch shows or hides the agent side bar on the right, where Claude Code and Codex chat (Ctrl+Alt+B does the same). It's a live canvas of your heads ([Agents_View_Plan.md](internal/Agents_View_Plan.md)):

- **Blank until a chat starts heads.** Each head grows out of the chat that started it: the **lead**, labelled with its provider, and a name if the chat gave one (`lead_label`).
- **What each head is doing:** state (Queued, Working, Needs an answer, Checking, Done, Failed), its latest progress note or question, branch and elapsed time. When it finishes: checks passed and files changed.
- **How heads connect:** a flowing edge from the chat while a head works, and amber dependency edges (`depends_on`) between heads. A dependent sits to the right of what it waits on.
- **Heads leave when they're merged.** Hydra notices within seconds when a head's commit is in your folder's HEAD, and the head collapses back into its chat. A finished head that isn't merged stays two minutes, then moves to the **Finished** tray. **Clear** empties the tray; new results still show up. A lane that has been exited for 10 minutes, with no heads running, moves to the **Parked lanes** strip; click it to open the lane.
- **Actions** (click the ⋯ on a head, right-click, or Shift+F10): **Open diff**, **Open log** (token removed), **Answer question…** for a head waiting on the lead, and **Cancel head**. **Stop all heads** is in the toolbar.
- **Heads list** on the side: Running, or All today. Selecting a head centres it on the canvas; Enter opens its diff.
- **Pause motion**, zoom (Ctrl+wheel) and drag to pan. Reduced-motion and high-contrast settings are respected.

Apart from plans (below), the view never starts work itself; everything else on it comes from what your Claude Code and Codex chats do.

### Plans

**Plans from the chat.** The lead can create and run a plan itself, without you opening the canvas. When a task splits into three or more pieces, or has a dependency between pieces, the lead calls `hydra_plan_create` with every job at once, dependencies named by key; Hydra runs the jobs itself, as heads, in the right order. The lead calls `hydra_plan_wait` for the result, `hydra_plan_amend` to add or change a job that hasn't started, and `hydra_plan_cancel` to stop it. It shows on the canvas exactly like a plan you drafted yourself, grouped under the chat that made it.
- **Approval:** by default it runs right away. Turn on `hydra.plans.leadPlansNeedApproval` to have a lead's plan open as a draft for you to run yourself, with **Run plan**.
- **Amending:** the lead can add jobs, edit a job's title, brief, write scope or dependencies, or skip a job, all only while that job hasn't started yet. A skipped job's reason is passed on to the jobs that depended on it. A job that has already started can't be changed this way.
- **Ownership:** a plan a lead makes is only for that same chat: another chat's lead, and a lane's agent, can't see or change it with these tools.

**The plan board.** Each plan holds a small board of messages between the lead and its jobs, read only by jobs of that plan:
- **The lead posts** with `hydra_plan_message`, to specific jobs (by key) or `to: "all"`. It shows up in that job's next `hydra_board`.
- **A job shares** a decision or result with the rest of the plan using `hydra_share`; it's added to the board for everyone.
- **Reading:** a job calls `hydra_board` for every post addressed to it, to the whole plan, or that it posted itself. `hydra_done` and `hydra_progress` name how many posts are waiting (`board_posts`) so a job that never checks still hears about it.
- **Trust:** a post from anyone but the reader comes back marked `untrusted: true` — a job treats it as data, never as instructions, the same way a gate review does. The lead sees every post this way too, except its own.
- **Limits:** a post is at most 2,000 characters, with an optional 200-character topic; a plan's board keeps its most recent 500 posts.

**Plans that adapt.** A lead's plan keeps going instead of stopping at the first failure:
- **Independent jobs keep running** when one fails; only the jobs that depend on it are skipped, with a reason.
- **`hydra_plan_wait` returns early** for a job that failed, not just one asking a question, and `needs_attention` on `hydra_plan_get`/`hydra_plan_wait`'s reply names every job that needs the lead now.
- **`hydra_plan_amend`'s `retry`** restarts a job that failed or was skipped (by the lead, or automatically because its dependency failed), with its attempt count up by one. It can come with a wider `write_scope`, a clearer brief or a different provider. Retrying a job never un-skips its own dependents on its own — name them too when the whole chain should resume.
- **A history:** every add, edit, skip and retry is kept on the plan (`amendments` on `hydra_plan_get`), oldest first.
- **A limit:** `hydra.plans.maxAmendments` (10 by default; 0 means unlimited) caps how many changes one plan can take before `hydra_plan_amend` is refused. Cancel it, or start a new plan, once you hit it.

**Rigor.** Each job in a lead's plan has a rigor, on top of the project's own gates, which always run regardless:
- **`quick`:** nothing extra.
- **`standard`** (the default): the job runs the project's own gates only. The plan then gets one review of its whole combined diff by the other agent, in its integration gate (see **Landing a plan together**), instead of a review on every job: one agent run per plan rather than one per job, and no job sent back over review comments that the combined review would catch anyway.
- **`strict`:** also a review of the job on its own by the other agent, if the project doesn't already have one configured, as well as the plan's review. Rigor only ever adds; it can't remove or weaken a gate the project requires.

Set it when a job is created (`hydra_plan_create`'s `rigor`) or changed later (`hydra_plan_amend`'s `edit` or `retry`).

**Both providers as one pool.**
- **A guaranteed independent reviewer, honestly.** When a job's usage-limit handoff means both Claude Code and Codex wrote part of its diff, "the other agent" has no independent choice left. Hydra reviews with the job's current agent anyway and says so plainly in the evidence, rather than quietly picking one and calling it independent.
- **Plan jobs fail over on their own.** With `hydra.limits.autoContinuePlans` (on by default), a plan's job that hits its usage limit continues in the other provider right away — nobody may be watching an unattended plan to answer the usual prompt. Turn it off to have a plan job's limit offered like any other head's.

**Unattended plans.** Start a plan, walk away, and read what happened. Pass `run: "unattended"` and a `budget` to `hydra_plan_create` (a lead's plan; the canvas's own **New plan** doesn't have this yet):
- **Heads only.** An unattended plan can't have a lane job — nobody may be there to drive it — and `hydra_plan_create`/`hydra_plan_amend` refuse one outright.
- **A budget, checked up front and enforced while it runs:**
  - **`usd`** and **`max_jobs`** are checked when the plan is created or amended: `max_jobs` refuses a job count over the cap outright, and `usd` refuses a worst-case estimate (job count × `hydra.heads.defaultBudgetUsd`) over the cap. Hydra has no live spend meter — only wall-clock time is ever actually enforced while a job runs — so both are honest estimates checked at the door, not a running total. (What each head's runs did cost is recorded after they end, as the provider reported it, for the report; it's never used to stop a plan.)
  - **`wall_clock_minutes`** is enforced for real: once that many minutes have passed since the plan started running, Hydra cancels whatever is still going, the same as **Cancel job**.
- **It asks nothing while it runs:** it always behaves as if `hydra.limits.autoContinuePlans` were on, regardless of that setting, and a head's `hydra_stuck` gets an automatic answer at once (see [When nobody answers](#when-nobody-answers)).
- **Stop All Agents still latches** — it stops an unattended plan exactly like any other.
- **The report.** When the plan ends (finishes, or its wall-clock budget runs out), Hydra writes a Markdown report next to the plan, opens it as a tab, and shows a notification. For each job: what changed, its gates and evidence, its attempts, provider (and any usage-limit handoff), time and cost as the provider reported it (Claude Code in dollars, Codex in tokens; a job that reported nothing says so, with the per-head budget as the estimate), with the plan's total at the top, plus every amendment made to the plan. Then the integration gate (see **Landing a plan together**): the branch, what landed, and the gate's result and checks for the branch as it is now. A question Hydra answered automatically is named under its job. Last, what still needs you: a job that failed or is asking a question, a job whose question was answered automatically, a stopped landing queue, an integration gate that didn't pass, or, when it passed, merging the plan. A plan that finishes waits for its integration gate before writing the report, so the report has the result; one that stops incomplete writes it at once. Running the gate again later updates the saved report without opening it again. `hydra report <id>` prints the same report.

**Landing a plan together.** Every job can pass its own gates while the combination is broken, so nothing a plan does reaches your branch until the combined work has passed too:
- **The integration branch.** The first time a plan runs, Hydra cuts `hydra/plan-<id>` from the commit your checkout is on, and remembers the branch you were on.
- **The landing queue.** When a job passes its gates, its commit joins a queue that lands one job at a time on the integration branch, in the order they finished: a fast-forward when nothing else landed first, otherwise a merge commit Hydra makes without touching any worktree, your checkout or its index. The job's card says where it stands ("1 job ahead of it in the landing queue"); it counts as done once it has landed.
- **Dependents start from the tip.** A job that depends on others starts once they have all landed, from the integration branch's tip — one base that already has their work, merged and checked — and its brief still says what each of them did. This replaces merging several dependencies in memory for plan jobs; a loose `hydra_start_head` head still does that.
- **When a landing conflicts,** the branch doesn't move. The job goes back in the queue as a new try that starts from the integration tip: Hydra merges its previous try into the new worktree, so only the conflicting files are left (with git's markers), and its brief gets a **## Conflict** section naming them. That spends one of its 3 tries. When they run out, the job is held for the lead: it shows as failed, naming the files, in `hydra_plan_wait`'s `needs_attention`; `hydra_plan_amend`'s `retry` (or **Retry failed jobs**) gives it a fresh set of tries.
- **The integration gate.** Once the last job has landed, Hydra runs the project's command gates on the integrated tree, in a worktree of its own that it removes afterwards; unless every job is `quick`, also one review of the whole combined diff by the other agent (the project's own review gates, if it has any). The lead can run it any time with `hydra_plan_integrate` (or **Run integration gate** on the canvas). The plan then shows one honest label, the same as a job's: **Passed required gates**, **Some gates not run**, **No gates configured** or **No gates (project choice)** — or **Integration gate failed**. A result is for the tip it ran on: more work landing makes it out of date.
- **Fixing what it finds.** When the integration gate fails, Hydra adds a job to the plan, **Fix the integration gate's findings**, that starts from the integration branch with everything the gate reported: each failed check, a review's findings, and a command's last output. It may change any file, lands like any other job, and the gate runs again once it has. The plan runs again meanwhile, so `hydra plan wait` keeps waiting and the report waits for the last gate run. After two rounds (`hydra.plans.integrationFixRounds`; 0 turns this off) a gate that still fails is left for you, as before.
- **Merge plan.** Only **Passed required gates** on the branch as it is now offers **Merge plan** (a fast-forward or a merge of the integration branch into the branch the plan started from, which your checkout must be on) and **Open PR** (the lanes' push, and GitHub's compare page with the gate's result as the body). The lead's `hydra_plan_merge` (with `via: "pr"` for a pull request) is refused otherwise, saying why. After the gate ran and didn't pass, **Merge anyway…** on the canvas asks first and is recorded in the audit log; a lead can never do that.
- **Restarts.** The queue is kept with the plan, so a restart picks it up where it was: a landing that had already moved the branch is recorded once, not repeated, and an integration gate that was cut short runs again. A plan's head that was waiting for the lead's answer goes back in the queue in its own worktree, told that Hydra restarted, instead of failing.
- **Hands off the branch.** Hydra only moves `hydra/plan-<id>` while nobody has it checked out. If it is anywhere but where Hydra left it, the queue stops and says so, rather than moving it back or landing on top. That includes commits added on top of it: only jobs' checked work goes on this branch, so give that work to a job instead. Move the branch back and the queue goes on at the plan's next event.
- **A plan lane lands with the rest.** A lane that runs a job of a plan with an integration branch finishes with **Mark job done**, which lands its commit on the integration branch like any other job. The lane's own **Merge** refuses, saying so, until the plan is merged: otherwise the job's work would reach your branch without the integration gate.
- **Conflicts are predicted against it too.** While a plan's head runs, Hydra also checks its work against the integration branch's tip, which moves as other jobs land (see **Conflict prediction between heads**).
- Plans that were already running before Hydra had integration branches carry on without one, as they started.

**New plan** (in the canvas toolbar, or **Hydra: New Plan**) lets you set the jobs up yourself before any head starts ([Lanes_And_Planner_Plan.md](internal/Lanes_And_Planner_Plan.md), section 4):

- **Plan with Claude or Codex:** give a title and a brief. Your default provider reads the repository in read-only mode and splits the brief into 2–8 jobs. **Start empty** adds the jobs by hand instead.
- **Edit the draft on the canvas:**
  - Click a job to change its title, brief or provider.
  - Drag from a job's ⋮ handle onto another job to make that job depend on it.
  - Right-click an edge, or select it and press Delete, to remove it.
  - Right-click a job for **Depends on…** and **Delete**.
- **Cycles are refused.** A plan whose dependencies loop shows the loop, draws it in red, and can't run until you break it.
- **Run plan** starts one head per job in dependency order, grouped under the plan on the canvas. Running it again after adding jobs starts only the new ones.

**Jobs you drive yourself** ([Plan_Lanes_Plan.md](internal/Plan_Lanes_Plan.md)):
- **Run as:** a job's popover has **Head** (Hydra drives it) or **Lane** (you drive it in a terminal). A lane job's card says "Draft job · Lane".
- **Starting:** a lane job opens as a lane as soon as the jobs it depends on are done, named after the job, with its brief as the goal.
  - The lane starts from their work.
  - Its first prompt names the plan and the job.
  - The full brief, with what the jobs before it did, is in `.hydra-job/brief.md` in its worktree, which is never committed.
- **Finishing:** commit in the lane, then press **Mark job done** on its tile (or on its card's ⋯ on the canvas).
  - Hydra runs the gates, or reuses a passing run on the same commit.
  - It asks for an optional note for the next jobs, then hands the lane's commit on: the jobs after it start from there.
  - **Merge** finishes the job too.
  - The lane's agent can call **`hydra_job_ready`**, which asks you; it never marks the job itself.
  - Until a job after it has started, you can press **Mark job done again**.
- **Heads after a lane job** wait until it's done. Heads after heads start as they did before.
- **On the canvas:**
  - A running plan shows its progress: "2 of 4 done · waiting for you in Build API".
  - Each job is its head card, its lane card, or a small node saying what it waits for, why it was skipped, or that it's done.
  - A lane card opens its lane. Its ⋯ has **Open lane**, **Mark job done**, **Cancel job** and **Diff**.
- **Failures:** when a head fails, or a lane is closed before its job is done, the jobs after it are skipped and the plan is **Incomplete**.
  - **Retry failed jobs** starts them again, with a new lane for a lane job.
  - **Cancel job…** (in a lane's ⋯, or a job's ⋯ on the canvas) ends one job.
- **+ Job** works on a running plan too. The new job stays a draft you can edit until you press **Run plan**.
- **Limits and restarts:**
  - A plan lane that continues in the other agent stays under its plan.
  - A head that hit its limit holds the jobs after it until it goes on.
  - After Hydra restarts, a plan's lanes show Exited under the plan and nothing starts by itself. A lane job that was ready shows **Start lane**.

**Auto-dispatch to lanes** is a switch in the plan's header on the canvas, for a plan with lane jobs:
- **Settings:** **Lanes** at once (1–4, 2 by default), the **Agent** for its new lanes (a job's own provider or role still comes first), and **Tries** (1–5, 3 by default).
- **Starting:** each ready lane job starts as a lane when one of the plan's slots is free, as a lane job always starts (its base commit, brief and scope). It also starts after Hydra restarts: lanes that already exist are adopted first, so nothing starts twice. Nothing starts while agents are stopped.
- **Finishing:** when the lane's agent calls `hydra_job_ready`, Hydra runs the gates itself, as **Mark job done** does, with no dialogs.
  - If they pass, the job is done with the lane's commit and its evidence status, and the next job takes the slot.
  - If they fail, Hydra types the failures into that lane, as **Send to lane** does, and presses Enter. That counts a try; the tile says "Auto-dispatched · attempt 2 of 3".
  - When the tries run out, the job fails ("Gates failed 3 times: …") and the jobs after it are skipped. **Retry failed jobs** starts over with every try.
- **You stay in charge:** you can still type in the lane, **Mark job done**, or **Cancel job**. What you do wins over a check in progress. Turning the switch off leaves running lanes alone; ready lane jobs then wait for **Start lane**.

**Scope contracts.** A plan the lead creates or amends is refused if two of its jobs would run at the same time (neither depends on the other, even through others) and their `write_scope`s share a path: the error names both jobs and the path, and asks for a dependency between them or a narrower scope. Only checked between jobs that both name a `write_scope` — canvas-drafted jobs, which don't set one yet, are never refused this way.

**Conflict prediction between heads.** Every 30 seconds, Hydra checks every pair of running heads with `git merge-tree` — the same check lanes already use against each other, extended to heads. It snapshots each head's current work (committed and uncommitted) without touching its files, and predicts whether two heads would conflict if both merged now. A predicted conflict shows as a red dashed line between the two heads on the Agents canvas, and each head's card names the other. Like lane conflict prediction, this only warns; it never stops a head or refuses a merge. It works across chats and plans: two unrelated heads working on the same file are flagged even if nothing connects them. A plan's head is also checked against its plan's integration branch, where it has to land: work that landed since it started can conflict with it before it's done. Its card then says "Conflicts with hydra/plan-<id>", and `hydra_plan_get`/`hydra_plan_wait` (and `hydra_get_head`) show `integration_conflict` with the files, as well as `predicted_conflicts` with other heads.

A loose `hydra_start_head` call never refuses for scope: instead, if the new head's scope overlaps a running head it doesn't depend on, the result names that head and the shared path, so the lead can add a dependency or narrow the scope itself.

### Lanes

Heads are Hydra's agents. **Lanes** are yours: each lane is a real `claude` or `codex` terminal, signed in with your own account, working in its own git worktree and branch ([Lanes_And_Planner_Plan.md](internal/Lanes_And_Planner_Plan.md), section 1). The Agents tab has two views, **Canvas | Lanes**.

- **New lane** (in the Lanes view, the Hydra panel's **+**, or **Hydra: New Lane**):
  - Give it a name, pick Claude Code or Codex, and optionally a goal.
  - With a goal, the agent starts on it straight away, already told what the other lanes are doing.
  - The first run asks you to trust the new folder; that's the CLI's own prompt.
- **The grid:**
  - Fixed-size tiles, two or three to a row, scrolling for more.
  - Click a tile to type into it.
  - Each tile shows its branch, files changed, and warnings: **Conflicts with Lane 3 · src/cart.ts**, **Conflicts with main**, **3 behind main**, **Merges cleanly**.
- **Coordination:**
  - Hydra predicts conflicts between lanes, and with main, every 10 seconds using `git merge-tree`. It never touches a lane's files and makes no model calls.
  - A lane's agent can call **`hydra_lanes`** to see the other lanes' goals, files and conflicts, and it can start heads, which appear under that lane on the canvas.
  - Hydra only warns; it never blocks a lane.
- **Finishing a lane:**
  - **Merge** merges the lane into the branch your folder is on, after a confirmation that says whether it merges cleanly. It refuses, with the reason, if there's nothing to merge, uncommitted work (**⋯ → Commit…** first), the wrong branch checked out, or a conflict with main.
  - **⋯ → Update from main** brings main into the lane; conflicts are left for you, or the lane's agent, to resolve in the lane.
  - **⋯ → Open PR** pushes the branch and opens GitHub's compare page.
- **Close lane:**
  - A merged lane closes quietly.
  - Otherwise, choose **Keep branch** (uncommitted work is committed as "WIP") or **Delete everything**.
  - Hydra only ever removes its own lane worktrees, and removes any links inside first, so it never deletes through a junction.
- **Gates on Merge:** with `"lanes": "onMerge"` (the default), **Merge** runs this project's gates on the lane first.
  - If they pass, the confirmation says so.
  - If they fail, you choose between **Send to lane** (the default), **Merge anyway** or **Cancel**. **Send to lane** types the failures into the lane's input without pressing Enter.
  - **⋯ → Run gates** runs them at any time, and **⋯ → View evidence** shows the results.
- **Preview app**: **⋯ → Preview app** starts the project's dev server in that lane's worktree, on a free port, with the lane's own environment (a lane is your terminal), then opens the page in VS Code's Simple Browser. The command comes from the project's screenshots gate, or `.hydra/preview.json`, or is asked for once and saved there. The tile shows "Preview on :&lt;port&gt;" with **Stop**. It stops with the lane: on **Stop**, on **Close lane**, on **Stop All Agents**, and when the window closes. Two lanes preview on different ports from their own worktrees, and closing one leaves the other running.
- **Usage limits:** when the agent in a lane hits its limit, the tile shows it, with **Continue in Codex** (or Claude), **View handoff** and **Wait**, and a notification names the lane.
  - **Continue** restarts the same lane with the other agent, in the same worktree, with a handoff. Uncommitted work is untouched.
  - **⋯ → Switch to…** does the same whenever you like.
  - With `hydra.lanes.onLimit: "switch"`, the lane switches by itself after a 10-second countdown you can cancel.
- **Restarting Hydra** ends the lanes' terminal sessions but keeps their worktrees. **Resume** continues the conversation (`claude --continue`, `codex resume --last`); **Start fresh** begins a new one. If the CLI never began a conversation in that worktree (it stopped at its own update or folder-trust prompt, or you quit before sending anything), Resume checks first and starts fresh instead, with a note on the tile: "No earlier conversation to resume, so the lane started fresh."
- **On the canvas:** every open lane is a node, heads it started grow from it, and lanes that would conflict are joined by a red dashed line. Click a lane to jump to its terminal.

The **Hydra panel** (the Hydra icon in the activity bar) lists your lanes, running heads and plans, with **New lane**, **New plan** and **Open Agent Manager** at the top. A plan shows its progress ("Running · 2 of 4 done · 1 lane waiting"), and a plan lane names its plan.

In the Lanes view, running lanes come first. Exited lanes are compact rows with Resume, Start fresh, Merge and Close lane; **Show terminal** opens the full tile.

New to all this? **Hydra: Learn Heads, Lanes, Plans and Gates** opens a short walkthrough, and the empty Agents and Lanes views link to it. It never opens by itself, and neither does the editor's Welcome page when an extension such as Claude Code or Codex is installed.

### All projects

**Hydra: Show All Projects** lists every open Hydra window, across every project, read-only. Each window writes a small summary of its own heads, lanes, plans and evidence beside its discovery record, at most once a second plus a heartbeat every 60 seconds, in Hydra's global storage — never in a repository, so a head can't reach it. A window whose process has exited shows as "Closed"; one whose heartbeat is over three minutes old shows as "Not responding". Selecting a running project opens its folder, which focuses that window if it's already open. There is no action here that changes another window's jobs.

## Hydra's notifications

In the Hydra app, Hydra's own messages (a lane is ready, a job failed its gates, an update is available, a download's progress) show as Hydra-styled cards in the bottom-right corner, over whatever is open, instead of the editor's standard notifications. Information fades after 8 seconds and warnings after 14; hovering over a card holds it. Errors, cards with buttons and cards showing progress stay until you answer or close them (the × or Escape). At most five show at once. Confirmations that need an answer before anything happens (merging, closing a lane) are still the editor's own dialogs. Installing an update asks on a Hydra card of its own, which waits for **Install and restart** or **Not now**. Outside the Hydra app, the same messages use the editor's notifications. Security notes are in [THREAT_MODEL.md](THREAT_MODEL.md) (HSEC-68, HR-20).

## Folders you haven't trusted

Hydra runs agents and commands in your folder, so it switches itself off in a folder you haven't trusted yet (Restricted Mode): no heads, lanes or plans, and no Agent Manager / Editor switch, until you choose **Trust**. Hydra's look (its themes and default layout) stays on in the meantime, so the trust prompt and the folder behind it already look like Hydra.
## Packs

A **pack** bundles what one kind of work needs: **roles** for lanes, heads and plan jobs, **gates**, **MCP servers** and **skills** ([Packs_Plan.md](internal/Packs_Plan.md)).

- **Which packs exist:**
  - Hydra ships **Coding** (Builder, UI builder and Reviewer roles, a `code-review` gate, and Playwright for the UI builder) and **Research** (Researcher and Fact-checker, and a `fact-check` gate).
  - Your own packs are folders in `~/.hydra/packs` (the `hydra.packs.folder` setting). Hydra watches that folder when it exists, so adding or editing a pack there refreshes roles, the Packs page and Settings → Gates without pressing Reload.
  - A project can carry packs in `.hydra/packs/<id>/`.
- **Turning one on:**
  - **Hydra Settings → Packs → Turn on** first shows everything the pack would run: each command, each server and the roles that use it, each role's instructions, and each skill's files.
  - The button at the end of that review writes `.hydra/packs.json`, which you can commit.
  - Nothing from a pack runs before that.
  - A pack that isn't from Hydra says so, and is pinned to the files you reviewed: if any file changes, it stops until you review it again.
- **A teammate's `packs.json`:** Hydra asks once per project ("This project uses the Coding pack…"). Until you allow it on your machine, its gates show as **not run**.
- **Roles:**
  - Pick one in **New lane**, in a plan job's popover, or with `role` on `hydra_start_head`. A lead's instructions list the active ones.
  - A role sets the agent's instructions, its skills and MCP servers, and, for heads, web access.
  - Claude lanes get it with `--append-system-prompt-file` and `--plugin-dir`; Codex gets developer instructions. Everything is passed per process, and your Claude Code and Codex settings are never changed.
  - A Reviewer or Fact-checker may finish without changing anything; its summary is the result.
- **Gates:**
  - A pack's gates join `gates.json`. Your own gate with the same id wins.
  - **Skip in this project** turns one off.
  - Chips say "From the Coding pack". Settings → Gates lists them under **From packs**.
- **Windows:** a server command such as `npx` runs through `cmd.exe`, as Claude Code's docs advise.
- **Pinned downloads:** a server run by `npx`, `bunx` or `pnpx` must name an exact version, like `name@1.2.3`. A pack with a range, a tag or a bare name doesn't load. A server may also pin `integrity`, npm's `sha512-…` hash. Before it first starts, Hydra checks that hash against the npm registry and leaves the server out if it differs, saying why; the rest of the role still starts. A match is remembered, so later starts don't ask again. The review panel shows the pin, and the Coding pack pins its Playwright server.

## Scripts and CI

A script or CI job on this machine can act as you against the Hydra window that owns its repository, with no prompt, through the `hydra` command.

### The `hydra` command

The app's `bin` folder already has `hydra` (and `hydra.cmd`), the launcher that opens the editor (`hydra .`). The installer's **Add to PATH** option, on by default, puts it on your `PATH`. Its first word decides what it does: `status`, `plan`, `heads`, `stop`, `resume`, `report` and `close` run the commands below; anything else opens the editor, as before. (To open a file literally named `status`, use `hydra ./status`.)

| Command | What it does |
| --- | --- |
| `hydra status` | The window that owns this folder, and how many heads (by state) and lanes it has. |
| `hydra heads` | This window's heads. |
| `hydra plan run <file>` | Runs a plan file (see below), checked first by the same code `hydra_plan_create` runs. `--unattended` runs it unattended (O7), with `--usd`, `--minutes` and `--max-jobs` for its budget, over the file's own `budget`. `--key` sets its idempotency key; otherwise the file's `idempotency_key` is used, and without one each run makes a new plan. |
| `hydra plan run <id>` | Runs a waiting plan the scripts made: a draft starts (when **Hydra Settings** says plans need approval), and an incomplete one retries its failed jobs, as **Retry failed jobs** does. |
| `hydra plan show <id>` | A plan's jobs, what needs attention, and its integration branch and gate. |
| `hydra plan wait <id>` | Waits until the plan has finished and its integration gate has a result for the branch as it is now. `--timeout <seconds>` (6 hours by default). Exits 0 **only** when the integration gate passed ("Passed required gates"). |
| `hydra plan cancel <id>` | Stops the plan's unfinished jobs (`--reason`). |
| `hydra stop` / `hydra resume` | **Stop All Agents** (`--reason`) and **Resume Agents**, without the confirmation. |
| `hydra report <id>` | The plan's report as Markdown: the same report an unattended plan writes when it ends. |
| `hydra close` | Closes the window that owns this folder. It refuses (exit 1, saying what is still working) while heads or lanes are running, or a plan is in progress or still landing (its integration queue or gate); `--force` closes it anyway, cutting that work short. The window answers first, then closes about a second and a half later, after checking again, unless forced, that no work started meanwhile. Like every `hydra` command, it is refused from a process running inside a head. `--reason` goes in the window's log and its audit log, which records every close. The benchmark closes the windows it opened with it ([Benchmark.md](Benchmark.md), "Closing the windows"). |

- **For scripts:** `--json` prints the raw result; a refusal prints `{"ok": false, "exit_code": <n>, "error": "…"}` as well as the message on stderr.
- **Exit codes:** 0 ok, 1 Hydra refused (including `plan wait` on a plan whose integration gate didn't pass, or a timeout), 2 usage (bad arguments, a missing or invalid plan file), 3 no Hydra window owns this folder (or it stopped answering).
- **A CI step** can run a plan and fail the build unless the combined work passed: `hydra plan run .hydra/plans/nightly.json --unattended --minutes 120 --json`, take `plan_id` from the output, then `hydra plan wait <id>`.
- **What it can't do:** it acts only through the `user` role below. It can't merge a plan into your branch (**Merge plan** stays on the canvas, or with a chat), and nothing a head or a lane does.
- **The benchmark** ([Benchmark.md](Benchmark.md)) is a real use of the command: a six-job plan run unattended against one agent alone, with the results published.
- **Where it looks for Hydra:** `HYDRA_HELPERS_DIR` when set; otherwise the Hydra app's own data (a portable install's `data` folder first), then VS Code's, for the extension on its own.

### Plan files

A plan can live in the repository as `.hydra/plans/<name>.json`, reviewed in a pull request like any other file and run again with `hydra plan run <name>`. It has exactly the fields of `hydra_plan_create`: `title`, `brief`, `jobs` (each with `key`, `title`, `brief`, `write_scope`, and optionally `depends_on`, `provider`, `role` and `rigor`), `run` and `budget`, with `idempotency_key` optional and `$schema` allowed. Hydra publishes its JSON schema (`schemas/hydra-plan.schema.json`, generated from `hydra_plan_create`'s own), and the editor uses it for completion and checking in any `.hydra/plans/*.json`. `hydra plan run` refuses a file that isn't valid before asking any Hydra: two independent jobs changing the same path, a dependency cycle, an unknown field, or an unattended run without a budget.

```json
{
  "title": "Checkout",
  "jobs": [
    { "key": "api", "title": "API", "brief": "Add the /orders endpoint.", "write_scope": ["src/api/"] },
    { "key": "ui", "title": "UI", "brief": "Show orders.", "write_scope": ["src/ui/"], "depends_on": ["api"] }
  ]
}
```

### The user role and the handshake

- **Which window answers:** the one whose folder holds the script's current folder, found through the same discovery file a lead's bridge uses (one window per repository).
- **The handshake file:** each window writes `<globalStorage>/helpers/handshakes/<pid>-<port>.json` when its heads start: the window's process id and endpoint port, the repository, and a `user` token Hydra mints for this file only (no endpoint hands one out). On Windows, Hydra cuts the file's access list to you alone with `icacls` (no inherited entries, not even SYSTEM or Administrators) before the token goes in. The file goes when the window closes; the token dies with the window either way.
- **What a reader refuses:** a file whose access list isn't owner-only, a malformed one, one whose Hydra process is gone (it's also removed), and one that doesn't match the live window it was looked up for.
- **What the `user` role may do:** the plan tools (`hydra_plan_create`, `_get`, `_wait`, `_amend`, `_cancel`, `_message`, `_run`, `_report`), but never `hydra_plan_merge` or `hydra_plan_integrate`, read heads (`hydra_list_heads`, `hydra_get_head`) and lanes (`hydra_lanes`), and stop and resume (`hydra_stop_all`, `hydra_resume`, the same as **Hydra: Stop All Agents** and **Resume Agents**, without the confirmation), and close the window (`hydra_close`, refused while work runs unless forced). Nothing a head or a lane does (`hydra_done`, `hydra_stuck`, `hydra_job_ready`), and none of a chat's own head actions.
- **Plans a script makes** belong to the `user` role as a whole: any script can read and change them, and no chat can. A chat's plans stay its own.
- **Refused from inside a head:** like a lead's token, the user token is refused when the calling process descends from one Hydra started for a head.

## Security

See [THREAT_MODEL.md](THREAT_MODEL.md) for what Hydra protects, from whom, its boundaries, every control below with the file and test that proves it, and the risks accepted rather than fixed today.

- **Local endpoint:** Hydra listens on `127.0.0.1` only, on a random port. Requests with a foreign `Host` or any `Origin` are refused, which blocks web pages. Oversized and flooding requests are refused too.
- **Tokens:** every caller has its own random token, and only its hash is kept. The token alone decides who is calling (a window's lead, or one head) and which actions it may use. A head can't use lead actions. Head tokens are revoked when the job ends. The presented token's digest is also compared against the stored caller's digest with `crypto.timingSafeEqual`, on top of the map lookup.
- **Gate floor:** a head's effective gates are recorded when it starts. At `hydra_done`, the gates that run are the start-of-run definition for every gate id the head already knew about, plus anything added to `.hydra/gates.json` since — so a head can't drop a gate or weaken its command mid-run, and Settings → Gates changes apply to heads started afterwards, never to one already running. If `.hydra/gates.json`, `checks.json` or `packs.json` changed while a head ran, its result says so.
- **Fenced review input:** the reviewer's prompt wraps the diff and the earlier gates' output and summaries in `<<<untrusted-<nonce>` … `>>>end-untrusted-<nonce>` markers, with a fresh random nonce per review, and says plainly that text between them is data, never instructions. The agent under review can't guess the nonce in advance, so it can't forge a closing marker and step back out of the fence.
- **Clean terminal input:** text Hydra types into a lane on your behalf (for example "Send to lane") has its control sequences stripped first — CSI and OSC sequences, bracketed-paste markers, other escape sequences, and C0/C1 control characters — so a head's gate output can't type ANSI or bracketed-paste sequences into your terminal. Your own keystrokes are never touched.
- **Git hardening:** every git call Hydra makes passes `-c core.fsmonitor=false`, so a `core.fsmonitor` a head or lane planted in the shared `.git` never runs. Hydra also fingerprints `.git`'s shared config, `config.worktree`, `info/attributes` and `hooks/*` (except `*.sample`) when a head or lane starts; a change refuses `hydra_done` (naming the file, counted as a failed check) and warns before a lane's Merge or Mark job done (naming the file, Cancel the default; `hydra.lanes.action` refuses outright).
- **The user token** (see "Scripts and CI") is the one Hydra token on disk: in a handshake file only you can read, refused once its window is gone, and refused from inside a head. It can't call a head's or a lane's tools.
- **No lead secret on disk.** The discovery file (port, pid, folders) contains no token. A lead's bridge asks Hydra for its token once, and Hydra first asks Windows which process opened the connection, then walks that process's parents (`src/core/leadVerification.ts`):
  - **Refused** if the chain passes through any process Hydra started for a head or a head's checks. A head, and anything it starts, can't act as the lead.
  - **Refused** if the chain doesn't reach this Hydra window. That covers a detached process trying to escape its head, and a CLI run outside Hydra; use the extensions or a terminal inside Hydra.
  - Windows reports the connection's owner, so a caller can't pretend to be another process. A parent created after its child (a reused PID) ends the chain.
  - The token then lives only in that bridge's memory.
  - Verified live: a head's check process asking for a lead token was refused with "it runs inside a Hydra head".
  - On other platforms this check isn't implemented yet, and lead connections are accepted.
- **Confined heads** (`src/core/confine.ts`):
  - A Claude head gets its own settings file: reads outside its worktree are blocked, whatever the spelling, and Read and Edit are denied on Hydra's data, the other worktrees, the lead's `.hydra` and `.git`, and `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.codex`, `~/.claude` and the like. Its role's pack copy stays readable.
  - Its Bash runs through Hydra's wrapper in Codex's Windows sandbox: only its worktree and its own TEMP are writable. Hydra checks the sandbox once per window; if the check fails, heads have no shell, say why, and Settings → Heads shows the reason. PowerShell is never given.
  - Heads and gate commands get a trimmed environment: system, locale, proxy and toolchain variables, the provider's own sign-in, and a role's variables. Other keys and tokens stay out.
  - A Codex head keeps `workspace-write`, with its own TEMP. Its reads aren't limited.
- **A head's gate commands** and its screenshots gate's app run in the same sandbox, with the network on, when the check passed. A lane's gates run as before.
- **Hydra's commits** in a head's worktree run with git hooks off, so a hook a head edited can't run as Hydra.
- **The Claude reviewer** loads only your user settings and no MCP servers, so hooks or servers a head wrote into its worktree don't run.
- **Lanes** get light limits: a Claude lane can't read or edit Hydra's data or the other worktrees. Otherwise it's your terminal, with your settings.
- **Logging:** every action, every accepted or refused lead connection, and every refused call (an unknown token, a tool the caller may not use, too large, too many) is logged to the Hydra output channel, never with a token.
- **Audit log:** every denial (an endpoint refusal, a refused lead connection, `hydra_done` refused for changed git settings or hooks, a failed sandbox self-test, a pack server refused by its integrity pin), approval ("Merge with these changes", "Mark done with these changes", "Merge anyway" after a failed gate, turning on a pack) and stop (a head cancelled, Stop all, Resume) is appended, redacted, as one JSON line to `<globalStorage>/audit/audit.jsonl`, rotated at 2 MB with one previous file kept. **Hydra: Open Audit Log** opens a read-only snapshot of it.

## Supported versions

Hydra runs Claude Code 2.1.x from 2.1.270 and Codex 0.154.x from 0.154.0 (`src/core/cliVersions.ts`). The first time Hydra sees a new binary it runs a short real self-check (`src/core/cliSelfCheck.ts`) and remembers the result for that exact binary.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| "Hydra isn't open for this folder" | No Hydra window has the chat's folder open | Open the folder in Hydra |
| "Hydra heads are not set up for this CLI" | The agent isn't connected | Connect it in Hydra Settings → Connectors |
| "Hydra refused this lead: it was not started from this Hydra window" | The CLI runs outside Hydra (for example Windows Terminal) | Use the Claude Code or Codex extension, or a terminal inside Hydra |
| After **Install and restart**, Hydra closes but the update never installs (`%TEMP%\hydra-update.log` ends at "Waiting for Hydra … to close") | Before 0.27, the update waited for every program running Hydra.exe, including Hydra's MCP server that Claude Code or Codex keeps running | Update to 0.27 or later, which stops those bridges once Hydra itself has closed (their apps start them again). For an older version, quit Claude Code and Codex, or wait: the helper gives up after 10 minutes and Hydra offers the update again |
| A head "exited without finishing" | Its CLI failed to start or crashed | **Open log** on the dashboard |
| A head says "Your shell is off" | Codex's Windows sandbox isn't available: Codex or Git Bash is missing, or the sandbox check failed | Settings → Heads gives the reason. Install Codex (and run it once so its sandbox is set up) or Git for Windows, then reload the window |
| Claude reports failing SessionStart hooks | A plugin hook fails (for example claude-mem without Bun or its dependencies) | Press Connect on Claude again; it sets up Bun and claude-mem. Hydra records hook failures and carries on. |
| A head takes a long time between finishing and "checking" | `hydra_done` runs several git commands and loads gates before the head can be checked | Hydra's log names how long each step took, for example `hydra_done → checking in 12.3s: status 0.4s, commit 9.8s, rev-parse 0.2s, gates 0.1s, tamper 0.0s, diff 0.3s, gitmeta 1.5s`; a step that throws is marked with `!`. Read-only steps (status, rev-parse, diff) are stopped after a few minutes with a clear error instead of hanging; a commit is never killed this way, since that could leave a lock file behind |

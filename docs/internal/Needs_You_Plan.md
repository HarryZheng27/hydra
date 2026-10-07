# Needs you: telling the user only what needs them

Status: **proposed** (2026-10-07). Prompted by a review of Agentbox (github.com/savannahfeder/agentbox), an inbox over many headless Claude Code and Codex agents. Agentbox is GPL-3.0-or-later and Hydra is MIT, so this plan takes ideas only: no code and no prompt text from it. Build every part of it from Hydra's own code.

## The problem, from Hydra's own behaviour

Hydra is good at keeping agents honest (gates, cross-agent review, write scopes, the integration branch). It is weak at telling you when you're needed:

1. **Nothing reaches you outside the window.** There is no OS notification anywhere (no Electron `Notification`, badge or flashFrame in `app/src/main`). A head that blocks, fails or finishes only updates the canvas, the tree and the chat cards. In-window toasts fade after 8 seconds.
2. **A head's question is answered by Hydra because nobody was told it was asked.** `hydra_stuck` waits 20 minutes and then answers itself ("When nobody answers", `docs/Heads.md`). That fallback exists for good reasons, but nothing tells you during those 20 minutes.
3. **Lanes can't say they're waiting.** A lane is `running | exited | merged | closed` (`src/core/lanes.ts:15`). A Claude Code or Codex terminal sitting at a prompt or a permission question looks the same as one hard at work. The Lanes grid is a wall of terminals you have to poll.
4. **The signals exist but are scattered.**
   - The app's chat status (`working | needs | unread`, `app/src/renderer/chatStatus.ts`) is shown on the sidebar but doesn't sort it.
   - A plan's `needs_attention` goes to the lead only.
   - The "Needs you" section exists only in an unattended plan's report.
   - Show All Projects counts blocked heads, read-only.
5. **A head's result has no headline.** `hydra_done` takes one free-text `summary` of up to 8,000 characters (`src/core/helperTools.ts:174`), and the canvas doesn't show it. `hydra_stuck` takes a free-text question with no options (`helperTools.ts:176`).

## What we are not building

**An inbox of heads.** Agentbox's unit is one task, one agent, one row, with you reviewing every row. Hydra's unit is the chat: the lead is told to delegate behind the scenes and report only the combined result (`helperTools.ts:264`). An inbox listing every head would undo that design and compete with the lead for your attention.

So this plan lists **decisions only you can make**, from any source (chats, plans, lanes, and heads only when no lead is going to answer them). It does not list agents.

## Rules

1. **Decisions, not agents.** An item appears only when something waits on you and no agent is about to handle it. A head blocked while its lead is in `hydra_wait_for_heads` (`HelperService.waiters`, `src/core/helperService.ts:266`) is the lead's to answer, not yours.
2. **Derived, not stored.** Every item is computed from state Hydra already keeps (jobs, plans, lanes, chat status). No new source of truth, and no new state machine.
3. **Quiet unless you're away.** No banner while you're at the window. One banner per stretch away, plus at most one more for an item on a clock.
4. **Only you set the order.** Nothing an agent writes moves an item up the list.
5. **Limits are enforced in code.** A length cap is refused by the tool with a reason, not merely asked for in a prompt. That is how Hydra already treats write scopes.

## Phase 1: Tell me when I'm away (app first)

**Built for the app** (`src/core/needsYou.ts` derives the items and decides when to banner; `app/src/main/needsYouBanners.ts` drives the OS banner; the setting is under Notifications in the app's Settings). Two details the plan left open: a banner waits 60 seconds after an item appears, so a lead about to answer a head's question never triggers one (a lead is only "waiting" while it is inside `hydra_wait_for_heads` or `hydra_plan_wait`, which return the moment a head asks); and a chat that finished while you were at the window isn't counted, nor is one you came back to. The IDE banner is still to do.

- **When:** an item enters the "needs you" set (see Phase 5 for the full list; at first: a chat's `needs` or `unread`, a head blocked with no lead waiting, a plan ready to merge or stopped, an unattended report, a usage-limit offer). It fires only when the window isn't focused, or the machine has been idle 5 minutes or more (`powerMonitor.getSystemIdleTime()`).
  - A focused window alone isn't enough: you may have walked away from it.
  - Being idle alone isn't enough either: you may be reading something else.
- **How often:**
  - One banner per stretch away, in words that stay true however many items arrive after it: "Hydra needs you in <project>", never a count.
  - At most one more if an item on a clock arrives later in the same stretch. That covers a blocked head (Hydra answers it itself at 20 minutes) and a usage-limit offer.
  - Focusing the window resets the stretch.
- **What it says:**
  - The project and the chat or plan title only, through `redact()` and cut at a word boundary to about 110 characters.
  - Never a question's text or a summary, because banners show on a locked screen. A setting can turn the detail on.
  - Clicking the banner focuses the window and opens the item.
- **Where:** `app/src/main` (next to `hostUi.notice`), driven by the same events as `headsChanged` and the chat status updates. Add a setting, `notifications.whenAway` (on by default), and a THREAT_MODEL entry for what a banner may contain.
- **The IDE:** the extension host has no OS notification API. That needs a workbench contribution in the fork (`desktop/workbench`), so it's a separate step after the app.
- **Tests:**
  - No banner while focused and active.
  - One banner for three arrivals while away.
  - A second banner for a blocked head after a finished chat, and never a third.
  - The banner text is redacted and contains no question text.

## Phase 2: A headline and options on head reports

- **`hydra_done`:** add a required `headline`: one plain sentence of up to 110 characters, saying what happened and what, if anything, is left to decide.
  - Refuse a missing or longer one with the reason. This doesn't spend a gate attempt.
  - Return it from `hydra_get_head` and `hydra_list_heads`.
  - Show it on the canvas card's detail line once the head is done, in the heads list, in the app's HeadCard header and in each job of a plan report.
  - `summary` stays as it is, for the detail.
- **`hydra_stuck`:** add optional `options`: one to four, each up to 110 characters, exactly one marked `recommended`, each something the head could act on without asking again.
  - **For you:** **Answer question…** on the canvas shows them as buttons, picked with 1 to 4, with a free-text box still there.
  - **For the lead:** it gets them in `hydra_wait_for_heads`, and `hydra_reply_to_head` accepts `option: n`.
  - **When nobody answers** (20 minutes, or at once in an unattended plan), Hydra answers with the recommended option ("No answer came within 20m. Go with your recommended option: …") instead of "decide within your brief".
  - The audit entry, `auto_answered` and the report then name the exact choice. Without options, it behaves as it does today.
- **The head's brief and `helperInstructions`:** one short paragraph on writing the headline and options, in Hydra's own words.
- **Tests:**
  - A 111-character headline is refused.
  - Options without exactly one recommended are refused.
  - An auto-answer picks the recommended option and records it.
  - A late reply after an auto-answer is still refused, as today.

## Phase 3: Edited tests are evidence

Hydra's promise is that no agent grades its own work. But a head can change the tests that grade it. The tamper note (`helperService.ts:577`) covers `.hydra/gates.json`, `checks.json` and `packs.json`, not the tests a command gate runs. The review prompt's rubric (`src/core/gates/review.ts`, around line 197) never asks about it. Under `standard` rigor, a plan job gets no review of its own at all.

- **What it flags:** at `hydra_done` and a lane's Merge, list the files that existed at the base commit, match the project's test patterns, and were changed or deleted.
  - Default patterns are `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**` and `**/__tests__/**`, and `tests` in `.hydra/gates.json` replaces them.
  - New test files aren't flagged: adding tests is normal.
- **What happens:**
  - The list goes on the result as a note ("Changed existing tests: …") next to the tamper note, and shows in View evidence.
  - The review gate's prompt gets it as a fact to check: whether the change weakens a test so that it passes.
  - For a plan, it goes to the integration gate's combined review.
  - It fails nothing on its own: it's a flag, not a gate.
- **Tests:**
  - A changed `foo.test.ts` is flagged and a new one isn't.
  - Custom patterns replace the defaults.
  - The review prompt includes the list only when it's non-empty.

## Phase 4: Lanes say when they're waiting

- **Claude Code:** extend the hook Hydra already installs, reversibly and at user level, for usage limits (`src/core/claudeLimitHook.ts`, `StopFailure`/`rate_limit`) with `Stop` and `Notification` groups. Use the same exec-form script and the same byte-exact removal.
  - The script drops an event file only when the hook's `cwd` is inside Hydra's worktree root. For any other Claude Code session on the machine it exits at once and records nothing.
  - Heads run with `disableAllHooks`, so they're unaffected.
  - `Stop` fires on every turn of every Claude Code session on the machine, so the script must stay cheap and always exit 0.
- **Codex:** the marked `config.toml` block Hydra already writes can carry a turn-complete notifier, or the pinned Codex version's hooks file can take a hook.
  - If you already have your own `notify` set, Hydra must not replace it. That lane falls back to "no signal" rather than guessing from terminal output.
- **The lane gets `attention`:** `waiting` (a permission or input prompt) or `turn-ended`.
  - It's cleared when you type into the lane's terminal, or when the agent's output resumes.
  - The tile shows **Waiting for you** or **Finished its turn**.
  - The Lanes view sorts waiting lanes first. It already puts running lanes first.
- **Status (2026-10-07):** built on `feat/needs-you-lane-attention`. The hook input fields were checked against Claude Code's published hooks reference and the Codex config reference, not against a live session: a live run needs a signed-in copy of `.credentials.json` / `auth.json` in the isolated config folder, which was not done. Still to check live by hand: that Claude Code 2.1.282 sends `Notification` with `notification_type: permission_prompt` in a lane, and that Codex 0.160 runs `notify` with the lane's environment (`HYDRA_LANE_ID`) and cwd. Codex's `notify` is a top-level key, so it is its own marked block at the top of `config.toml`, not part of the appended block.
- **Verify first:** on the pinned Claude Code and Codex versions, run the existing live acceptance protocol to confirm the hook input fields (`cwd`, `session_id`, `hook_event_name`, the notification's kind) before building on them.
- **Tests:**
  - An event from a lane's worktree sets `waiting`.
  - An event from any other folder is ignored by the script.
  - Typing in the lane clears it.
  - Installing and removing the hooks leaves `settings.json` byte for byte as it was, including alongside your own hooks.

## Phase 5: The Needs you list

One list, derived from existing state, of everything waiting on you.

| Item | Comes from | Shows | Primary action (E) |
| --- | --- | --- | --- |
| A head's question, with no lead waiting | job `blocked`, `HelperService.waiters` empty for its lead | Question, options, time left before Hydra answers | Pick 1–4, or R to reply |
| A usage-limit offer | `src/host/limitOffer.ts` | Provider, reset time | Continue in the other provider |
| A chat waiting on you | chat status `needs` | Approval, question or plan | Open the chat |
| A plan ready to merge | integration gate passed | Gate label, branch | Merge plan (with the existing confirmation) |
| A plan stopped | `needs_attention`, with no lead in `hydra_plan_wait` | Failed jobs, stopped landing queue | Retry failed jobs |
| A lane's gates failed on Merge | `controller.ts`, Merge anyway | Failed gates | Send to lane |
| A lane waiting or finished its turn | Phase 4 | Lane name, goal | Open the lane |
| An unattended plan's report | `writePlanReport` (`controller.ts`) | Its "Needs you" lines | Open the report |
| A chat that finished while you were away | chat status `unread` | Chat title | Open the chat |
| A finished head nobody merged | the Finished tray | Headline, evidence label | Open diff |

- **Order:**
  - First, items on a clock: a head's question, then a usage-limit offer.
  - Then decisions that unblock work: a chat waiting, a plan to merge, a stopped plan, failed lane gates.
  - Then things to read.
  - Oldest first within a group.
  - Nothing an agent wrote changes the order.
- **Keys:**
  - J/K or the arrows move; Enter opens.
  - 1–4 picks an option; R replies; E runs the primary action.
  - L puts an item off until a time you choose. That's stored locally and never changes the work itself.
  - Z undoes the last put-off.
  - Anything Hydra confirms today (merging, Merge anyway, closing a lane) still asks first. A single key never merges.
- **Where:**
  - **App:** a **Needs you** group at the top of the sidebar, above the projects (the sidebar already has chat status), and a **Needs you** tab beside Canvas and Lanes in the Agents view. That tab opens by default when it has items.
  - **IDE:** the same tab in the Agent Manager, and a count in the status bar item.
  - **Empty state:** "Nothing needs you."
- **Tests:**
  - Each kind of item appears and leaves on the right transition.
  - A blocked head whose lead is waiting doesn't appear.
  - The order holds with mixed items.
  - Put-off items come back at their time.
  - The primary actions go through the same controller paths, and confirmations, as the canvas.

## Later, once the above has shipped

- **Send a finished head back.**
  - **What:** a done head that isn't merged, with no lead waiting on it, can be sent back with your note. It restarts in the same worktree and branch, with "## Sent back" added to its brief, the way **Continue in** already does after a usage limit.
  - **What it changes:** `done` is terminal today (`src/core/jobs.ts`), so this is a deliberate change to the transition table. The old evidence is marked as being for an older commit.
- **Variants: several directions, pick one from screenshots.**
  - **What:** a plan group whose jobs are alternatives, not parts. They share a brief and a write scope, and each gets a different direction.
  - Each runs the screenshots gate. The Needs you item shows the screenshots side by side. Picking one lands it; the others are cancelled with their branches kept.
  - **What it needs:** an exception to the "two independent jobs changing the same path" refusal, for variant groups only.
  - **Cost:** it costs N times the tokens, so it's opt-in each time.
  - Agentbox does this with images the agent makes itself. Hydra's screenshots come from a real browser running the real app, which is stronger.
- **Heads that survive a restart.**
  - **What:** a loose head (not in a plan) is requeued in its worktree with a "## Restarted" note, as a plan's blocked head already is (`helperService.ts:291-310`), instead of failing.
  - **Later:** resume the provider's own session (`claude --resume`, or `codex exec resume`, which Hydra already uses for nudges) so the head keeps its context.
- **Gate admission.**
  - **What:** if measured memory pressure shows overlapping gates (dev servers plus headless browsers plus test runs) are the problem, add a semaphore in Hydra's own gate runner.
  - **Why it's cheap:** Hydra runs the gates itself, so it needs no hooks.
  - **Not before measuring:** today the only measured memory note is the window cost in `docs/Benchmark.md`.

## Considered and not taken

- **Live approval cards for heads' tool permissions.**
  - Heads run `dontAsk` inside their worktree on purpose.
  - Routing permissions to you brings back the interruptions this plan is meant to cut, and holds a slot while it waits.
  - Hydra fixed denied command shapes with guidance instead.
- **Priority tags, project rank and preemption.**
  - The cap is 3 per window, heads mostly come from one lead, and there's no cross-window slot pool. So there's nothing to order yet.
  - Revisit if a shared pool comes back.
- **A dispatcher for a pasted list of tasks.** The lead already splits work, with write scopes and dependencies.
- **A ship queue.** Plans already land one at a time on an integration branch, with seam checks and fix rounds.
- **Repeating tasks that finish quietly.**
  - Plan files plus `hydra plan run` in a scheduler or CI cover the repeating part.
  - If needed later: an unattended report with nothing under "Needs you" doesn't open a tab.

## Open questions

1. When a head asks while its lead is waiting, and the lead's turn then ends without answering, should the item appear at once or after a grace period? Proposed: at once, since the 20-minute clock is already running.
2. Should the Needs you tab replace the canvas as the Agents view's default when it has items? Proposed: yes. Then measure how often the canvas is opened, and how often anything is done from it.
3. Do banners include question text by default? Proposed: no.

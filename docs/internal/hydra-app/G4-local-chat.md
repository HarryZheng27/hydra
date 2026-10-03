# G4: Local chat with Claude and Codex

**Goal:** Nico can use the app daily as a chat client for Claude Code and Codex in a local folder: streaming, approvals, questions, stop, resume, and a diff review. Hydra's orchestration comes in G5.

**Needs:** G1 (decisions, fixtures, live checks) and G3. **Runs on:** Windows; signed-in CLIs only for the live checks.

## Shape
- **Shared logic in `src/core/chat/`**, host-agnostic and tested by root `npm test`:
  - `events.ts`: one `ChatEvent` union: text delta, thinking, tool call, tool result, file change, approval request, question, plan, usage, error, done.
  - `claude.ts` and `codex.ts`: the adapters, built from G1's decisions and the prior art at `f7c56d1^`.
  - `session.ts`: lifecycle, the turn queue, stop, the idle policy from G1.
  - `store.ts`: an append-only JSONL log per chat plus an index, written with `src/core/atomicFile.ts`, behind the user-only access list `src/core/userHandshake.ts` applies. It keeps the provider's session or thread id for resume and never parses provider transcripts.
- **Stand-in CLIs** in `tests/fixtures/app/standins/` replay G1's fixtures. CI never runs a real provider.
- **UI in `app/src/renderer/`:** chat pane, composer, approval and question cards, review pane.
- **A chat is the user's own agent,** like the official extensions. Head confinement doesn't apply to it; it runs with the CLI's own permissions and sandbox. Say so in THREAT_MODEL.

## Milestones (one PR each, in order)
1. **Core and Claude:** `events.ts`, `store.ts`, `session.ts`, `claude.ts`, the Claude stand-in, and tests for every Claude fixture scenario.
2. **Claude in the app:**
   - **Chat pane:** streamed markdown with no raw HTML and sanitized links, collapsible tool and thinking blocks.
   - **Composer:** model, effort, and permission mode. Default, accept edits and plan are allowed; bypass is excluded in v1.
   - **Controls:** approval cards drawn only from structured requests, and Stop.
   - **Folder trust:** a prompt before the first chat in a folder. It states that the project's own hooks and MCP servers will run, and no chat starts without it.
   - **Chat list:** chats grouped by project, kept across restarts.
3. **Codex:** `codex.ts`, its stand-in and tests, and the UI parity: approval kinds, model list, effort, and sandbox. Read-only and workspace-write are allowed; full access is excluded in v1.
4. **The rest of the conversation:**
   - **Questions and plan approval** use G1's chosen route.
   - **Images** in the composer.
   - **Slash commands** pass through.
   - **Open in terminal** runs the CLI's interactive resume in a console, for anything the adapter can't render.
5. **Review and polish:**
   - **Review pane:** read-only Monaco diff of the working tree against HEAD, plus Open in editor.
   - **Usage and cost** per turn, as the provider reports them.
   - **Clear errors:** a missing CLI sends you to onboarding. A usage limit shows a message, and G5 adds the handoff. Malformed output stops safely.
   - **Live checks:** extend `scripts/app-live/` to run through the adapters.

## Local checks per PR
Root `npm run check` and `npm test`; `npm --prefix app run check`, `test`, `build` and `smoke`.

## Acceptance
- [x] Every G1 fixture scenario passes through its adapter: text, tools, approval allow, deny and edit, interrupt, resume. Malformed output stops safely, and an unknown request is denied and logged.
- [x] App smoke with stand-ins, for both providers: new chat, stream, approve, deny, stop, restart the app, resume, and the review pane shows the diff.
- [x] A test proves HTML, scripts and `javascript:` links in model output render inert.
- [x] A test proves approval-looking text in a reply renders as text, never as a card.
- [x] A test proves no chat starts in an untrusted folder.
- [x] On Windows, a test checks that chat logs are readable only by the user.
- [x] Live checks pass for both providers on Nico's machine, with evidence in the Result.
- [x] THREAT_MODEL entries exist for chat logs, sanitization, approval routing, trust, and the chat's own permissions.
- [ ] Last step: ask Nico to do one real task with each provider. Fix what he finds, or list it as follow-ups in the Result.

## Result (2026-10-03)

Five PRs, one per milestone: [#302](https://github.com/ndunl075/hydra/pull/302) (core and Claude), [#304](https://github.com/ndunl075/hydra/pull/304) (Claude in the app), [#305](https://github.com/ndunl075/hydra/pull/305) (Codex), [#306](https://github.com/ndunl075/hydra/pull/306) (the rest of the conversation) and PR_M5 (review and polish). Each had an independent read-only review in a fresh Claude session, and #304's and PR_M5's fixes had a second, focused review. The findings and fixes are in each PR body. Every blocking and high finding was fixed before merge. There were two blocking ones:
- Stop didn't stop a running Codex command;
- Open in editor could hand a file name containing `&` to an editor's `.cmd` launcher, which cmd.exe would read as a command.

**What exists now:**
- **`src/core/chat/`** (host-agnostic, root `npm test`):
  - `events.ts`: the `ChatEvent` model.
  - `claude.ts`: route A. `claude -p`, stream-json, `--permission-prompt-tool stdio`.
  - `codex.ts`: `codex app-server`, JSON-RPC. Threads are read-only, approvals go to the user, and the thread's echo is checked.
  - `session.ts`: process per chat, turn queue, Stop, idle timeout and resume.
  - `store.ts`: append-only logs plus an index, every file owner-only before it's written, positions for merging.
  - `launch.ts`: hidden spawn and process-tree kill.
- **Stand-in:** `tests/fixtures/app/standins/replay.mjs` replays G1's recordings in lockstep. It checks each host line's kind, approval decision and input, user content blocks, and Codex's thread, sandbox, reviewer and turn parameters.
- **The app (`app/`):**
  - **Chat pane:** sanitized markdown, tool and thinking blocks, approval, question and plan cards, Stop, usage and cost per turn.
  - **Composer:** model, effort and mode; Codex's own model list; images.
  - **Folder trust,** confirmed in main's own dialog.
  - **Chats by project,** kept across restarts.
  - **Open in terminal.**
  - **Review pane:** Monaco's read-only diff of the chat folder.
  - **Clear errors.**
- **Live checks:** `scripts/app-live/chat.mjs` drives the real CLIs through the same `ChatSession` and adapters.

**Evidence for each acceptance box:**
1. **Fixture scenarios:**
   - Claude (`tests/chatClaude.test.ts`, 12 tests): every route-A recording runs through `ClaudeAdapter` and `ChatSession`:
     - three turns;
     - approvals: allow, deny, allow with an edited input;
     - a question, and a plan denied then approved;
     - interrupt mid-tool and mid-text;
     - kill and `--resume`;
     - an image;
     - slash commands and skills;
     - `/model`, `/effort` and `set_model`;
     - a project with its own hooks and MCP servers.
   - Codex (`tests/chatCodex.test.ts`, 11 tests): every recording with turns:
     - turn notifications;
     - command approvals: decline, accept, accept for the session;
     - file-change approvals;
     - interrupt;
     - resume after restart;
     - images;
     - an untrusted project's config;
     - effort per turn;
     - the model list.
   - Malformed output stops safely (`'Claude: malformed output stops the chat safely, and an unknown request is denied and logged'`, `'malformed output stops safely: the process ends and the turn fails, nothing retried'`), and an unknown request is denied and logged for both providers.
   - Not replayed, because they document routes G1 rejected: `headless-defaults`, `route-b-stub-mcp`, and the allowlist probe in part 1 of `untrusted-hooks-mcp`.
2. **App smoke** (`npm --prefix app run smoke`, 20 checks, all hidden). Each provider's stand-in session is stitched from G1's real recorded turns:
   - Claude: trust, stream, allow Bash, deny Write, Stop mid-text.
   - Codex: deny, allow, Stop mid-command.
   - Then the app quits (flushing the store), restarts, and resumes each chat. Claude resumes with `--resume <id>`, Codex in a new app-server.
   - Open in terminal is recorded with the right resume command.
   - The review pane lists the changed files and renders Monaco's diff, read-only, with no CSP violation.
   - The App workflow ran it on every PR (#302's core has no app part).
3. **HTML, scripts and `javascript:` links inert:** `'HTML, scripts and javascript: links in model output render inert'`, `'hostile markdown can't stall the page'` (`app/tests/chat.test.ts`).
4. **Approval-looking text stays text:** `'approval-looking text in a reply renders as text, never as a card'` (`app/tests/chat.test.ts`), `'Claude: text that looks like an approval is only text; requests come only from control_request'` (`tests/chatClaude.test.ts`) and `'Codex: other server requests are refused, and approval-looking text is only text'` (`tests/chatCodex.test.ts`).
5. **No chat in an untrusted folder:** `'no chat starts in an untrusted folder'` and `'two quick messages share one session; every message checks trust; a removed folder's chats stop'` (`app/tests/chat.test.ts`).
6. **Chat logs readable only by the user (Windows):** `'on Windows, chat logs and the index are readable only by the user'` (`tests/chatStore.test.ts`), using `icacls` through `ownerOnlyProblem`.
7. **Live checks** on Nico's machine (Windows 11, Claude Code and Codex signed in), 2026-10-03, with `scripts/app-live/chat.mjs`:
   - **Claude** (haiku, low effort): 5 of 5 scenarios in 5 turns: reply, approve a write, deny a write, Stop while streaming, resume after killing the process. See [g4-live/claude.json](g4-live/claude.json).
   - **Codex** (`gpt-6-luna`, low effort): 5 of 5 in 5 turns, using file-change approvals. Stop ended the app-server, and resume came back on the same thread. See [g4-live/codex.json](g4-live/codex.json).
   - In both runs `~/.claude/settings.json`, the `hydra` entry in `~/.claude.json` and `~/.codex/config.toml` came out unchanged.
   - The first Claude run failed its Stop scenario because of a bug in the script, which sent Stop before the turn had produced text. That was fixed and the run repeated; that run's 5 turns are on top of the 5 above.
8. **THREAT_MODEL**, in "The Hydra app (unreleased)":
   - HSEC-82: the chat's own permissions.
   - HSEC-83: chat logs.
   - HSEC-84: approval routing.
   - HSEC-85: sanitization.
   - HSEC-86: folder trust.
   - HSEC-87: Codex's trust and sandbox.
   - HSEC-88: images and Open in terminal.
   - HSEC-89: the review pane, which runs no program the repository names.
   - `app/tests/threatModel.test.ts` checks that every test each row names exists.
9. **A real task with each provider:** NICO_TASK

**What changed versus this file:**
- **Codex chats are read-only for now.** The goal allows workspace-write, but G1 found two problems:
  - `thread/start` with it writes the folder into `~/.codex/config.toml` as trusted;
  - your elevated Windows sandbox fails every command from a spawned app-server, and the unelevated one refuses workspace-write in a git repository.

  The per-turn route (`turn/start`'s `sandboxPolicy`, G1's shape) is written but switched off by `codexWriteVerified` until a live check proves it. Approved file changes still apply, which is how the Codex live check wrote its file. As a backstop, the app reads Codex's config before and after each turn and says so if the folder became trusted.
- **Stop ends Codex's app-server.** G1 found an interrupted command keeps running until the app-server exits.
- **A message sent mid-turn shows when its turn starts,** not when it is queued, so each turn's cards belong to it.
- **Index saves are coalesced** and kept off the log's queue. The app flushes the store before it quits, which the smoke caught when a stopped turn went missing after a restart.
- **Images are capped at 5 MB of base64,** Claude's own limit, about 3.7 MB of image.
- **Open in terminal** marks the chat. It sends nothing until you say the terminal is closed.
- **Approving a plan** takes a Claude chat out of plan mode, following Claude's own switch.
- **Questions and plan approval are Claude's.** Codex's question requests are refused, as G1 decided.
- **The review pane covers only the chat folder,** and only when the repository's root is that folder or above it. git runs with the repository's filters emptied and lazy fetches off, and Open in editor checks the name against a names-only listing.
- **`ChatOptions.extraArgs`** exists only for the live checks' isolation; no IPC payload can set it.

**Follow-ups:**
- **Codex write access:** find why the elevated Windows sandbox fails from a spawned app-server (`~/.codex/logs_2.sqlite`, G1). Then live-check the per-turn `sandboxPolicy` route, and switch `codexWriteVerified` on if it neither persists trust nor fails.
- **Codex's model list** comes only from a new thread's `model/list`: before the first message, and after a resume, the composer offers just the default.
- **The review pane** hides Monaco's gutter icons, because the CSP loads no fonts. The build still emits the font and its `@font-face`, which could be dropped.
- **The review pane with git LFS:** emptying LFS's clean filter shows a changed LFS file as its pointer against its content. `--ignore-submodules` hides submodule changes.
- **A slash command with an image attached** goes as content blocks, so the CLI may not read it as a command.
- **`extraArguments`** takes any flag. Only the live script uses it, but an allowlist would be safer if it ever reaches the app.
- **The live script's user-state snapshot** covers `~/.claude/settings.json`, the `hydra` entry in `~/.claude.json` and `~/.codex/config.toml`, but not the rest of `~/.claude.json` or `settings.local.json`.
- **Outside G4:** since #303 (G6 M1's rename to "Hydra IDE"), the desktop workflow's installer identity check fails on main, because the installer's ProductName follows the new name and the updater accepts only "Hydra". #304 to PR_M5 merged on their required checks; it is flagged for G6.
- **G5:** usage-limit handoff, heads and plans in chats.

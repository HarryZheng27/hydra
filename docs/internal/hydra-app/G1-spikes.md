# G1: Spikes

**Goal:** answer the questions the app depends on, with recorded evidence, before product code exists. No product code in this goal.

**Needs:** Windows; `claude` and `codex` signed in by Nico, at or above the minimums in `src/core/cliVersions.ts`; a scratch git repository outside this one (`CONTRIBUTING.md`: tests never make worktrees of this repository).

**Budget:** the smallest model of each provider, at most 30 turns each. Stop on a usage limit.

## Deliverables (one PR, `feat/app-g1-spikes`)
- `scripts/app-live/claude.mjs` and `scripts/app-live/codex.mjs`: live checks that drive each CLI through the scenarios below and print pass or fail per scenario. Follow `scripts/claude-acceptance.mjs`'s shape (`--fixture` or `--live`, `--evidence <path>`), but these do send turns, with the turn cap built in. G4 reruns them on every CLI update.
- `tests/fixtures/app/claude/*.jsonl` and `tests/fixtures/app/codex/*.jsonl`: one recorded protocol transcript per scenario, both directions, redacted with `src/core/redact.ts` plus home paths, emails and account ids, each under 200 KB. G4's stand-in CLIs replay these.
- A **Result** section in this file answering every question below, then the plan's adapters table, Cloud and Security sections updated where the facts differ.

## S1: Claude
Start: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>`. Prior art: `f7c56d1^:src/core/claudeProtocol.ts` and `managedClaude.ts`; today's `src/core/helperRunner.ts` already sends `initialize` and `interrupt` control requests.
1. Three turns in one process: list every event type seen.
2. **Route A, the control channel:** `--permission-prompts host`, as Hydra 0.22 used, or its documented equivalent ([headless](https://code.claude.com/docs/en/headless) documents `--permission-prompts none`). Record `control_request` `can_use_tool` for Bash, Edit or Write, WebFetch and an MCP tool. Answer allow, deny, and allow with edited input.
3. **Questions and plan approval on route A:** answer `AskUserQuestion` through `updatedInput` answers, the shape the Agent SDK documents for `canUseTool` ([user input](https://code.claude.com/docs/en/agent-sdk/user-input)). Allow `ExitPlanMode` in `--permission-mode plan`, and deny it with feedback.
4. **Route B:** `--permission-prompt-tool mcp__<stub>__approve` with a stub MCP server. Confirm questions can't pass there. Check whether a model-made call to the tool can be told apart.
5. `interrupt` mid-tool and mid-text. `/model` and `/effort` as messages. A custom slash command and a skill. An image in a user message.
6. Kill the process, restart with `--resume <id>`, continue.
7. Record that `-p` runs a project's hooks and `.mcp.json` without a trust prompt (headless docs), so the app's own trust prompt is required.

**Decide:** route A or B (A is expected, since only A carries questions and plan approval); the image format; whether an idle chat keeps its process or resumes per message.

## S2: Codex
Start: `codex app-server`, JSON-RPC over stdio. Prior art: `f7c56d1^:src/core/managedCodex.ts` and `codexProtocol.ts`; types in `src/core/generated/codex-0.154.0/`.
1. `initialize`, `thread/start` with a working folder, `turn/start`: list every notification in a turn, including `thread/tokenUsage/updated`.
2. `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`: accept, decline, and any per-session option.
3. `turn/interrupt` mid-command. `thread/resume` after the process restarts.
4. Images in `UserInput`; `model/list`; reasoning effort per turn.
5. In a folder Codex hasn't trusted, does it run that project's config or MCP servers without asking?
6. If the CLI version changed, generate types with `codex app-server generate-ts` into a new `src/core/generated/codex-<version>/`, following the existing folder.

**Decide:** one app-server per chat or one per app; the exact method list G4 uses.

## S4: Electron and node-pty
Work in a scratch folder outside the repository.
1. **Electron version:** match the IDE's, the `target` in upstream VS Code's `.npmrc` at the commit pinned in `desktop/upstream.json`, unless there's a reason not to.
2. **node-pty:** for that Electron on Windows, prebuilt or `@electron/rebuild`; ConPTY works; how `src/core/lanePty.ts` finds it in the app.
3. **MCP bridge:** `ELECTRON_RUN_AS_NODE=1 <app exe> hydra-mcp.cjs` works, since the bridge needs it. The IDE ships upstream's fuse defaults; `scripts/desktop-asar-compatibility-probe.mjs` only probes ASAR integrity. Pick the app's fuses, keeping RunAsNode.
4. **Renderer:** Monaco's diff editor and xterm.js run in a sandboxed renderer under the plan's CSP, including workers. Record the exact CSP that works.
5. **Identity:** a userData override and a single-instance lock that never touch the IDE's.

**Decide:** the Electron version, the node-pty approach, the fuses and the CSP string.

## Acceptance
- [x] Every numbered question answered in the Result with evidence: the command and an excerpt.
- [x] Both live checks pass on Nico's machine.
- [x] Fixtures committed, redacted, each under 200 KB.
- [x] The plan updated where facts differ.
- [x] No product code changed; Check and `npm test` green.

## Result (2026-10-02)

Run on Nico's laptop: Windows 11 x64, Node 22.21, `claude` 2.1.282, `codex-cli` 0.157.1, both on Nico's own subscriptions. The live checks are `scripts/app-live/claude.mjs` and `codex.mjs` on a shared harness, `common.mjs`, which records both directions, redacts, caps turns at 30 and checks fixtures. `tests/appLiveFixtures.test.ts` reruns every check on the committed fixtures in `npm test`, and guards their size and redaction. A live run proves the behaviour. In `--fixture` mode the same checks prove that the recorded protocol, and the notes the live run took (files on disk, process state), still say what this Result says. The S4 spike scripts and evidence are kept in [g1-electron/](g1-electron/); they are reference material, not built.

```
node scripts/app-live/claude.mjs --live --evidence <file> --workdir <scratch>
HYDRA_G1_WINDOWS_SANDBOX=unelevated node scripts/app-live/codex.mjs --live --evidence <file> --workdir <scratch>
node scripts/app-live/claude.mjs --fixture --evidence <file>      # what npm test runs, for both
```

**Status:** all three spikes are done. The final live runs passed everything: Claude 11/11 (26 turns), Codex 10/10 (15 turns). The scenarios the confinement rule touches were then re-recorded with the final scripts and passed again. Both scripts pass on the committed fixtures in `--fixture` mode.

**Turn budget, disclosed:** each live run stays under the 30-turn cap the script enforces, but building and re-recording the scripts took more. Claude used about 105 haiku turns across the session. Codex used about 47 turns on `gpt-6-luna`, after Nico used a reset credit; the first 6 `turn/start` requests hit the weekly limit and were refused at no cost.

**Isolation, checked on every run:**
- The user's MCP servers stayed off. Codex checks `mcpServerStatus/list` before any turn and fails if any server other than the harness's own is enabled.
- `~/.claude/settings.json`, the `hydra` entry in `~/.claude.json` and `~/.codex/config.toml` must come out unchanged. They are recorded in the evidence, and a change fails the run.
- Approvals only stand for work inside the scratch repository (`confinementProblem` in `common.mjs`). File paths must resolve inside it, and a shell command must be exactly one the scenario names, or `mkdir g1-<name>`. Anything else is answered with a deny or decline.
- Plan files a run's own sessions write to `~/.claude/plans` are removed.

**Redaction:** `redact.ts`, plus home paths, the machine name, the user's name from git, emails, and identity or secret keys found by walking the parsed (often nested) JSON.
- Each value found is masked with a stable `[redacted-N]` label, so ids the checks correlate stay equal.
- A line that whole-line redaction would break is redacted leaf by leaf instead.
- `tests/appLiveFixtures.test.ts` fails on:
  - known identity keys (`serverName`, `installationId`, account ids, emails) holding anything but a placeholder;
  - token shapes;
  - home paths;
  - a user-name fragment left where a streamed delta split a path.

  It can't recognise an identifier it has no pattern for.

### S1: Claude (live: 11/11, 26 turns; fixtures: 11/11)
Every process runs `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid> --model haiku --effort low --setting-sources project,local --strict-mcp-config --mcp-config <file>`, then sends `{"type":"control_request","request_id":"…","request":{"subtype":"initialize"}}`. The reply comes at once, before any turn, and lists `commands`, `agents`, `models`, `account` and `current_permission_mode`. No usage limit was hit.

1. **Three turns, one process:** three `result/success`, one session id throughout. `system/init` arrives **once per turn**, not once per process. Event types seen:
   - `system/` init, status, thinking_tokens, permission_denied, hook_started, hook_response, background_tasks_changed, task_started, task_updated, task_notification
   - `stream_event` (message_start, content_block_start/delta/stop with text, thinking, signature and input_json deltas, message_delta, message_stop)
   - `assistant`, `user`, `rate_limit_event`
   - `control_request/can_use_tool`, `control_response`
   - `result/success`, `result/error_during_execution`
2. **Route A works, but needs `--permission-prompt-tool stdio`.** With `--permission-prompts host` alone, 2.1.282 never asks the host (recorded in `headless-defaults`): each prompt becomes `{"type":"system","subtype":"permission_denied","tool_name":"Write",…}`. With the flag, as the Agent SDK's own launcher passes it, prompts arrive as `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{…},"description":"…","permission_suggestions":[…],"blocked_path":"…","tool_use_id":"toolu_…"}}`. Seen for Bash, Write, WebFetch and `mcp__g1stub__echo`, which adds `mcp_server`.
   - Allow: `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}`
   - Deny: `"response":{"behavior":"deny","message":"…"}`. The model gets an `is_error` tool_result, and nothing is written.
   - Allow with an edited input: the file on disk held the host's content, `edited-by-host`.
3. **Questions and plan approval (route A):** `AskUserQuestion` arrives as `can_use_tool` with `requires_user_interaction:true`.
   - Questions are answered with `{"behavior":"allow","updatedInput":{…input,"answers":{"Pick a color":"Blue"}}}`, and the model replied "Blue".
   - `ExitPlanMode` (`--permission-mode plan`) carries `input.plan` and `planFilePath`. Deny with a message made the model revise the plan and present it again. Allow returned "User has approved your plan", and `system/status` switched to `permissionMode:"default"`.
4. **Route B also carries questions and plan approval on 2.1.282**, contrary to the plan's 2.1.199 note.
   - With `--permission-prompt-tool mcp__g1stub__approve`, the CLI calls the stub's `approve` tool with `{tool_name, input, tool_use_id}` and `_meta["claudecode/toolUseId"]`. `answers` returned in `updatedInput` reached the model ("Red"), and `ExitPlanMode` went through.
   - The approve tool is hidden from the model: it's absent from init `tools`, and haiku said it had no such tool.
   - Telling calls apart: a CLI-made call has `_meta["claudecode/toolUseId"]` equal to `arguments.tool_use_id`, and a model-made call would show as an `assistant` `tool_use` block.
5. **Interrupt and in-chat commands:**
   - `interrupt` ends a foreground tool in about 0.6 s and text output in about 20 ms, with `result/error_during_execution`, and the process keeps working. In one development run, the next message produced two results, so a host can't assume one result per message: key on `result_index` and `queued_turn_count`.
   - `/model sonnet` and `/effort medium` sent as plain messages are handled locally: a `<synthetic>` assistant message, then the next turn ran on `claude-sonnet-5`. The `set_model` control request works too.
   - A project `.claude/commands/g1cmd.md` (`$ARGUMENTS` expanded) and a project skill both ran.
   - An image block in the user message works, and the model named the colour.
6. **Kill and resume:** after `taskkill /t /f`, `--resume <id>` (no `--session-id`) kept the session id and the conversation. Startup takes about 4 s.
7. **Untrusted folder:** in a never-opened repository, `-p` ran the project's SessionStart and UserPromptSubmit hooks and started its `.mcp.json` server (`mcp_servers: ["g1proj:connected"]`) with no prompt. Hard rule 6 holds: the app's own trust prompt is required.

**Decide:**
- **Route A,** launched with `--permission-prompt-tool stdio`. Route B is the fallback, but it relies on undocumented behaviour.
- **Images:** `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}` beside a text block.
- **Idle chats:** keep the process while the chat is active, end it after an idle timeout and on quit, and `--resume` on the next message.

**Also learned:**
- `--setting-sources project,local` still loads `~/.claude/CLAUDE.md`, and plan mode writes to `~/.claude/plans/`.
- `--strict-mcp-config` also ignores the project's `.mcp.json` (recorded in `headless-defaults`: the project server never starts); deny named servers with `--settings` `deniedMcpServers` instead.
- Read-only Bash such as `echo` runs without a prompt.
- Spawning a bare `claude` failed when PATH lacked `~\.local\bin`; resolve it with `where.exe`.

### S2: Codex (live: 10/10, 15 turns on `gpt-6-luna`; fixtures: 10/10)
The live check runs `codex app-server --listen stdio://`. It disables each of the user's MCP servers by name (`-c mcp_servers.<name>.enabled=false`; `-c mcp_servers={}` merges and disables nothing), turns off plugins and the other features with `--disable plugins …`, and sends `approvalsReviewer:"user"`. The final run used `HYDRA_G1_WINDOWS_SANDBOX=unelevated`, which adds `-c windows.sandbox=unelevated`; item 2 says why.

1. **Initialize and turn notifications:**
   - `initialize {clientInfo, capabilities:{experimentalApi:false}}` returns `codexHome, platformFamily, platformOs, userAgent`, then the client sends `initialized`. `windowsSandbox/readiness` reports `ready`.
   - `thread/start` in an untrusted folder with no policy gets `approvalPolicy "on-request"` with a read-only sandbox.
   - Before any thread, the server sends `remoteControl/status/changed` and `account/updated`.
   - A successful turn sends, in order: `thread/status/changed`, `turn/started`, `item/started` and `item/completed` (userMessage, agentMessage), `item/agentMessage/delta`, `thread/tokenUsage/updated` (`total`, `last`, `modelContextWindow`), `account/rateLimits/updated`, then `turn/completed`.
   - A turn refused by the usage limit sends `error` (`codexErrorInfo: "usageLimitExceeded"`, `willRetry:false`), then `turn/completed` with `status:"failed"`.
2. **Approvals** (seen live):
   - Command requests carry `availableDecisions, command, commandActions, cwd, environmentId, itemId, kind, proposedExecpolicyAmendment, startedAtMs, threadId, turnId`.
     - `decline` stops the command, and the model reported it.
     - `accept` ran it: the reply held its output, 42.
     - `acceptForSession` covered the repeat: two runs, one prompt.
   - File-change requests carry `grantRoot, itemId, reason, startedAtMs, threadId, turnId`. The proposed changes come on the earlier `item/started` `fileChange` item.
     - `decline` wrote nothing, and `accept` wrote the file.
     - **`acceptForSession` did not cover a second patch:** each of the two patches asked again.
   - The schema also lists `cancel`, plus two amendment decisions for commands.
   - Nico's config sets `approvals_reviewer = "auto_review"`, which sends approvals to Codex's own reviewer, so the client never sees them. G4 must send `approvalsReviewer: "user"` and check the value echoed back.
   - **Windows sandbox:**
     - With Nico's `[windows] sandbox = "elevated"`, every command from the spawned app-server failed before it started. Codex's log (`~/.codex/logs_2.sqlite`) says `CreateProcess … helper_unknown_error: apply deny-read ACLs`, and the model saw only a failure.
     - With `unelevated`, read-only commands run. But `workspace-write` is refused in a git repository ("cannot enforce split writable root sets directly; refusing to run unsandboxed"), because `.git` stays read-only inside the writable root.
     - So a Codex chat can apply approved patches and run read-only commands. Letting commands write is open for G4: it needs to find why the elevated helper fails when Hydra starts app-server, which may depend on the parent process.
3. **Interrupt and resume:**
   - `turn/interrupt {threadId, turnId}` returns `{}`, and the turn completes `interrupted` about 0.8 s later.
   - **The running command is not stopped:** its process was still alive 3 s after the turn ended, and gone only once the app-server exited. The app must end the process to stop a command.
   - `thread/resume {threadId, cwd, model, approvalPolicy, approvalsReviewer, sandbox}` in a new process returned the same thread with its 1 earlier turn, and the model recalled the code word.
4. **Images, models, effort:**
   - Images work both ways: `{type:"localImage", path}` (the model named red) and `{type:"image", url:"data:image/png;base64,…"}` (it named blue).
   - `model/list` returns 9 models, all taking text and image input. There is no mini tier; the smallest is `gpt-6-luna`.
   - Effort can be set per thread (`config.model_reasoning_effort`, which thread/start echoes back) or per turn (`turn/start` `effort`, which `thread/read` then reports).
   - **Codex accepts an unknown effort** (`"not-an-effort"` started a turn), so the app must check model and effort against `model/list` itself.
5. **Untrusted folder:**
   - A read-only thread did not apply the project's `.codex/config.toml`: its `developer_instructions` didn't reach the model, and its MCP server never started, even after a turn.
   - A `configWarning` says project config, hooks and exec policies are off "until the project is trusted, but skills still load".
   - **But `thread/start` with `sandbox: "workspace-write"` silently writes `trust_level = "trusted"` for the folder into the user's `~/.codex/config.toml`.** That happens with `ephemeral:true` and with `config.sandbox_mode` too. Four such entries were written while the spike was being built, and removed afterwards; the config's hash matches the snapshot taken before.
   - The script now starts read-only threads only. If the config ever changes, it removes the scratch folder's entries.
   - What a trusted project then runs is inferred from Codex's warning, not observed: the probe that would trust a folder on purpose is behind `HYDRA_G1_TRUST_PROBE=1` and was not run.
6. **Types:** generated into `src/core/generated/codex-0.157.1/`, with the same 18 root types and flags as 0.154.0 (regenerating 0.154.0 matched byte for byte). Nothing imports the new folder yet.
   - The changes below come from diffing two full `generate-ts` outputs, which aren't committed; only the subset the repo uses is.
   - Changed from 0.154.0: `thread/rollback` removed; `thread/attachment/*` and `account/gatewayOAuth/*` added; `disabledPluginIds` on turn and thread params and responses; images take `fileId`; command approval requests gain `kind`, which is also seen live.
   - Unchanged: the approval decision types, interrupt, `turn/completed`, errors and token usage.

**Decide:**
- **One app-server per chat.** An interrupt leaves the command running, and only ending the process stops it, so killing one must never touch another chat. This replaces the provisional one-per-app call. A process costs about 3 s and 95 MB through the npm shim.
- **Methods G4 uses:** `initialize`/`initialized`, `windowsSandbox/readiness`, `model/list`, `account/rateLimits/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `thread/read`, `mcpServerStatus/list`.
- **Server requests G4 answers:** the two approval requests. Refuse every other server request.
- **Notifications:** the turn sequence in item 1, plus `serverRequest/resolved`, `error`, `configWarning` and `account/rateLimits/updated`.
- **Required:**
  - Threads start read-only.
  - `approvalsReviewer` is always `user`.
  - Model and effort are checked against `model/list`.
  - The Windows sandbox mode is G4's open question (item 2).

### S4: Electron and node-pty (all checks pass; evidence in [g1-electron/](g1-electron/))
1. **Electron 44.x (44.5.1 tested), not 39.8.3.** The IDE's pin is upstream's `.npmrc` `target="39.8.3"` at `cfbea10`, but the 39 line is end of life (last release 39.8.10, 2026-05-05). ConPTY and the renderer passed on both 39 and 44 (`pty-39.8.3.json`, `renderer-39-final.json`); the bridge, fuse and identity checks ran on 44 only.
2. **node-pty 1.2.0-beta.12 with its shipped N-API prebuilds; no `@electron/rebuild`.**
   - ConPTY worked in Electron main: `cmd /d /c echo hello-from-conpty` exited 0, and PowerShell returned output with exit 7. It also worked from a packaged `app.asar` with `*.{node,dll,exe}` unpacked.
   - `src/core/lanePty.ts` needs no change: its first candidate, `<app.getAppPath()>/node_modules/node-pty`, loads through the archive.
   - Traps to avoid: upstream's `build_from_source=true` makes node-pty delete its prebuilds, and electron-rebuild would rebuild it.
3. **Fuses:** RunAsNode **on** (the bridge needs it), EnableCookieEncryption on, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, EnableEmbeddedAsarIntegrityValidation on, OnlyLoadAppFromAsar on, GrantFileProtocolExtraPrivileges off, LoadBrowserProcessSpecificV8Snapshot off.
   - On the fused copy, `ELECTRON_RUN_AS_NODE=1 Hydra.exe bridge.cjs` completed a JSON-RPC round trip, and `NODE_OPTIONS` was ignored.
   - A one-byte patch to `app.asar` gives "ASAR Integrity Violation", including for run-as-node scripts inside the archive.
   - Under RunAsNode, `--inspect` still works, even with its fuse off.
   - The IDE ships stock Electron defaults.
4. **CSP** (0 violations on 39 and 44, and on the fused 44 package: `renderer-39-final.json`, `renderer-44-final.json`, `renderer-fused.json`; screenshot `renderer-44-final.png`):
   `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hydraWorker defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer editorViewLayer richScreenReaderContent standaloneColorizer tokenizeToString stickyScrollViewLayer editorGhostText dompurify`
   - The page is served from a custom `app://hydra/` scheme with the CSP as a response header, since workers take their CSP from their own response.
   - Monaco's worker entry is `editor.worker.js`, and needs no `blob:`.
   - `'unsafe-inline'` styles can't be avoided, because Monaco and xterm insert `<style>` elements. Trusted Types makes up for it on the script side.
5. **Identity:** with `app.setPath('userData', …\Hydra App)` before `requestSingleInstanceLock()`:
   - a second instance is refused, and the first gets `second-instance` with the second's data;
   - a stand-in IDE instance on `…\Hydra` gets its own lock at the same time;
   - `setAppUserModelId('Hydra.App')` succeeds.
   - Electron's lock **takes no name**: it is keyed on the userData folder.
   - Without the override, a `productName: "Hydra"` app uses `%APPDATA%\Hydra`. The spike proved this by accident: its first renderer runs wrote Chromium caches, `Local State` and `Preferences` into the IDE's real `%APPDATA%\Hydra` (VS Code's `User\` folder was untouched). G3 must set userData as its first statement and test it.

**Decide:** Electron 44.x pinned exactly; node-pty prebuilds, never rebuilt; the fuses above; the CSP above.

### What changed versus the plan
- **Claude route A** needs `--permission-prompt-tool stdio`. Route B carries questions and plan approval on 2.1.282.
- **Codex:**
  - `approvalsReviewer:"user"` is required.
  - A workspace-write `thread/start` persists project trust, so threads must start read-only.
  - The app must check model and effort itself.
  - Disabling a user's MCP servers takes their names.
  - One app-server per chat, not per app: an interrupt leaves the command running until the process exits.
  - The user's `elevated` Windows sandbox fails commands from a spawned app-server, and `unelevated` can't write in a git repository. Write-capable commands are open for G4.
  - `acceptForSession` covers repeated commands, but not a second patch.
- **Electron and native code:**
  - Electron 44, not the IDE's 39.
  - node-pty isn't rebuilt.
  - Electron's single-instance lock has no name. `hydra-ide` is the IDE's `win32MutexName`, a Windows mutex for Inno's `AppMutex` check; G6 picks a mutex (`@vscode/windows-mutex`, compiled on install) or Inno's Restart Manager.
  - The CSP needs inline styles.
  - Bridge scripts belong inside `app.asar`.

### Follow-ups
- **G3:** set userData first and test it; adopt the CSP, fuses and Electron 44; unpack the native files; keep node-pty out of rebuilds.
- **G4:**
  - Claude: route A arguments.
  - Codex:
    - `approvalsReviewer`, read-only threads, and checking model and effort.
    - One process per chat.
    - Find why the elevated Windows sandbox fails from a spawned app-server (`~/.codex/logs_2.sqlite` holds the error), then decide how commands may write.
  - Both: rely on results, not one result per message.
  - Move to the 0.157.1 types.
- **G6:** decide between a mutex and the Restart Manager.

# The Hydra app: plan

A chat-first desktop app named **Hydra**, shipped beside the Hydra IDE on the same engine and canvas. Proposal, 2026-10-02; nothing built. The build is split into goals in [hydra-app/](hydra-app/README.md). Agents: read this, then the files it names.

**Naming:** "desktop" in this repo already means the IDE's standalone build (`desktop/`, `desktop:*`, `desktop.yml`), so docs and code say "the app" (`app/`, `app:*`) and "the IDE". On one PC the two must stay distinct:
- **Shown names:** the app is "Hydra". The IDE becomes "Hydra IDE" through `nameLong` in `desktop/product.json`: Start menu, Apps list, desktop shortcut, window title. Its `nameShort` stays "Hydra", because it names the IDE's data folder (`%APPDATA%\Hydra`), which the installer tests guard.
- **Shortcut handover:** an IDE release renames its shortcuts to "Hydra IDE" and deletes its old `Hydra.lnk` files before the app ships. Its uninstaller must never delete the app's `Hydra.lnk` later, since Inno's uninstall log keeps entries from earlier installs.
- **App identity:** user data `%APPDATA%\Hydra App`, install folder `%LOCALAPPDATA%\Programs\Hydra App`, AppUserModelId `Hydra.App`. The IDE's are `%APPDATA%\Hydra`, `%LOCALAPPDATA%\Programs\Hydra` and `Hydra.IDE`. Electron would default the app's user data to `%APPDATA%\Hydra`, so set it explicitly, as main's first statement: G1's spike wrote into the IDE's folder before it did. Electron's single-instance lock takes no name; it is keyed on the user-data folder, so the app's own folder keeps it apart from the IDE's (G1). The IDE's `hydra-ide` is a Windows mutex (`win32MutexName`) for Inno's `AppMutex` check. G6 decides whether the app makes a `hydra-app` mutex the same way or relies on the Restart Manager.
- **Installers:** `HydraSetup.exe` stays the IDE's, because installed IDEs update from that exact file. The app's is `HydraAppSetup.exe`.
- **`hydra` command:** plan commands work with either app, since storage is shared. G6 settles which app `hydra <folder>` opens.

## Goal
- Look and work like Claude's desktop app (Code tab): sidebar of projects and chats, chat pane, composer.
- Each chat runs Claude Code or Codex through their own CLIs, so their features come with them, except terminal-only commands such as `/login`.
- Hydra on top: MCP tools, heads, plans, gates, lanes, packs, limit handoff, Agents canvas.
- Local or Cloud per chat and per plan job.
- The IDE stays and keeps shipping. Free and open source.

**Non-goals (v1):** editing code (read-only diffs; users keep their editor). macOS and Linux (head confinement is Windows-only, HR-04). Hydra-run servers, API-key billing, accounts. A pixel copy of Claude's app, or any provider branding.

## Hard rules
1. Run the user's installed, unmodified `claude` and `codex`. Never bundle Claude Code or the Claude Agent SDK: Anthropic bars third-party apps from offering Claude.ai login, including SDK agents, but allows a user signing in to the unmodified binary with their own plan ([legal](https://code.claude.com/docs/en/legal-and-compliance), [SDK](https://code.claude.com/docs/en/agent-sdk/overview)).
2. No Hydra sign-in screen. Sign-in runs in each CLI's own flow, in a terminal. Never read, store or forward tokens. The existing Codex `auth.json` hard link (`src/core/agentHome.ts`, HR-21) stays local.
3. Provider names in plain text only ("runs Claude Code"). No provider name or logo in Hydra's name or logo. Provider marks only label a chat's provider (`media/PROVIDER-MARKS.md`).
4. Each user's own subscription. Nothing shared, resold or proxied.
5. Every THREAT_MODEL control for the IDE applies to the app. Each new surface gets an HSEC entry and a test before release.
6. No chat starts in a folder the user hasn't trusted in the app. `claude -p` shows no trust dialog and runs a project's hooks and `.mcp.json` servers even in a folder never trusted ([headless](https://code.claude.com/docs/en/headless)).

## Architecture
```
Electron main (Node)                 Renderer (React, sandboxed)
  ElectronHost (app/src/main)          Sidebar, chat, composer
  HydraController (src/host)           Approval and question cards
  Engine: src/core                     Review: read-only Monaco diff
  Chat: src/core/chat -> CLIs          Agents canvas (webview/)
  Endpoint + MCP bridge                Lanes (webview/, xterm)
  Settings, storage, updates
           <-- typed IPC, preload allowlist -->
```
Main starts every process: chat CLIs, heads, gates, node-pty lanes, Edge for screenshots. The renderer starts nothing.

| Reuse as-is | Where |
| --- | --- |
| Heads, plans, jobs, integration, gates, packs, sandbox, limit handoff, `hydra` CLI, update check | `src/core` (no `vscode` imports; settings arrive as parameters) |
| Endpoint, lead verification, discovery, handshake, MCP bridge, registration | `src/core/helper*.ts`, `leadVerification.ts`, `mcpBridge.ts`, `userHandshake.ts`, `helperRegistration.ts` |
| Canvas, lanes UI | `webview/AgentsCanvas.tsx`, `AgentsBody.tsx`, `LanesView.tsx` |

**Recover** (removed 2026-09-24 in `f7c56d1`; read at `f7c56d1^`, re-verify in G1): `src/core/managedClaude.ts` and `claudeProtocol.ts` (stream-json chat, `can_use_tool` approvals, resume, model and effort), `managedCodex.ts` and `codexProtocol.ts` (app-server threads, turns, approvals, interrupt), `sessionStore.ts`.

**Extract (G2):** `src/extension.ts` (about 1,900 lines) holds the controller in its `Manager` class: webview messages (`handle`, about line 1805), plan actions, head wiring, ownership, discovery. Move the host-agnostic part into `src/host/` as `HydraController` behind a `Host` interface. The IDE implements `Host` with VS Code, and the app with Electron. No IDE behaviour change. Done 2026-10-02: see [G2's Result](hydra-app/G2-host-split.md#result-2026-10-02). Beyond the controller, the lanes controller, quota, accounts, limits and Hydra Settings are host-agnostic too. IDE-only parts go through a second interface, `ControllerIde`.

**Build new:**
- **Chat logic in `src/core/chat/`,** host-agnostic and tested with stand-in CLIs: one event model for both providers, the adapters, sessions, and the chat store. The store is Hydra's own append-only log per chat plus the provider's session or thread id. It never parses provider transcripts, because Claude's format is internal and changes between versions ([sessions](https://code.claude.com/docs/en/sessions)).
- **App UI in `app/`:**
  - **Shell:** window, sidebar, settings, onboarding.
  - **Chat:** pane and composer: provider, model, effort, permission mode, Local or Cloud, images, slash commands, stop.
  - **Cards:** approvals and questions.
  - **Review:** a read-only Monaco diff.
  - **Folder trust:** the prompt from hard rule 6.
- **A chat is the user's own agent,** like the official extensions. Head confinement doesn't apply to it; it runs with the CLI's own permissions and sandbox.

## Provider adapters
| | Claude | Codex |
| --- | --- | --- |
| Process | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>`; later `--resume <id>` | `codex app-server`, JSON-RPC over stdio |
| Turn | user message on stdin | `thread/start` or `thread/resume`, then `turn/start` |
| Stream | stream-json events | `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated` |
| Approvals | **Route A:** `control_request` `can_use_tool` on stdio, answered by `control_response`. Needs `--permission-prompt-tool stdio`, as the Agent SDK passes it: with only `--permission-prompts host`, which unreleased Hydra 0.22 used, 2.1.282 turns every prompt into `system/permission_denied` (G1) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`: `accept`, `acceptForSession`, `decline` (seen live), and `cancel`. Always send `approvalsReviewer: "user"`, or a user's `auto_review` setting hides approvals from the app (G1) |
| Questions, plan approval | `AskUserQuestion` answered through `updatedInput` answers, the shape the Agent SDK documents for `canUseTool` ([user input](https://code.claude.com/docs/en/agent-sdk/user-input)); `ExitPlanMode` allowed, or denied with feedback | none in v1: other server requests (`item/tool/requestUserInput`, elicitation) are refused |
| Stop | `interrupt` control request (heads already send it: `src/core/helperRunner.ts`); one message can yield more than one `result` | `turn/interrupt` |
| Model, effort | `/model`, `/effort` messages (documented headless), or the `set_model` control request | turn parameters, checked against `model/list`: Codex accepts an unknown effort |
| Images | base64 `image` content block beside the text | `localImage` or `image` `UserInput` |
| Sandbox | the CLI's own | threads start `read-only`: `workspace-write` on `thread/start` writes the folder into the user's `config.toml` as trusted (G1). Approved patches still apply. **Open for G4:** letting commands write. The user's `elevated` Windows sandbox failed every command from a spawned app-server, and `unelevated` refuses `workspace-write` in a git repository (G1) |
| Processes | one per chat while it's active, ended when idle, `--resume` on the next message | one app-server per chat: `turn/interrupt` ends the turn but leaves its command running until the app-server exits (G1) |
| Hydra tools | the IDE's user-level `hydra` MCP registration | same, in `config.toml` |

- **Route A is chosen (G1).** Route B, `--permission-prompt-tool mcp__hydra__approve`, stays the fallback. The docs say it can't carry questions or plan approval, but on 2.1.282 it did carry both, and its tool was hidden from the model. Treat that as undocumented behaviour.
- Regenerate Codex types for the pinned version (`codex app-server generate-ts`), as `src/core/generated/` does. 0.157.1's are in `src/core/generated/codex-0.157.1/`.
- The live checks `scripts/app-live/claude.mjs` and `codex.mjs` drive both CLIs through these flows. Rerun them on every CLI update; G4's stand-in CLIs replay their fixtures.
- Anything an adapter can't render is denied, never allowed by default.

## Orchestration
- Each local chat is a lead. Its bridge finds the app's endpoint through discovery. `leadVerification.ts` accepts it because its process chain reaches the app's main process: same security model.
- Heads, plans, gates and lanes run as in the IDE (`helperService.ts`, `planRunner.ts`). The canvas is the same component and opens full-window, like the IDE's Agent Manager. Chats show head and plan cards inline.

## IDE and app on one machine
- **One storage root:** both use `%APPDATA%\Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager`, the IDE's global storage. That gives one ownership lock per repository, one discovery folder, one `hydra` registration, and a shared audit log and plan store. The `hydra` CLI and the benchmark work against either. The app creates the folder if the IDE is absent.
- **Ownership:** a repository open in one app is refused in the other (the existing lock).
- **Registration:** both keep the one `hydra` entry; each repairs it only when its target is missing.
- **Uninstall:** removing one app never deletes the shared storage root while the other is installed.
- **App-only state** (window, sidebar, chat logs) lives in `%APPDATA%\Hydra App`.

## Cloud
Cloud agents can't reach Hydra's endpoint (loopback only). Their work is checked when it comes back.
- **Claude:** `claude --cloud "<prompt>"` prints a session id and a claude.ai/code URL. It needs the repository on GitHub and a paid plan. The CLI reports no status or progress; only the web page does. `claude --teleport <id>` brings the session back. The docs list no Windows limit, but a third-party guide disagrees; G7 checks. See [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).
- **Codex:** `codex cloud exec --env <id> "<prompt>"`, `codex cloud status <task>`, `codex cloud diff <task>`, `codex apply <task>`. It needs a Codex cloud environment.
- **Cloud chat:** start it, show the link, and offer **Bring back** into a fresh worktree.
- **Cloud head** (plan job `where: "cloud"`): Codex only, because it reports status and diffs. Hydra polls, applies the diff to the job's branch, then runs gates and cross-review locally before it can land. Claude cloud heads wait until its CLI reports status.

## Security for new surfaces
- **Renderer:** context isolation, sandbox, no Node integration, strict CSP with no remote scripts, no `webview` tag, navigation blocked. External links need a confirm, then `shell.openExternal`. The CSP G1 proved, sent as a response header from a custom `app://` scheme so workers get it too, is in [G1's result](hydra-app/G1-spikes.md#result-2026-10-02). It needs `style-src 'unsafe-inline'`, because Monaco and xterm insert `<style>` elements, and makes up for it with Trusted Types.
- **Electron fuses:** RunAsNode stays on, since the MCP bridge, `hydra` CLI and limit hook need it. NODE_OPTIONS, `--inspect` arguments and the file protocol's extra privileges are off. Cookie encryption, embedded ASAR integrity and only-load-from-ASAR are on. Ship the bridge scripts inside `app.asar` so integrity covers them. Under RunAsNode, `--inspect` still works, which is no worse than RunAsNode itself.
- **Codex trust:** never start a Codex thread with `workspace-write`; it writes the folder into the user's `config.toml` as trusted, which turns on that project's config, hooks and MCP servers.
- **Untrusted output:** render model and tool output as sanitized markdown, no raw HTML. Draw approval cards only from structured requests. If G1 falls back to route B, a model-made call to `approve` must be detected and denied.
- **IPC:** the preload exposes a fixed, typed call set; main validates every message, as `parseMessage` does today. Built in G3 (HSEC-73 to HSEC-81):
  - only the main frame of an `app://hydra/` page may call;
  - no payload carries a path or a command, so CLI paths and project folders come only from main's own pickers.
- **Chat logs:** local, with a user-only access list like handshakes. The redactor covers diagnostics and evidence, not the chat.
- **Updates:** the IDE's check (SHA256SUMS, allowed hosts) with the app's own asset. Unsigned until HR-14 is solved, like the IDE.

## Repo, build, release
- `app/` has its own `package.json` and lockfile: Electron 44.x, pinned exactly (the IDE's 39 is end of life; G1), Monaco, xterm, and node-pty 1.2.0-beta.12 from its N-API prebuilds. Never rebuild node-pty: no `build_from_source`, and keep it out of electron-rebuild. Unpack `*.{node,dll,exe}` from `app.asar`. esbuild bundles `../src/core`, `../src/host` and `../webview`. The root package and IDE build stay untouched.
- **CI:** new Windows workflow `app.yml`: typecheck, unit tests, build, and a smoke test with stand-in CLIs.
- **Previews:** prereleases tagged `v<version>-app.<n>` with only `HydraAppSetup.exe`. `releases/latest` skips prereleases and the IDE's updater ignores suffixed versions, so IDE users keep getting the IDE. Previews don't update themselves.
- **Stable:** versions in lockstep with the IDE. One release carries `HydraSetup.exe` and `HydraAppSetup.exe`, with one `SHA256SUMS` for both. `installerName` in `updateCheck.ts` becomes per product; `scripts/install.ps1` gains `-App`.

## Build order
Seven goals, each buildable alone with `/goal`: see [hydra-app/README.md](hydra-app/README.md). G1 spikes and G2 host split run first and in parallel. Then G3 foundation, G4 local chat, G5 orchestration, then G6 ship and G7 cloud.

## Decisions
- **Names (decided):** the app is "Hydra", the IDE is "Hydra IDE" (display only; see Naming).
- **Installer (decided):** Inno Setup, like the IDE: per-user install without admin, uninstall that removes only this install's Claude and Codex entries and asks before deleting data (`/HYDRAREMOVEDATA`), and the in-app update mode. Adapt the IDE's `desktop/*.iss` scripts and its installer, upgrade and uninstall tests.
- **Anthropic terms (decided):** Nico judged the design compliant: the user's own unmodified CLI and their own sign-in. An email through the legal page's contact link stays optional.
- **D1 (open):** whether the quality benchmark (`bench/QUALITY_RUN.md`) changes G5's priorities.

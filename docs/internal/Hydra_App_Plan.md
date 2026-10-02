# The Hydra app: plan

A chat-first desktop app named **Hydra**, shipped beside the Hydra IDE on the same engine and canvas. Proposal, 2026-10-02; nothing built. Agents: read this, then the files it names.

**Naming:** "desktop" in this repo already means the IDE's standalone build (`desktop/`, `desktop:*`, `desktop.yml`), so docs and code say "the app" (`app/`, `app:*`) and "the IDE". On one PC the two must stay distinct:
- **Shown names:** the app is "Hydra". The IDE becomes "Hydra IDE" through `nameLong` in `desktop/product.json`: Start menu, Apps list, desktop shortcut, window title. Its `nameShort` stays "Hydra", because it names the IDE's data folder (`%APPDATA%\Hydra`), which the installer tests guard.
- **Shortcut handover:** an IDE release renames its shortcuts to "Hydra IDE" and deletes its old `Hydra.lnk` files before the app ships. Its uninstaller must never delete the app's `Hydra.lnk` later, since Inno's uninstall log keeps entries from earlier installs.
- **Separate identities:** install folder (the IDE owns `%LOCALAPPDATA%\Programs\Hydra`), user-data folder (Electron defaults to `%APPDATA%\<name>`, which is the IDE's, so set it explicitly), taskbar id (IDE: `Hydra.IDE`), single-instance mutex (IDE: `hydra-ide`).
- **Installers:** `HydraSetup.exe` stays the IDE's, because installed IDEs update from that exact file. The app's is `HydraAppSetup.exe`.
- **`hydra` command:** plan commands work with either app, since storage is shared. Which app `hydra <folder>` opens is settled in P4.

## Goal
- Look and work like Claude's desktop app (Code tab): sidebar of projects and chats, chat pane, composer.
- Each chat runs Claude Code or Codex through their own CLIs, so their features come with them. Exceptions: terminal-only commands (`/login`), and questions and plan approval until S1 settles them.
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

## Architecture
```
Electron main (Node)                 Renderer (React, sandboxed)
  Host adapter (app/main/host)         Sidebar, chat, composer
  HydraController (shared)             Approval and question cards
  Engine: src/core                     Review: read-only Monaco diff
  Chat sessions -> claude / codex      Agents canvas (webview/)
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

**Recover** (removed 2026-09-24 in `f7c56d1`; read at `f7c56d1^`, re-verify in S1 and S2): `src/core/managedClaude.ts` and `claudeProtocol.ts` (stream-json chat, `can_use_tool` approvals, resume, model and effort), `managedCodex.ts` and `codexProtocol.ts` (app-server threads, turns, approvals, interrupt), `sessionStore.ts`.

**Extract (P1):** `src/extension.ts` (about 1,900 lines) holds the controller: webview messages (`handle`, about line 1805), plan actions, head wiring, ownership, discovery. Move the host-agnostic part into a shared `HydraController` behind a `Host` interface: notify, confirm, open diff, open terminal, pick folder, clipboard, open URL, settings, storage root, app root (node-pty), folder trust. The IDE implements `Host` with VS Code, the app with Electron. No IDE behaviour change; small PRs, since main moves daily. In `webview/index.tsx`, replace `acquireVsCodeApi` with an injected post and receive bridge.

**Build in `app/`:**
- **Shell:** window, sidebar, settings, onboarding (CLI found, signed in, `hydra` MCP registered).
- **Chat:** one event model for both providers: text, thinking, tool call and result, file change, approval, question, plan, usage, error, done.
- **Composer:** provider, model, effort, permission mode, Local or Cloud, images, slash commands passed through, stop.
- **Review:** the chat's worktree or branch diff, read-only Monaco.
- **Chat store:** Hydra's own append-only event log per chat, plus the provider session or thread id. Never parse provider transcripts: Claude's format is internal and changes between versions ([sessions](https://code.claude.com/docs/en/sessions)).
- **Folder trust:** ask before the first run in a folder, like the IDE's workspace trust. Hydra tools need a git repository the app owns; other folders get chat only.
- **Approval tool:** a lead-only `approve` tool in Hydra's MCP bridge that routes to the app's approval card.

## Provider adapters
| | Claude | Codex |
| --- | --- | --- |
| Process | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>`; later turns `--resume <id>` | `codex app-server`, JSON-RPC over stdio |
| Turn | user message on stdin | `thread/start` or `thread/resume`, then `turn/start` |
| Stream | stream-json events | `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated` |
| Approvals | Documented: `--permission-prompt-tool mcp__hydra__approve`. Fallback: undocumented `control_request` `can_use_tool` on stdio, used by unreleased Hydra 0.22 with CLI 2.1.270 | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` |
| Stop | `interrupt` control request (heads already send it: `src/core/helperRunner.ts`) | `turn/interrupt` |
| Model, effort | `/model`, `/effort` messages (documented headless) | turn parameters |
| Hydra tools | the IDE's user-level `hydra` MCP registration | same, in `config.toml` |

- Claude can't approve tools marked as needing user interaction through the permission tool; since 2.1.199 an allow becomes a deny ([CLI reference](https://code.claude.com/docs/en/cli-reference)). That covers questions and plan approval; S1 decides how the app handles them.
- Regenerate Codex types for the pinned version (`codex app-server generate-ts`), as `src/core/generated/` does.
- Anything an adapter can't render is denied, never allowed by default.

## Orchestration
- Each local chat is a lead. Its bridge finds the app's endpoint through discovery. `leadVerification.ts` accepts it because its process chain reaches the app's main process: same security model.
- Heads, plans, gates and lanes run as in the IDE (`helperService.ts`, `planRunner.ts`). The canvas is the same component and opens full-window, like the IDE's Agent Manager. Chats show head and plan cards inline.

## IDE and app on one machine
- **One storage root:** both use `%APPDATA%\Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager`, the IDE's global storage. That gives one ownership lock per repository, one discovery folder, one `hydra` registration, and a shared audit log and plan store. The `hydra` CLI and the benchmark work against either. The app creates the folder if the IDE is absent.
- **Ownership:** a repository open in one app is refused in the other (the existing lock).
- **Registration:** both keep the one `hydra` entry; each repairs it on start if it points at a missing install.
- **App-only state** (window, sidebar, chat logs) lives in the app's user-data folder.

## Cloud
Cloud agents can't reach Hydra's endpoint (loopback only). Their work is checked when it comes back.
- **Claude:** `claude --cloud "<prompt>"` prints a session id and a claude.ai/code URL. It needs the repository on GitHub and a paid plan. There's no status or progress from the CLI, only the web page. `claude --teleport <id>` brings the session back; the docs list no Windows limit, but a third-party guide disagrees (S3). See [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).
- **Codex:** `codex cloud exec --env <id> "<prompt>"`, `codex cloud status <task>`, `codex cloud diff <task>`, `codex apply <task>`. It needs a Codex cloud environment.
- **Cloud chat:** start it, show the link, and offer **Bring back** (a lane terminal running teleport, or `codex apply`, in a fresh worktree).
- **Cloud head** (plan job `where: cloud`): Codex first, because it reports status and diffs. Hydra polls, applies the diff to the job's branch, then runs gates and cross-review locally before it can land. Claude cloud heads wait until its CLI reports status.

## Security for new surfaces
- **Renderer:** context isolation, sandbox, no Node integration, strict CSP with no remote scripts, no `webview` tag, navigation blocked. External links need a confirm, then `shell.openExternal`.
- **Untrusted output:** render model and tool output as sanitized markdown, no raw HTML. Draw approval cards only from structured requests. S1 checks that a model calling `approve` itself can be detected and denied.
- **IPC:** the preload exposes a fixed, typed call set; main validates every message, as `parseMessage` does today.
- **Chat logs:** local, with a user-only access list like handshakes. The redactor covers diagnostics and evidence, not the chat.
- **Updates:** the IDE's check (SHA256SUMS, allowed hosts) with the app's own asset. Unsigned until HR-14 is solved, like the IDE.

## Repo, build, release
- `app/` has its own `package.json` and lockfile: Electron, Monaco, xterm, node-pty rebuilt for its Electron. esbuild bundles `../src/core` and `../webview`. The root package and IDE build stay untouched.
- **CI:** new Windows workflow `app.yml` on `app/**`, `src/core/**`, `webview/**`: typecheck, unit tests, build, and a smoke test that launches the app, chats with stub CLIs, approves and stops.
- **Release:** versions in lockstep with the IDE. One release carries `HydraSetup.exe` and `HydraAppSetup.exe`, with one `SHA256SUMS` for both. `installerName` in `updateCheck.ts` becomes per product; `scripts/install.ps1` gains `-App`. App builds stay prereleases until P4, because `releases/latest` skips prereleases, so IDE users keep getting the IDE.

## Phases
| # | What | Done when |
| --- | --- | --- |
| S | S1: Claude chat on the current CLI (approval route, questions and plan approval, images, model-made `approve` calls). S2: Codex app-server chat. S3: cloud CLIs on Windows (teleport, status). S4: node-pty in Electron. | A short result note per spike in this file |
| P1 | Host split: `HydraController` and `Host`; the IDE runs on it | IDE tests and desktop smoke green, no behaviour change |
| P2 | App shell and local chat, Claude then Codex: stream, approvals, stop, resume, diffs | One person uses it daily |
| P3 | Orchestration: lead tools, heads, plans, gates, lanes, canvas, limit handoff | The benchmark harness runs a plan through the app |
| P4 | Ship: IDE release with the "Hydra IDE" rename and shortcut handover first, then the app's installer, updater, release job, docs, THREAT_MODEL entries | Install, upgrade, uninstall tests pass; prerelease out |
| P5 | Cloud chats, then Codex cloud heads | A cloud job lands only after local gates pass |

## Decisions
- **Names (decided):** the app is "Hydra", the IDE is "Hydra IDE" (display only; see Naming).
- **Installer (decided):** Inno Setup, like the IDE: per-user install without admin, uninstall that removes only this install's Claude and Codex entries and asks before deleting data (`/HYDRAREMOVEDATA`), and the in-app update mode. Adapt the IDE's scripts in `desktop/*.iss` and its installer, upgrade and uninstall tests.
- **D1 (open):** ask Anthropic, through the contact link on the legal page: (a) does a free, open-source app on the user's own PC, driving the user's own unmodified Claude Code, need their Commercial Terms? (b) do parallel heads and unattended plans count as "ordinary, individual usage" of a Pro or Max plan? This covers the IDE too.
- **D2 (open):** whether the quality benchmark (`bench/QUALITY_RUN.md`) changes P3's priorities.

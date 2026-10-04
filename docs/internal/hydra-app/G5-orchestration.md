# G5: Hydra in the app

**Goal:** everything Hydra adds, inside the app. Chats are leads with Hydra's tools, and heads, plans, gates, lanes, packs, limit handoff, the canvas and settings all work. The app shares storage and ownership with the IDE.

**Needs:** G2 (the controller and `Host`) and G4. **Runs on:** Windows.

## Shape
- **`app/src/main/host.ts`:** `ElectronHost` implements G2's `Host`:
  - Dialogs and the review pane go through the renderer. Terminals open as lanes or a console.
  - Settings use G3's store.
  - The storage root is the IDE's global storage, `%APPDATA%\Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager`, created if missing.
  - The app root comes from G1's node-pty approach.
  - The window's process ids are the app's main process.
- **The app build bundles** `src/hydraMcp.ts` to `hydra-mcp.cjs` and `src/hydraCli.ts` to `hydra-cli.cjs`, beside the app.
- **Lead tools, as in the IDE:** a chat's bridge finds the app through discovery, and `src/core/leadVerification.ts` accepts it because its chain reaches the app's main process. Heads stay refused as leads.

## Milestones (one PR each, in order)
1. **Controller boot:** `ElectronHost`, the controller's `start` and `shutdown`, the shared storage root, ownership locks, discovery records and the endpoint. `hydra status` in a folder the app owns reports the app.
2. **Registration and lead tools:** the Connectors settings page registers `hydra` with the app's executable, `ELECTRON_RUN_AS_NODE=1`, its `hydra-mcp.cjs` and the shared `HYDRA_HELPERS_DIR`. It repairs the entry only when the current target is missing, so the IDE and the app never take turns rewriting it. Chats get lead tools, and head and plan cards appear inline in the chat.
3. **Canvas, plans and gates:** the Agents view renders `webview/AgentsCanvas.tsx` through the bridge. Plans work from the chat and the canvas, including gates, screenshots, review, evidence, Merge plan and Open PR.
4. **Lanes and limits:** the lanes grid (xterm and node-pty), Send to lane, Preview app; the usage-limit offer to continue in the other provider (`src/core/limitHandoff.ts`); Stop All and Resume; the audit log.
5. **Settings and parity:** every settings page from G2, packs review and enable, and Show All Projects. Add a parity table to the Result: each IDE Hydra feature marked works, differs (and why) or missing (and why).

## Local checks per PR
Root `npm run check` and `npm test`; `npm --prefix app run check`, `test`, `build` and `smoke`.

## Acceptance
- [x] App smoke with stand-ins: a chat calls a lead tool, a head starts in a worktree, its gates run, and a result card shows in the chat and the canvas.
- [x] A plan with stand-ins lands on its integration branch, and Merge plan merges it.
- [x] A coexistence test passes. A repository the IDE owns is refused by the app, and the reverse. `hydra` reaches the owner. The registration isn't rewritten while its target exists.
- [x] Lead verification tests pass: a chat-started bridge is accepted, and a head-started one is refused.
- [x] Live on Nico's machine: the benchmark's `hydra` step runs `shop` / `discounts` (`--usd 30`: Hydra refuses a $5 budget for this 6-job plan) with the app owning the folder, opened by hand. Evidence in the Result.
- [x] THREAT_MODEL covers the app's endpoint, discovery, lead verification and registration repair.
- [x] The parity table is complete.

## Parity table (milestone 5)

Every Hydra IDE feature (docs/Features.md, docs/Heads.md), as the Hydra app has it after G5. **Works**: the same core code, shown in the app. **Differs**: it works, but not as in the IDE (why given). **Missing**: not in the app (why given, and when).

| IDE feature | App | Notes |
| --- | --- | --- |
| Connecting Claude Code and Codex (Settings → Connectors) | Works | The app's own Settings → Connectors (Connect, Use this app, Repair, Disconnect) and Hydra Settings → Connectors, the IDE's page. Repair follows G5's rule: another install's entry is kept while it reaches this Hydra. |
| What the agents can do (lead tools, heads, plans from a chat) | Works | A chat's CLI gets Hydra's bridge; lead verification by the process chain, as in the IDE; head and plan cards inline in the chat. |
| Head lifecycle: nobody answers, a silent head, waiting on the provider | Works | The controller's own; Answer is the window's text box. |
| Limits and permissions (worktrees, budgets, head sandbox) | Works | The same `HelperService` and head sandbox. |
| When a provider hits its limit (offer to continue in the other) | Works | Offers are in-window notices with their buttons; the handoff opens in the viewer. |
| Gates, screenshots, review, evidence | Works | Evidence opens in the window's viewer with its screenshots inlined (HSEC-93). |
| The Agents view: canvas, plans, Merge plan, Open PR, Run integration gate | Works | The IDE's own canvas (`webview/AgentsBody.tsx`) in the title bar's Agents mode. |
| Lanes: terminals, Send to lane, Preview app, Review changes, a lane's gates | Works | node-pty is the app's own dependency. Preview opens the user's browser, as the IDE does without Simple Browser. Review changes is a unified diff in the viewer, not VS Code's multi-diff editor. |
| All projects | Works | The Agents toolbar's All projects; choosing another of the app's projects opens it in the app, and one Hydra IDE has open says so. |
| Hydra's notifications | Differs | In-window toasts in the app's style, not the IDE's notification cards; same messages and actions. |
| Folders you haven't trusted | Differs | The app's own folder trust (G4), confirmed in main's dialog; Hydra runs nothing in an untrusted project. |
| Packs: review, turn on, gates | Works | Hydra Settings → Packs, the IDE's page, in its own window. |
| The `hydra` command, plan files, the user role and handshake | Works | `hydra` finds whichever window owns the folder, the app's or the IDE's (G5 milestone 1). |
| Stop all agents and Resume | Works | The Agents toolbar and a "stopped" banner; Hydra Settings → Heads too. The app's stop switch is its own per project, not the IDE's `workspaceState`: a Stop all in the IDE isn't seen by the app. |
| The audit log | Works | The Agents toolbar's Audit log, read-only in the viewer; it's Hydra's one shared log. |
| Hydra Settings: Connectors, MCP servers, Heads, Gates, Packs, Docs | Works | The IDE's own pages over G2's bridge (HSEC-95). Hydra's settings are the app's own store, not the IDE's VS Code settings. |
| Hydra Settings → General: editor settings, keyboard shortcuts, Chat location, Window layout, importing preferences | Differs | Editor-only. Editor settings, keyboard shortcuts and Chat location refuse with a reason; Window layout saves its choice, which the app doesn't use (it opens in Chat; choosing Editor also says the editor's layout isn't the app's); importing shows as unavailable. Accounts and onboarding open the app's own Settings. |
| Hydra Settings → Appearance | Differs | The page's Dark or Light saves to Hydra's store and says it applied, but the app's theme is its own (the app's Settings → Theme), which the settings window follows; icon themes are the editor's. The UI pass replaces this page in the app. |
| Agent Manager / Editor switch, activity bar, chat panels | Differs | The app has no editor: its Chat and Agents modes take their place. |
| Provider usage limits view | Missing | The quota service runs (limit offers use it), but its own view isn't in the app yet: the UI pass (UI-direction.md) adds it. |
| Handoff workspaces (`.code-workspace` for a worktree) | Missing | A VS Code workspace has no meaning in the app; a handoff's Markdown opens in the viewer instead. |
| Importing preferences from another editor | Missing | Editor preferences don't apply to the app. |
| One-time offers that need actions (packs review, starter gates) | Works | Since milestone 3 they're in-window notices with their actions. |
| Provider checks and usage of `hydra.claudePath` / `codexPath` | Differs | The app's own CLI paths (Settings → Your agents), machine-only as in the IDE. |

## Result (2026-10-04)

Five PRs, one per milestone: [#308](https://github.com/ndunl075/hydra/pull/308) (controller boot), [#309](https://github.com/ndunl075/hydra/pull/309) (registration and lead tools), [#310](https://github.com/ndunl075/hydra/pull/310) (the Agents view, plans and gates), [#311](https://github.com/ndunl075/hydra/pull/311) (lanes and limits) and [#312](https://github.com/ndunl075/hydra/pull/312) (settings and parity). Their reviews and fixes are in each PR body. Every box is checked.

**Acceptance evidence:**
- **App smoke and plans with stand-ins:** `app/smoke/run.mjs`, 26 checks, including `a chat calls a lead tool: a head starts in a worktree, its gate runs, and its card shows in the chat and on the canvas` and `a plan with stand-ins lands on its integration branch, its gate passes, and Merge plan merges it`. They pass in the App workflow on every app change, for example the `app` job of run [37218679365](https://github.com/ndunl075/hydra/actions/runs/37218679365).
- **Coexistence:** `coexistence: a repository the app owns is refused by another Hydra, and one another Hydra owns is refused by the app` (`app/tests/hydra.test.ts`); `hydra` reaches the owner (the smoke's check that opening a chat starts its project's controller and that `hydra status` there reports the app); the registration isn't rewritten while its target exists (`another Hydra's entry is left alone while it reaches this one, and repaired otherwise (G5)` and the usage-limit hook's twin, `tests/helperRegistration.test.ts`). G6 added installer-level coexistence (`scripts/coexistence-test.ps1`).
- **Lead verification:** `lead verification in the app: a chat's bridge is a lead; a bridge inside any project's head is refused in every project` (`app/tests/hydra.test.ts`) and the smoke's `a chat's lead tools: …`.
- **THREAT_MODEL:** HSEC-91 (endpoint, discovery, ownership, lead verification), HSEC-92 (registration repair and lead tools), HSEC-93 to HSEC-95 (the Agents view, lanes, settings), each naming its tests, which `app/tests/threatModel.test.ts` checks exist.
- **Parity table:** above, every IDE feature from `docs/Features.md` and `docs/Heads.md`.

**The live check (2026-10-04, Nico's machine):**
- **Setup:** `node scripts/benchmark.mjs prepare` made `.bench/run-2026-10-04T18-17-32-359Z`. Nico opened its `hydra` folder in the app (`npm --prefix app run dev`), trusted it and opened a chat, and `hydra status` reported "Hydra window 35436 owns …" (the app's process). Then `node scripts/benchmark.mjs hydra --repo .bench/run-2026-10-04T18-17-32-359Z/hydra --usd 30` ran through the installed IDE's `hydra` command, which reached the app.
- **Result:** plan `df26be595ef7`, state `done`. Hydra ran the 6 jobs as one head (a dependency chain of 3). Working code at 120 s (the harness's hidden check), 163 s wall clock. The integration gate passed (`test`, and a rigor review by Codex), with no fix rounds. Claude Code reported $0.36. It landed on `hydra/plan-df26be595ef7` (`0a482f3`).
- **The budget:** G5 said `--usd 5`, but Hydra refuses a budget that 6 jobs at up to $5 each could exceed, so the smallest it accepts is $30. Nothing ran under $5.
- **Two app bugs it found (follow-ups):**
  - A project trusted before its first chat didn't start Hydra when that chat was reopened in the same app session. It started after the app was restarted.
  - Hydra in the app finds `claude` and `codex` only on the PATH the app inherited, through the controller's `findProvider`, while the app's own chats found them fine. Started from a shell whose PATH lacks `%USERPROFILE%\.localin`, a head failed: "Claude Code CLI not found". It should use the same lookup as chats, or the app's Settings → Command-line tools.

**Differs from the IDE, in short** (details in the parity table): Stop all is per project in the app and isn't shared with an IDE window's; the provider usage-limits view isn't in the app yet (the quota service runs); editor-only settings refuse with a reason; notices are the app's own toasts.

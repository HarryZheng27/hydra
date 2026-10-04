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
- [ ] App smoke with stand-ins: a chat calls a lead tool, a head starts in a worktree, its gates run, and a result card shows in the chat and the canvas.
- [ ] A plan with stand-ins lands on its integration branch, and Merge plan merges it.
- [ ] A coexistence test passes. A repository the IDE owns is refused by the app, and the reverse. `hydra` reaches the owner. The registration isn't rewritten while its target exists.
- [ ] Lead verification tests pass: a chat-started bridge is accepted, and a head-started one is refused.
- [ ] Live on Nico's machine: the benchmark's `hydra` step runs `shop` / `discounts` (`--usd 5`) with the app owning the folder, opened by hand. Evidence in the Result.
- [ ] THREAT_MODEL covers the app's endpoint, discovery, lead verification and registration repair.
- [ ] The parity table is complete.

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
| All projects | Works | The Agents toolbar's All projects; choosing another of the app's projects opens it in the app. |
| Hydra's notifications | Differs | In-window toasts in the app's style, not the IDE's notification cards; same messages and actions. |
| Folders you haven't trusted | Differs | The app's own folder trust (G4), confirmed in main's dialog; Hydra runs nothing in an untrusted project. |
| Packs: review, turn on, gates | Works | Hydra Settings → Packs, the IDE's page, in its own window. |
| The `hydra` command, plan files, the user role and handshake | Works | `hydra` finds whichever window owns the folder, the app's or the IDE's (G5 milestone 1). |
| Stop all agents and Resume | Works | The Agents toolbar and a "stopped" banner; Hydra Settings → Heads too. The app's stop switch is its own per project, not the IDE's `workspaceState`: a Stop all in the IDE isn't seen by the app. |
| The audit log | Works | The Agents toolbar's Audit log, read-only in the viewer; it's Hydra's one shared log. |
| Hydra Settings: Connectors, MCP servers, Heads, Gates, Packs, Docs | Works | The IDE's own pages over G2's bridge (HSEC-95). Hydra's settings are the app's own store, not the IDE's VS Code settings. |
| Hydra Settings → General: editor settings, keyboard shortcuts, Chat location, Window layout, importing preferences | Differs | Editor-only. Each says so when used; importing shows as unavailable. Accounts and onboarding open the app's own Settings. |
| Hydra Settings → Appearance | Differs | Dark or Light follows the app's own theme setting (its Settings); the IDE's page can't change the app's theme, and icon themes are the editor's. |
| Agent Manager / Editor switch, activity bar, chat panels | Differs | The app has no editor: its Chat and Agents modes take their place. |
| Provider usage limits view | Missing | The quota service runs (limit offers use it), but its own view isn't in the app yet: the UI pass (UI-direction.md) adds it. |
| Handoff workspaces (`.code-workspace` for a worktree) | Missing | A VS Code workspace has no meaning in the app; a handoff's Markdown opens in the viewer instead. |
| Importing preferences from another editor | Missing | Editor preferences don't apply to the app. |
| One-time offers that need actions (packs review, starter gates) | Works | Since milestone 3 they're in-window notices with their actions. |
| Provider checks and usage of `hydra.claudePath` / `codexPath` | Differs | The app's own CLI paths (Settings → Your agents), machine-only as in the IDE. |

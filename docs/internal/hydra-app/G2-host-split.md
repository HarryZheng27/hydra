# G2: Split the IDE's controller from VS Code

**Goal:** move the logic in `src/extension.ts`'s `Manager` class, and the other pieces the app needs, behind a `Host` interface, so the IDE and the app run the same controller. **The IDE's behaviour must not change at all.** Move code; don't rewrite it.

**Needs:** nothing. **Runs on:** any machine; CI's Windows desktop workflow covers Windows.

## Shape
- `src/host/host.ts`: the `Host` interface, grown only as moved code needs it: notify, confirm, pick folder, open file, open diff, open terminal, clipboard, open URL, settings (get, set, on change; machine-only keys stay machine-only), paths (storage root, app root for node-pty, dist root for `hydra-mcp.cjs`), folder trust, the process ids whose descendants count as this window (`src/core/leadVerification.ts`), post to UI, log.
- `src/host/controller.ts`: `HydraController`, the moved `Manager` logic: `start()`, `shutdown()`, `handle(message)`, `publish()`.
- `src/vscodeHost.ts`: `VsCodeHost`, the IDE's implementation. `src/extension.ts` keeps activation, commands, the webview panel and the IDE-only features.
- `tests/host/fakeHost.ts`: `FakeHost` for tests.
- **Stays IDE-only:** settings import, tree views, chat location, official-extension handoff, onboarding walkthrough, workbench notices, the IDE's installer update.

## Milestones (one PR each, in order)
1. **Host and bridge:** `Host`, `VsCodeHost`, `FakeHost`. In `webview/index.tsx`, replace `acquireVsCodeApi` with an injected bridge (`window.hydraBridge`, else a VS Code shim); the message protocol is unchanged. Add `tests/hostBoundary.test.ts`, which fails if `src/core/**` or `src/host/**` imports `vscode` or `electron`.
2. **Canvas and plans:** `publish`, head views, canvas plan actions (`newPlan` through `planCancelJob`), plan reports, the plan runner and the `handle` dispatch move to the controller. `Manager` forwards to it.
3. **Lead and board bridges:** `createPlanLeadBridge`, `createPlanBoardBridge` and their methods.
4. **Lifecycle:** `initialize` (ownership locks, discovery records, endpoint, lead verification), `startHelpers`, limit detection, the packs watcher, starter gates, project summary, helper connections and registration (`connectHelpers` and the rest), stop and resume, `shutdown`.
5. **Lanes:** `src/extensionLanes.ts`'s host-agnostic part becomes a lanes controller, loading node-pty through `Host` paths.
6. **Settings:** `src/settings/shell.ts` and every page in `src/settings/pages/` route through `Host`, so the app can render them.
7. **The rest the app needs:** limit offer and limits (`extensionLimitOffer.ts`, `extensionLimits.ts`), quota, accounts, packs.

Before each PR, merge `main` and move the smallest coherent unit. Other agents edit `src/extension.ts` too, so land each PR fast.

## Local checks per PR
`npm run check`, `npm run build`, `npm test`, `npm run test:smoke`. CI adds `package` and the Windows desktop workflow.

## Acceptance
- [x] Nothing under `src/core/` or `src/host/` imports `vscode` or `electron`; the boundary test enforces it. `tests/hostBoundary.test.ts` follows imports transitively from every file under `src/core`, `src/host` and `src/settings`, using TypeScript's own import scanner.
- [x] A `FakeHost` test runs the controller end to end with no VS Code: it opens a fixture repository, creates and runs a plan with the stand-in head executables existing tests use, and sees state published. That's `tests/controllerLifecycle.test.ts`. Its stand-in head is the in-process `startRun` that `tests/helperService.test.ts` uses.
- [x] `src/extension.ts` is under 500 lines: 490 after milestone 7 (`wc -l`).
- [x] Every PR is green on Check and the Windows desktop workflow (#290, #291, #292, #293, #295, #296, #297). One `build` run on #293 hit the gates suite's flaky headless-browser test and passed on re-run.
- [x] No user-visible change: same settings keys, same webview messages, same commands. The CHANGELOG is untouched. An independent read-only review of each PR checked this method by method.
- [x] Result notes any `Host` method G5 must implement differently (below).

## Result (2026-10-02)

Seven PRs, one per milestone: #290 (Host and bridge), #291 (canvas and plans), #292 (lead and board bridges), #293 (lifecycle), #295 (lanes), #296 (settings), #297 (the rest). Each had an independent read-only review. Codex was out of usage all day, so every review was a fresh Claude session; their findings and fixes are in each PR body.

**What exists now:**
- `src/host/host.ts`: `Host`. It grew milestone by milestone to these groups:
  - notifications, modal questions, text boxes and picks;
  - settings (Hydra's own, machine-only ones, and other sections) plus workspace and global state;
  - paths (storage, `dist`, app root, Hydra's own folder);
  - folders and trust, the window's process ids, file watchers, disposal on shutdown and closing the window;
  - installed extensions;
  - openers: files, text, URLs, folders, the in-app preview, Markdown, the multi-file diff with text sources;
  - the clipboard, progress, a terminal, commands by id, colour and icon themes, a folder picker and reveal in the file manager;
  - the version, remote and focus state, and posting to the UI.
- `src/vscodeHost.ts`: `VsCodeHost`. `tests/host/fakeHost.ts`: `FakeHost`.
- `src/host/controller.ts`: `HydraController`. It covers the Agents view's state and messages; plans, the plan runner, the lead's plan tools and the board; ownership, heads, the endpoint, discovery, handshakes, connections, Stop all and Resume; limits and the limit offer; Show All Projects; the first run; head actions and evidence; and its own commands (`registerCommands`).
- `src/host/lanes.ts`: the lanes controller.
- `src/host/quota.ts`, `accounts.ts`, `chatLimits.ts`, `limitOffer.ts` and `packs.ts`: the rest the app needs.
- `src/settings/`: Hydra Settings, host-agnostic. `src/extensionSettings.ts` shows it in an IDE panel.
- The Agents view (`webview/bridge.ts`) and the Settings page find their host through `window.hydraBridge`, else VS Code's webview API.

**What changed versus this file:**
- **Limit detection** moved in milestone 7, not 4, because it depended on `src/extensionLimits.ts`, which moved with the limits.
- **The controller** has `start()` and `shutdown()` as thin compositions for the app. The IDE calls the steps themselves (`acquireOwnership`, `startHelpers`, `startLimitDetection`, `startLimitOffer`, `stopHelpers`, `releaseOwnership`), because it checks its handoff between them. The controller also has `handle` and `publish`, as planned.
- **IDE-only work** goes through a second, narrower interface, `ControllerIde`. It covers the IDE's view parts and status bar, its tree, opening the Agents view, handoff state, Settings pages, the Accounts snapshot, the desktop flag, opening an official chat and the IDE-only webview messages.
- **Construction:** `Manager` still builds `StopSwitch`, `AuditLog`, `HeadSandbox`, the packs service, the lanes controller and the per-window storage key, and passes them in. Each is host-agnostic, so the app builds them the same way.
- **Quota and accounts** split into a host-agnostic service plus the IDE's panel, which keeps its HTML.

**Host methods G5 must implement differently:**
- `openFile`, `openText` and `openFileBeside`: the IDE first leaves the Agent Manager (it fills the window), then opens an editor tab. The app should open its own read-only viewer.
- `confirm`, `ask`, `pick`, `pickMany` and `input` are modal and native in the IDE. The app needs in-window equivalents that resolve to the same values: the button's text, the item, or undefined when dismissed.
- `command(id)`: the IDE runs VS Code commands. The controller's own are registered through `registerCommands` with Manager's error reporting, and settings pages call `hydra.*` and a few `workbench.*` commands. The app needs a registry for the `hydra.*` ids it supports, and can refuse the `workbench.*` ones.
- `section('workbench' | 'window')`, `colorTheme` and `iconThemes` are editor appearance. The app maps Dark / Light to its own theme and can return a single "None" icon theme.
- `extension(id)` and `installExtension`: the app has no editor extensions, so it returns undefined and refuses installs. Connect then registers the CLIs without installing an extension.
- `openChanges` and `registerTextSource` drive VS Code's multi-file diff. The app renders them in its Monaco review.
- `openPreview` opens Simple Browser in the IDE. The app can open its own sandboxed view, or return false so the lane offers the browser.
- `windowProcessIds` is the extension host and its parent in the IDE. In the app it must be the processes that start the agents' CLIs (the main process), or lead verification will refuse them.
- `paths.appRoot` must be where the app keeps node-pty, and `paths.extension` where `dist/` and the built-in `packs/` live.
- `openTerminal` opens an IDE terminal for Claude's own sign-in. The app needs a terminal pane (xterm with node-pty) that it never reads.
- `development` is the IDE's extension mode. The app should set it from its own dev or test flag, so a dev build never rewrites the user's own connections.

**Follow-ups:**
- `hydra.openEvidence`, the audit log viewer and the handoff window's official-extension actions are still IDE commands.
- `webview/index.tsx`'s messages are unchanged and still typed as `ClientMessage`.
- The README's Status and the plan's G2 paragraph are updated in this PR.

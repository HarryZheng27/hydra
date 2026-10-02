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
- [ ] Nothing under `src/core/` or `src/host/` imports `vscode` or `electron`; the boundary test enforces it.
- [ ] A `FakeHost` test runs the controller end to end with no VS Code: it opens a fixture repository, creates and runs a plan with the stand-in head executables existing tests use, and sees state published.
- [ ] `src/extension.ts` is under 500 lines.
- [ ] Every PR is green on Check and the Windows desktop workflow.
- [ ] No user-visible change: same settings keys, same webview messages, same commands. The CHANGELOG is untouched.
- [ ] Result notes any `Host` method G5 must implement differently.

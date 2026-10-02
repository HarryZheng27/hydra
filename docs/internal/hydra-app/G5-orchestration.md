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

# G3: App foundation

**Goal:** a real but empty Hydra app: a secure Electron shell with Hydra's look and its own identity, plus build and CI, ready for chat. Nothing talks to a provider yet, apart from version checks.

**Needs:** G1's S4 decisions (Electron version, CSP, fuses). **Runs on:** Windows.

## Shape
```
app/package.json        name hydra-app, productName Hydra, own lockfile
app/build.mjs           esbuild: main, preload, renderer; bundles ../src/core and ../webview when used
app/src/main/           main.ts, identity.ts, window.ts, ipc.ts, settings.ts, security.ts
app/src/preload/        preload.ts: contextBridge exposing a typed, allowlisted API
app/src/renderer/       React UI
app/src/shared/ipc.ts   channel names, payload types and validators
app/tests/, app/smoke/
.github/workflows/app.yml
```
**Identity** (`identity.ts`, one source of truth): product name "Hydra"; user data `%APPDATA%\Hydra App`; AppUserModelId `Hydra.App`; single-instance lock `hydra-app`. Nothing may resolve to the IDE's `%APPDATA%\Hydra`, except the shared storage root G5 adds on purpose.

## Milestones (one PR each, in order)
1. **Skeleton:** the package, build, window, identity, single instance (a second launch focuses the first), and `app.yml` on `windows-2022`. It triggers on `app/**`, `src/core/**`, `src/host/**`, `webview/**` and itself, and runs root `npm ci`, `npm ci --prefix app`, then `check`, `test`, `build` and `smoke` in `app/`.
2. **Security baseline:** context isolation, sandbox, no Node integration, no `webview` tag, G1's CSP, `will-navigate` blocked, a `setWindowOpenHandler` that denies and sends http(s) links through a confirm to `shell.openExternal`, and IPC that rejects unknown channels and invalid payloads in main. Add a "The Hydra app (unreleased)" section to `docs/THREAT_MODEL.md` with an HSEC entry and a named test for each control.
3. **UI shell:** a title bar with a sidebar toggle and a Chat / Agents switch (Agents disabled until G5). A sidebar with New chat, search, projects with their chats, and Settings. An empty state with a folder picker. Hydra Dark and Light, using the colors in `themes/hydra-dark.json` and `hydra-light.json`, with a Dark, Light or System setting. A settings store in user data, written with `src/core/atomicFile.ts` and schema-checked. CLI paths are machine-only, never read from a project.
4. **Onboarding:** detect `claude` and `codex` with core's checks (`src/core/diagnostics.ts`, `cliSelfCheck.ts`, `cliVersions.ts`) and show version and support. **Sign in** opens a console window running the CLI's own login and reads nothing back. Show whether the `hydra` MCP registration exists, read-only (`src/core/helperRegistration.ts`).

## Local checks per PR
`npm --prefix app run check`, `npm --prefix app test`, `npm --prefix app run build`, `npm --prefix app run smoke`; root `npm run check` and `npm test`.

## Acceptance
- [ ] On Windows, `npm --prefix app run dev` opens Hydra, and a second launch focuses it.
- [ ] App smoke is green in CI. It asserts the hardened web preferences, the CSP, that an unknown IPC channel is refused, that user data is under `Hydra App`, and single instance.
- [ ] The root Check and Windows desktop workflows are unaffected, apart from the new workflow.
- [ ] The THREAT_MODEL section lists every control from milestone 2, each with its test.
- [ ] No provider process starts, except the version and help checks.

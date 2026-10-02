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
**Identity** (`identity.ts`, one source of truth): product name "Hydra"; user data `%APPDATA%\Hydra App`; AppUserModelId `Hydra.App`; the single-instance lock, which Electron keys on the user-data folder (G1), so set user data first, as main's first statement. Nothing may resolve to the IDE's `%APPDATA%\Hydra`, except the shared storage root G5 adds on purpose. A test proves it; G1's spike wrote into the IDE's folder before it set user data.

## Milestones (one PR each, in order)
1. **Skeleton:** the package, build, window, identity, single instance (a second launch focuses the first), and `app.yml` on `windows-2022`. It triggers on `app/**`, `src/core/**`, `src/host/**`, `webview/**` and itself, and runs root `npm ci`, `npm ci --prefix app`, then `check`, `test`, `build` and `smoke` in `app/`.
2. **Security baseline:** context isolation, sandbox, no Node integration, no `webview` tag, G1's CSP, `will-navigate` blocked, a `setWindowOpenHandler` that denies and sends http(s) links through a confirm to `shell.openExternal`, and IPC that rejects unknown channels and invalid payloads in main. Add a "The Hydra app (unreleased)" section to `docs/THREAT_MODEL.md` with an HSEC entry and a named test for each control.
3. **UI shell:** a title bar with a sidebar toggle and a Chat / Agents switch (Agents disabled until G5). A sidebar with New chat, search, projects with their chats, and Settings. An empty state with a folder picker. Hydra Dark and Light, using the colors in `themes/hydra-dark.json` and `hydra-light.json`, with a Dark, Light or System setting. A settings store in user data, written with `src/core/atomicFile.ts` and schema-checked. CLI paths are machine-only, never read from a project.
4. **Onboarding:** detect `claude` and `codex` with core's checks (`src/core/diagnostics.ts`, `cliSelfCheck.ts`, `cliVersions.ts`) and show version and support. **Sign in** opens a console window running the CLI's own login and reads nothing back. Show whether the `hydra` MCP registration exists, read-only (`src/core/helperRegistration.ts`).

## Local checks per PR
`npm --prefix app run check`, `npm --prefix app test`, `npm --prefix app run build`, `npm --prefix app run smoke`; root `npm run check` and `npm test`.

## Acceptance
- [x] On Windows, `npm --prefix app run dev` opens Hydra, and a second launch focuses it. `scripts/dev.mjs` starts the same built bundle the smoke runs. The smoke launches it twice on Windows: the second launch exits 0, opens no window, and the first instance gets `second-instance` and calls `focus` (`'a second launch focuses the first and exits'`). See the Result for the visible check.
- [x] App smoke is green in CI. It asserts the hardened web preferences, the CSP, that an unknown IPC channel is refused, that user data is under `Hydra App`, and single instance. The **App** workflow passed on every PR and on `main` after each merge, for example [the run after #299](https://github.com/ndunl075/hydra/actions/runs/37073321887). Its checks: `'windows are hardened: context isolation, sandbox, no Node, no webview tag'`, `'every app:// response carries the G1 CSP'`, `'main refuses an unknown IPC channel, an unknown call and an invalid payload'`, `'user data is under Hydra App, never the IDE Hydra folder'` and `'a second launch focuses the first and exits'`.
- [x] The root Check and Windows desktop workflows are unaffected, apart from the new workflow. Check (`build`) passed on #298 to #301 with no change to root `src/`, `tests/` or the root package. The only root-level edits are `.vscodeignore` (`app/**`, so the IDE package is unchanged), CONTRIBUTING and docs. None of them is in the Windows desktop workflow's paths, so it didn't run.
- [x] The THREAT_MODEL section lists every control from milestone 2, each with its test: "The Hydra app (unreleased)", HSEC-73 to HSEC-79, plus HSEC-80 (stores) and HSEC-81 (onboarding). `app/tests/threatModel.test.ts` fails if a test a row names doesn't exist.
- [x] No provider process starts, except the version and help checks. Stand-in `claude.cmd` and `codex.cmd` log every call, and the smoke asserts the log holds only `--version`, `--help` and `app-server --help` (`'no provider process starts except the version and help checks'`). Sign in opens the CLI's own login only when the user clicks it.

## Result (2026-10-02)

Four PRs, one per milestone: [#298](https://github.com/ndunl075/hydra/pull/298) (skeleton), [#299](https://github.com/ndunl075/hydra/pull/299) (security baseline), [#300](https://github.com/ndunl075/hydra/pull/300) (UI shell) and [#301](https://github.com/ndunl075/hydra/pull/301) (onboarding). Each had an independent read-only review in a fresh Claude session; their findings and fixes are in each PR body. Every high finding was fixed: #300's store could overwrite `state.json` after a Windows sharing lock. A second, focused review confirmed that fix.

**What exists now (`app/`):**
- **The package:** `hydra-app`, productName Hydra, Electron 44.5.1 pinned exactly, its own lockfile. `build.mjs` bundles main, a self-contained sandboxed preload and the React renderer with esbuild, along with what they use from `../src/core` and `../themes`.
- **Main:**
  - `identity.ts`: user data, session data, logs and crash dumps under `%APPDATA%\Hydra App`, set as main's first statement, and AppUserModelId `Hydra.App`. Main refuses to start if any of them is outside `Hydra App`.
  - `startup.ts`: single instance; a second launch focuses the window.
  - `security.ts`: `app://hydra/` serving, G1's CSP header, and guards for every webContents and session.
  - `ipc.ts`: one transport channel, with sender, channel and payload checks.
  - `settings.ts`: the schema-checked JSON stores, written through core's `replaceAtomic`, which never overwrite a file they couldn't read.
  - `handlers.ts`: what each channel does.
  - `onboarding.ts`: detection, registration lookup and sign-in.
- **Renderer:**
  - the title bar, with the sidebar toggle and Chat / Agents (Agents disabled);
  - the sidebar: New chat, search, projects with "No chats yet", and Settings;
  - an empty state with a folder picker;
  - Settings: the theme, CLI paths, and the agents panel;
  - Hydra Dark and Light, from `themes/hydra-*.json`.
- **Tests:** 46 unit tests (`npm --prefix app test`). The smoke (`npm --prefix app run smoke`) runs 15 checks against the built app, hidden, with a scratch AppData, stand-in CLIs and scratch Claude and Codex config folders. `--smoke-shots=<dir>` saves screenshots.
- **CI:** `.github/workflows/app.yml` on `windows-2022`, with the triggers and steps this file names.

**What changed versus this file:**
- **Onboarding doesn't call `cliSelfCheck.ts`.** Its Claude half starts `claude -p` and sends `initialize`, which isn't a version or help check, so acceptance rules it out. Onboarding uses `diagnostics.ts` (`--version`, `--help`, Codex's `app-server --help`) and `cliVersions.ts`. **G4** runs the self-check before a chat starts.
- **Settings and state are two stores,** `settings.json` (theme, CLI paths) and `state.json` (sidebar, projects), so a broken one never costs the other.
- **CLI paths and project folders come only from main's own pickers.** No IPC payload carries a path or a command; a structural test tries hostile values in every field (HSEC-80).
- **Security beyond milestone 2's list:**
  - downloads refused in every session;
  - every session guarded, including later partitions;
  - `will-frame-navigate` blocked;
  - only an IPC sender's main frame accepted;
  - one external-link confirm per window, with a length cap.
- **Not added yet:** Monaco, xterm and node-pty, which the plan lists for `app/`. G3 needed none of them; G4 and G5 add them under G1's decisions (prebuilt node-pty, never rebuilt).
- **Fuses** are set when the app is packaged, in G6. The threat-model section records G1's choice.
- **The core `Thenable`:** a few `src/core` signatures name VS Code's global `Thenable`. The app declares the same shape in `app/src/types/core-globals.d.ts` so it can type-check core without `@types/vscode`.

**The visible check:** every run in this goal was hidden (the smoke records `show` and `focus` instead of performing them), so no window opened on Nico's machine. The behaviour is proven on Windows, locally and in CI, but nobody has yet watched `npm --prefix app run dev` open the window and come forward on a second launch. That takes about a minute, whenever the machine is free:
```
npm ci --prefix app
npm --prefix app run dev
npm --prefix app run dev   # in a second terminal: the first window comes forward, and this one exits
```

**Follow-ups:**
- **G4:**
  - run `cliSelfCheck` before a chat;
  - launch a `.cmd`/`.bat` CLI path the user picked with care (cmd re-parses arguments);
  - put chats under the sidebar's projects;
  - add Monaco and xterm under the CSP already in place (its Trusted Types names cover them).
- **G5:** implement `Host` for the app, using G2's list of methods that differ. The shared storage root is the one deliberate exception to "nothing in `%APPDATA%\Hydra`", and `identity.test.ts`'s scan of the IDE folder must allow it.
- **G6:** fuses, the installer, and the mutex or Restart Manager choice.
- **Stores:** a `state.json` from a newer schema (after a downgrade) is moved aside, not read, so its projects need restoring by hand.

# G6: Ship

**Goal:** the IDE becomes "Hydra IDE" and hands over the "Hydra" name. Then the app gets an installer, updates and a release path, ready for Nico to publish. **Never publish a release:** Nico triggers releases.

**Needs:** G5. Milestone 1 needs nothing and may run any time; it must ship in an IDE release before the app's first preview. **Runs on:** Windows.

## Milestones (one PR each, in order)
1. **IDE rename and shortcut handover:**
   - Set `nameLong` to "Hydra IDE", changing it only through `scripts/desktop.mjs` and `desktop/*.iss` (`CONTRIBUTING.md`: no patches folder). Keep `nameShort`, `dataFolderName`, the AppId, `win32AppUserModelId` (so taskbar pins survive), `win32RegValueName` and `HydraSetup.exe`.
   - An upgrade removes the old `Hydra.lnk` shortcuts and creates "Hydra IDE" ones.
   - A later uninstall must leave the app's `Hydra.lnk` alone, even though Inno's uninstall log remembers the old shortcuts. One option is `UninstallLogMode=new` on this release; prove whichever fix with a test.
   - Update `scripts/desktop-installer-test.ps1` and `desktop-upgrade-test.ps1`, the docs ("Hydra IDE"), and a CHANGELOG line.
2. **App package and installer:**
   - Package the app with G1's fuses.
   - Claude, Codex and Claude's hook run `hydra-mcp.cjs`, `hydra-cli.cjs` and `hydra-limit-hook.cjs` by path. Unpack them from the asar (`asarUnpack`), and point the registration at the unpacked copies. Prove it with a packaged-build test: the registered bridge answers.
   - node-pty (an app dependency since G5 milestone 4) must be unpacked too, and its root found in a packaged app: `startup.ts` passes `path.dirname(distDir)` as `appRoot`, which inside an asar is `resources/app.asar`, while `ptyCandidates` looks for `node_modules.asar.unpacked` beside it. Prove a lane's terminal starts in the packaged build.
   - `app/installer/hydra-app.iss` adapts `desktop/hydra-wizard.iss`, `hydra-uninstall.iss` and `hydra-update-mode.iss`: a new AppId GUID, a per-user install with no admin, `%LOCALAPPDATA%\Programs\Hydra App`, "Hydra" shortcuts, AppUserModelId `Hydra.App`.
   - The uninstaller runs the app's own uninstall helper, like `src/uninstall.ts`, which removes only this install's Claude and Codex entries.
   - `/HYDRAREMOVEDATA` asks, then removes `%APPDATA%\Hydra App`. It removes the shared storage root only when the IDE isn't installed.
3. **Updates:** `installerName` in `src/core/updateCheck.ts` becomes per product; the IDE's behaviour is unchanged and tested. The app's in-app update downloads, checks its `SHA256SUMS-app`, asks, and runs its installer in update mode. It's on only for stable releases; previews don't update themselves.
4. **Release pipeline:**
   - **Versions in lockstep:** `app/package.json` follows the root version, and a test enforces it.
   - **Previews:** a release job in `app.yml` publishes `v<version>-app.<n>` as a prerelease with `HydraAppSetup.exe`, `SHA256SUMS-app` and an attestation (in its own `app-preview.yml`, since a workflow another one calls can't hold write permissions). `releases/latest` skips prereleases, and the IDE's updater ignores suffixed versions, so IDE users keep getting the IDE.
   - **Stable:** `desktop.yml`'s release job also builds `HydraAppSetup.exe`. `SHA256SUMS` keeps exactly `HydraSetup.exe`'s line, because every installed IDE's updater and `scripts/install.ps1` refuse a second line; the app's installer gets its own one-line `SHA256SUMS-app` (decided with Nico, 2026-10-03). `scripts/install.ps1` gains `-App`.
   - **Dry run:** a manual run with no release tag only builds and uploads artifacts, as `desktop.yml` already does.
5. **Docs and coexistence:** the README covers both products and which to download; a new `docs/App.md` user guide; `docs/Releases.md`; THREAT_MODEL entries for the app's installer and update path; CHANGELOG. Add Windows tests for app install, upgrade and uninstall, and a coexistence test: install both, uninstall each in turn, and the other keeps its shortcuts, registration and shared data.

## Local checks per PR
Root `npm run check` and `npm test`; `npm --prefix app run check`, `test` and `build`. Installer tests run in CI on disposable Windows runners.

## Acceptance
- [x] IDE upgrade from a release (the pinned v0.24.2 until `package.json` passes 0.27.1; see the Result): shortcuts say "Hydra IDE", the old `Hydra.lnk` is gone, settings and data are intact, the in-app update still finds `HydraSetup.exe`, and a later uninstall leaves a planted `Hydra.lnk` alone.
- [x] App install, upgrade and uninstall pass on a disposable runner, with no admin prompt.
- [x] The coexistence test passes in both uninstall orders.
- [x] A dry run builds and uploads both installers. A test checks that the release jobs write `SHA256SUMS` (the IDE's one line) and `SHA256SUMS-app`, and attest both installers. Those steps run only with a tag.
- [x] Docs, THREAT_MODEL and CHANGELOG are updated.
- [x] The Result lists the exact steps for Nico: the IDE release with the rename first, then the first app preview.

## Result (2026-10-04)

Six PRs: one per milestone, [#303](https://github.com/ndunl075/hydra/pull/303) (the Hydra IDE rename), [#313](https://github.com/ndunl075/hydra/pull/313) (app package and installer), [#314](https://github.com/ndunl075/hydra/pull/314) (updates), [#315](https://github.com/ndunl075/hydra/pull/315) (release pipeline) and [#316](https://github.com/ndunl075/hydra/pull/316) (docs and coexistence), then this one, with two fixes the dry run found and this Result. Milestones 2 to 5 each had an independent read-only review in a fresh Claude session; findings and fixes are in each PR body, and every high and medium finding was fixed. Nico asked to lean on GitHub Actions less, so work was verified locally first (isolated-identity installer probes, `-SafeLocal` lifecycle runs) and pushed with `[skip ci]` until a PR's one CI run.

**Acceptance evidence:**
- **IDE upgrade:** dry run [37218679365](https://github.com/ndunl075/hydra/actions/runs/37218679365) (Windows desktop, dispatched with no tag, on this branch): "pinned Hydra 0.24.2 upgrades to Hydra IDE 0.27.1: its Hydra.lnk shortcuts become "Hydra IDE" ones with selected/unselected desktop preference kept, the app's Hydra.lnk survives the upgrade and a later uninstall, user/profile/extension/task/project data is preserved, the runtime matches exactly, and uninstall leaves nothing behind". The upgrade runs through `/HYDRAUPDATE=1`, the in-app update path, and the installer is still `HydraSetup.exe`. It upgrades from v0.24.2, not v0.27.1: the test needs a release strictly older than `package.json`, which is 0.27.1 until the next release bumps it (step 2 below re-pins it).
- **App install, upgrade and uninstall** (per user, no admin prompt): `scripts/app-installer-test.ps1` "PASS (full)" in the App workflow on every app PR, for example [37174280130](https://github.com/ndunl075/hydra/actions/runs/37174280130), and in the dry run's `app` job built as a stable package.
- **Coexistence in both orders:** the dry run's `coexistence` job with that build's IDE and app, desktop shortcuts included ("Hydra IDE uninstalled first: the Hydra app kept 2 shortcut(s), its registration and program, and all the data", and the reverse); also the App workflow on every app change, against the pinned v0.24.2 IDE (Start Menu shortcuts only).
- **Dry run and release jobs:** the dry run uploaded `Hydra-win32-x64-user-installer` and `Hydra-app-win32-x64-installer` and skipped `release`. `tests/releaseWorkflow.test.ts` checks that the release writes `SHA256SUMS` (exactly `HydraSetup.exe`'s line) and `SHA256SUMS-app`, attests both installers, publishes the four files, and runs only with a tag after `desktop`, `app` and `coexistence`; and that previews publish only from `app-preview.yml` with a preview number.
- **Docs, THREAT_MODEL, CHANGELOG:** README (both products, which to download), [`docs/App.md`](../../App.md), `docs/Releases.md`, `docs/Windows_Installer.md`, HSEC-96 (the app's package and installer), HSEC-97 (its update), HSEC-47 (releases with both installers and app previews), and the CHANGELOG's Unreleased section.

**What changed versus this file:**
- **`SHA256SUMS` keeps exactly one line, `HydraSetup.exe`'s; the app's installer has its own one-line `SHA256SUMS-app`.** Decided with Nico on 2026-10-03: every installed IDE's updater (`parseSums`) and `scripts/install.ps1` refuse a `SHA256SUMS` with a second line, so "one SHA256SUMS listing both installers" would have stopped every installed IDE from updating. Milestones 3 and 4 above were edited to say so.
- **Previews are their own workflow,** `app-preview.yml`, not a job in `app.yml`: the desktop workflow calls `app.yml`, and a called workflow can't hold write permissions. A preview's installer is version `x.y.z.n`, so preview n+1 installs over preview n and the next release over any preview; the shared install check allows the fourth part only where the app's installer defines `HydraPreviewVersions`. Previews publish only from `main`, once `v<version>` is released.
- **G1's mutex question:** neither a named mutex nor Restart Manager. The app's setup and uninstall refuse while `Hydra.exe` or node-pty's unpacked programs are in use, found by asking Windows for write access for up to ten seconds; uninstall also waits after its cleanup helper ran `Hydra.exe`.
- **The IDE rename needed more than `nameLong`:**
  - `UninstallLogMode=overwrite`, so an uninstall never replays an earlier version's `Hydra.lnk` deletions over the app's shortcut. `new` would have kept the old log and added a second uninstaller. Because the fresh log no longer lists what only an earlier version installed, uninstall also removes the installer's own folders and Electron's files (`[UninstallDelete]`), and, after an update, the then-empty install folder (found by the dry run, below).
  - `VersionInfoProductName=Hydra`: Inno takes the installer's PE product name from `nameLong`, but the signed update helper (`native/desktop-update-pe-identity.cpp`) requires "Hydra" (found by the dry run, below).
  - `vscode.env.appName` is `nameLong`: settings import and three smoke checks now expect "Hydra IDE".
- **Found by the dry run and fixed in this PR:** the first dry run ([37215682124](https://github.com/ndunl075/hydra/actions/runs/37215682124)) refused `HydraSetup.exe`'s PE identity, which said "Hydra IDE"; the second ([37217211260](https://github.com/ndunl075/hydra/actions/runs/37217211260)) found the empty install folder left after uninstalling an updated IDE. Neither had shipped: no release includes milestone 1 yet.
- **`install.ps1`** gains `-App` and `$env:HYDRA_INSTALL_APP = '1'`; it installs the app only from a full release.
- **The app's packs** ship in `resources\packs`, beside the archive, where the app's controller looks for them.

**Follow-ups:**
- **Hydra IDE's own data removal** (`/HYDRAREMOVEDATA`, or Yes when asked) still removes all of `%APPDATA%\Hydra`, including the storage it shares with the app, even while the app is installed. The app's own removal already keeps it while the IDE is installed. Changing the IDE's needs a desktop CI run; `docs/App.md` says so meanwhile.
- **The update helper** (shared with the IDE) doesn't reopen Hydra when it gives up after ten minutes. Unchanged IDE behaviour.
- **Add/Remove Programs:** the IDE shows "Hydra (User)" (its `win32NameVersion`, which upgrades compare) and the app "Hydra App".
- **Neither installer is code-signed;** SmartScreen warns.
- **The packaged app's window** has been exercised only through the unpackaged smoke and the installed exe's Node mode; opening the installed app once by hand is worth doing before the first preview.

**Steps for Nico, in order:**
1. **Release Hydra IDE with the rename first.** Open a `release/0.28.0` PR that sets `0.28.0` in `package.json`, `app/package.json` and `app/package-lock.json` (both version fields), with the CHANGELOG's Unreleased heading renamed, and merge it.
2. **Re-pin the upgrade baseline** to v0.27.1 in `desktop/upgrade-baseline.json` (its tag, tagged commit and `HydraSetup.exe`'s SHA-256), so the upgrade test starts from the release installed copies have.
3. **Run Actions → Windows desktop → Run workflow** on `main` with `release_tag: v0.28.0` and `prerelease` off. It publishes `HydraSetup.exe`, `SHA256SUMS`, `HydraAppSetup.exe` and `SHA256SUMS-app`. Installed IDEs offer it and update to Hydra IDE, which removes their old `Hydra.lnk` shortcuts; the release carries the stable app beside it. (A prerelease run wouldn't reach installed IDEs: their update prompt skips prereleases.)
4. **App previews come after that:** **Actions → App preview → Run workflow** on `main` with `preview: 1`. It refuses unless `v<version>` is released, so run it after step 3, while `main` is still at 0.28.0. It publishes the prerelease `v0.28.0-app.1` with `HydraAppSetup.exe` (version 0.28.0.1) and `SHA256SUMS-app`.
5. **Open the installed app once** by hand, from the Start Menu's Hydra, to check the packaged window, before telling anyone about it.

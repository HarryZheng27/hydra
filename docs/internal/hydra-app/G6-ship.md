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
   - `app/installer/hydra-app.iss` adapts `desktop/hydra-wizard.iss`, `hydra-uninstall.iss` and `hydra-update-mode.iss`: a new AppId GUID, a per-user install with no admin, `%LOCALAPPDATA%\Programs\Hydra App`, "Hydra" shortcuts, AppUserModelId `Hydra.App`.
   - The uninstaller runs the app's own uninstall helper, like `src/uninstall.ts`, which removes only this install's Claude and Codex entries.
   - `/HYDRAREMOVEDATA` asks, then removes `%APPDATA%\Hydra App`. It removes the shared storage root only when the IDE isn't installed.
3. **Updates:** `installerName` in `src/core/updateCheck.ts` becomes per product; the IDE's behaviour is unchanged and tested. The app's in-app update downloads, checks SHA256SUMS, asks, and runs its installer in update mode. It's on only for stable releases; previews don't update themselves.
4. **Release pipeline:**
   - **Versions in lockstep:** `app/package.json` follows the root version, and a test enforces it.
   - **Previews:** a release job in `app.yml` publishes `v<version>-app.<n>` as a prerelease with `HydraAppSetup.exe`, SHA256SUMS and an attestation. `releases/latest` skips prereleases, and the IDE's updater ignores suffixed versions, so IDE users keep getting the IDE.
   - **Stable:** `desktop.yml`'s release job also builds `HydraAppSetup.exe`, with one SHA256SUMS listing both installers. `scripts/install.ps1` gains `-App`.
   - **Dry run:** a manual run with no release tag only builds and uploads artifacts, as `desktop.yml` already does.
5. **Docs and coexistence:** the README covers both products and which to download; a new `docs/App.md` user guide; `docs/Releases.md`; THREAT_MODEL entries for the app's installer and update path; CHANGELOG. Add Windows tests for app install, upgrade and uninstall, and a coexistence test: install both, uninstall each in turn, and the other keeps its shortcuts, registration and shared data.

## Local checks per PR
Root `npm run check` and `npm test`; `npm --prefix app run check`, `test` and `build`. Installer tests run in CI on disposable Windows runners.

## Acceptance
- [ ] IDE upgrade from the latest release: shortcuts say "Hydra IDE", the old `Hydra.lnk` is gone, settings and data are intact, the in-app update still finds `HydraSetup.exe`, and a later uninstall leaves a planted `Hydra.lnk` alone.
- [ ] App install, upgrade and uninstall pass on a disposable runner, with no admin prompt.
- [ ] The coexistence test passes in both uninstall orders.
- [ ] A dry run builds and uploads both installers. A test checks that the release jobs write one SHA256SUMS covering both installers and attest both. Those steps run only with a tag.
- [ ] Docs, THREAT_MODEL and CHANGELOG are updated.
- [ ] The Result lists the exact steps for Nico: the IDE release with the rename first, then the first app preview.

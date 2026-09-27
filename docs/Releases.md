# Releasing Hydra

How a Hydra release is built, published and checked, and what's still needed before Hydra can update itself.

## Publishing a release

1. Set `package.json`'s `version` to the new version and merge that to `main`.
2. Run the **Windows desktop** workflow by hand (**Actions → Windows desktop → Run workflow**) on `main`, with:
   - **release_tag:** `v<that version>`, for example `v0.25.0`;
   - **prerelease:** off for a release installed copies should be offered (see [The update prompt](#the-update-prompt)); on for one they shouldn't.
3. The `desktop` job builds and tests everything, as on a pull request: the build, smoke, the installer's install, reinstall and uninstall, the upgrade from the pinned previous release, and the MSIX checks. The uninstall test checks that uninstalling removes only this install's Claude Code and Codex entries, keeps Hydra's data by default, and removes it with `/HYDRAREMOVEDATA` (see [Uninstall](../README.md#uninstall)).
4. Only if all of that passes, the `release` job:
   - checks that the tag matches `package.json` and isn't already a release;
   - writes `SHA256SUMS` for the tested installer;
   - attests the installer's build provenance with GitHub's attestation service (`actions/attest-build-provenance`);
   - publishes the release with `HydraSetup.exe` and `SHA256SUMS`, and verification steps in its notes.

   This job is the only one allowed to write releases and attestations.

The upgrade test's baseline, `desktop/upgrade-baseline.json`, pins a published release. Move it to the new release once that release is out.

## Installing

`irm https://www.usefrontierdigital.com/hydra/install.ps1 | iex` in PowerShell runs [`scripts/install.ps1`](../scripts/install.ps1). The website redirects that address to the file on `main`, so there's one copy.

- **What it checks:** it finds the latest full release (or the one in `$env:HYDRA_INSTALL_VERSION`) through the same GitHub API and checks as the update prompt. It downloads `HydraSetup.exe` and `SHA256SUMS` and compares the installer's SHA-256 before running anything.
- **What it refuses:** a hash mismatch, a running Hydra, and machines that aren't 64-bit x64 Windows.
- **What it never does:** ask for admin, or change your execution policy.
- **Run as a file:** it also takes `-Version <x.y.z>`, `-DryRun` (download and verify only), and `-InstallerPath` with `-SumsPath` (check and install local files).

The `desktop` job runs it against the installer it just built, through `scripts/desktop-install-script-test.ps1`:
- a wrong `SHA256SUMS` must be refused, even in a dry run, and install nothing;
- a real install must land `Hydra.exe`;
- its uninstall must remove it.

## Checking an installer

- **Its hash:** `Get-FileHash .\HydraSetup.exe -Algorithm SHA256` in PowerShell must print the hash in the release's `SHA256SUMS`.
- **Where it was built:** `gh attestation verify HydraSetup.exe --repo ndunl075/hydra` shows the workflow run and commit it came from.

Installers aren't code-signed yet, so Windows SmartScreen may warn before one runs.

## The update prompt

An installed Hydra (one with `unins000.exe` beside `Hydra.exe`) on Windows checks for updates from its built-in extension; see [Updating](../README.md#updating). It:
- reads `https://api.github.com/repos/ndunl075/hydra/releases/latest`, which lists only the newest published full release: prereleases and drafts are never offered;
- accepts it only if the tag is `v<x.y.z>`, newer than the running version, and has exactly one `HydraSetup.exe` and one `SHA256SUMS`, both under `https://github.com/ndunl075/hydra/releases/download/<tag>/`;
- downloads over HTTPS only, following at most 5 redirects, and only to `github.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com`;
- refuses an installer over 300 MB, or a `SHA256SUMS` without exactly one `HydraSetup.exe` line;
- keeps the installer only if its SHA-256 matches `SHA256SUMS`, then asks before installing. A small PowerShell helper waits for Hydra to close, runs `HydraSetup.exe /SILENT /SP- /SUPPRESSMSGBOXES /NORESTART /NORESTARTAPPLICATIONS /MERGETASKS=!runcode`, and reopens Hydra. It logs to `%TEMP%\hydra-update.log`.

The limit: `SHA256SUMS` comes from the same release as the installer, so the hash catches a corrupted or truncated download, not a release that was replaced by someone with write access to the repository. Installers aren't code-signed, so nothing on the machine proves who built one. `gh attestation verify` (above) does, and code signing (below) is still what would let Hydra check it before installing.

## Turning on in-app updates

This section is about a separate, stricter mechanism. Hydra's update service runs in the desktop app's main process and stays off until the release owner provides the inputs below, none of which can come from the repository alone. Once on, it:
- fetches the signed record over HTTPS without following redirects;
- verifies the record against the key built into the app;
- asks you before downloading;
- keeps the installer only if its size and SHA-256 match the signed record.

Installing from inside Hydra isn't built yet. The native helper that would check the installer's code signature and run it refuses every request (see [Desktop_Native_Update_Helper_Preflight.md](Desktop_Native_Update_Helper_Preflight.md)). So after a download, Hydra says installation is unavailable.

1. **A code-signing certificate**, such as an OV certificate or Azure Trusted Signing.
   - Sign `Hydra.exe` and `HydraSetup.exe` in the desktop build; the prerequisites are in [Desktop_Signing_Preflight.md](Desktop_Signing_Preflight.md).
   - The certificate's subject and thumbprint go into `authenticodeSigners` in the app's update trust.
   - The update service refuses to turn on without at least one signer, and the signing script refuses to sign metadata for an installer that isn't validly signed.
2. **An update-signing key** (Ed25519).
   - Run `node scripts/desktop-update-key.mjs --out <a file outside any repository>`. It writes the private key with owner-only access and prints what to do next:
     - `gh secret set HYDRA_UPDATE_SIGNING_KEY` and `gh secret set HYDRA_UPDATE_KEY_ID` for the repository;
     - the `hydraUpdateTrust` block for `desktop/product.json`, with the public key and key ID.
   - Keep the private key offline, and delete the local copy once the secret is set.
3. **An update host:** a bare HTTPS origin, such as a storage bucket behind your own domain.
   - It must serve `/channels/stable/win32-x64/user.json` and `/artifacts/sha256/<installer sha256>/HydraSetup.exe` directly.
   - Clients follow no redirects, so GitHub release assets and GitHub Pages can't serve these. The installer is also larger than Pages allows.
   - Its origin goes into `hydraUpdateTrust.origin`.
4. **Turn the trust on:** set `hydraUpdateTrust.status` to `enabled` in `desktop/product.json`, with the origin, key and signers above.

Once all four are in place:
- A release run signs `user.json` from the installed bytes of the released installer.
  - Its sequence number is the signing time, so it always increases.
  - It expires after 30 days, so sign a fresh one before then.
- The run keeps `user.json` as the `Hydra-signed-update-metadata` artifact. Upload it, unchanged, and the installer to the update host.
- Before making updates the default, finish the native install step and run an upgrade from one signed release to the next.

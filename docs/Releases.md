# Releasing Hydra

How a Hydra release is built, published and checked, and what's still needed before Hydra can update itself ([Hydra_Improvements.md](Hydra_Improvements.md), Step 4).

## Publishing a release

1. Set `package.json`'s `version` to the new version and merge that to `main`.
2. Run the **Windows desktop** workflow by hand (**Actions → Windows desktop → Run workflow**) on `main`, with:
   - **release_tag:** `v<that version>`, for example `v0.25.0`;
   - **prerelease:** on, until installers are code-signed.
3. The `desktop` job builds and tests everything, as on a pull request: the build, smoke, the installer's install, reinstall and uninstall, the upgrade from the pinned previous release, and the MSIX checks.
4. Only if all of that passes, the `release` job:
   - checks that the tag matches `package.json` and isn't already a release;
   - writes `SHA256SUMS` for the tested installer;
   - attests the installer's build provenance with GitHub's attestation service (`actions/attest-build-provenance`);
   - publishes the release with `HydraSetup.exe` and `SHA256SUMS`, and verification steps in its notes.

   This job is the only one allowed to write releases and attestations.

The upgrade test's baseline, `desktop/upgrade-baseline.json`, pins a published release. Move it to the new release once that release is out.

## Checking an installer

- **Its hash:** `Get-FileHash .\HydraSetup.exe -Algorithm SHA256` in PowerShell must print the hash in the release's `SHA256SUMS`.
- **Where it was built:** `gh attestation verify HydraSetup.exe --repo ndunl075/hydra` shows the workflow run and commit it came from.

Installers aren't code-signed yet, so Windows SmartScreen may warn before one runs.

## Turning on in-app updates

Hydra already contains an update service, which runs in the desktop app's main process. It fetches a signed record, verifies it against a key built into the app, asks before downloading, and checks the downloaded installer's hash and its Windows code signature before installing. It stays off until the release owner provides the inputs below, and none of them can come from the repository alone.

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
- Before making updates the default, run an upgrade from one signed release to the next and check it.

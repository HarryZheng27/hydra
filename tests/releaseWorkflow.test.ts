import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The release job's safety properties (docs/Releases.md, THREAT_MODEL.md HSEC-47/48), read from the
// workflow's text: no YAML parser is a direct dependency, and these lines are what a reviewer reads too.
const lines = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'desktop.yml'), 'utf8').split(/\r?\n/);
const jobStarts = lines.flatMap((line, index) => /^ {2}[a-z][\w-]*:$/.test(line) && index > lines.indexOf('jobs:') ? [index] : []);
const job = (name: string) => {
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `job ${name} is missing`);
  const end = jobStarts.find(index => index > start) ?? lines.length;
  return lines.slice(start, end);
};
const step = (jobLines: string[], name: string) => {
  const start = jobLines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step ${name} is missing`);
  const end = jobLines.findIndex((line, index) => index > start && /^ {6}- /.test(line));
  return jobLines.slice(start, end === -1 ? jobLines.length : end);
};

test('the release job runs only on a manual run with a tag, after every desktop check', () => {
  const release = job('release');
  assert.ok(release.includes('    needs: [desktop, app, coexistence]'));
  assert.ok(release.includes("    if: github.event_name == 'workflow_dispatch' && inputs.release_tag != ''"));
  const workflowPermissions = lines.slice(lines.indexOf('permissions:'), lines.indexOf('jobs:')).join('\n');
  assert.doesNotMatch(workflowPermissions, /write/, 'the workflow-wide permissions stay read-only');
  assert.doesNotMatch(job('desktop').join('\n'), /: write\b/, 'the build job gets no write permission');
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write']) assert.ok(release.includes(`      ${permission}`));
});

test('a release carries both tested installers, each with its own one-line checksum file and a provenance attestation', () => {
  const release = job('release');
  assert.ok(step(release, 'Download the tested installer').includes('          name: Hydra-win32-x64-user-installer'));
  assert.ok(step(release, 'Download the tested app installer').includes('          name: Hydra-app-win32-x64-installer'));
  // SHA256SUMS keeps exactly HydraSetup.exe's line: installed IDEs and install.ps1 refuse a second one.
  const sums = step(release, 'Write SHA256SUMS').join('\n');
  assert.match(sums, /Get-FileHash -LiteralPath release\/HydraSetup\.exe -Algorithm SHA256/);
  assert.match(sums, /WriteAllText\(\(Join-Path \$PWD 'release\/SHA256SUMS'\), "\$hash {2}HydraSetup\.exe`n"\)/);
  assert.doesNotMatch(sums, /HydraAppSetup/);
  const appSums = step(release, 'Write SHA256SUMS-app').join('\n');
  assert.match(appSums, /Get-FileHash -LiteralPath release\/HydraAppSetup\.exe -Algorithm SHA256/);
  assert.match(appSums, /WriteAllText\(\(Join-Path \$PWD 'release\/SHA256SUMS-app'\), "\$hash {2}HydraAppSetup\.exe`n"\)/);
  const attest = step(release, "Attest the installers' build provenance");
  assert.ok(attest.includes('        uses: actions/attest-build-provenance@v2'));
  assert.deepEqual(attest.slice(attest.indexOf('          subject-path: |') + 1).map(line => line.trim()).filter(Boolean), ['release/HydraSetup.exe', 'release/HydraAppSetup.exe']);
  assert.match(step(release, 'Publish the release').join('\n'), /gh release create \$env:RELEASE_TAG release\/HydraSetup\.exe release\/SHA256SUMS release\/HydraAppSetup\.exe release\/SHA256SUMS-app /);
  // The app is built at Hydra's own version.
  assert.match(step(release, "Check the tag names this build's version and isn't taken").join('\n'), /app\/package\.json's version \$appVersion isn't the root's \$version/);
});

test('a release builds the app through the App workflow, only on a manual run: a stable package for a full release, a preview for a prerelease', () => {
  const app = job('app');
  assert.ok(app.includes("    if: github.event_name == 'workflow_dispatch'"));
  assert.ok(app.includes('    uses: ./.github/workflows/app.yml'));
  assert.ok(app.includes("      channel: ${{ inputs.prerelease && 'preview' || 'stable' }}"));
  assert.doesNotMatch(app.join('\n'), /permissions|: write\b/);
  const appWorkflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'app.yml'), 'utf8').replace(/\r\n/g, '\n');
  // The App workflow builds, tests and uploads only; it never writes, so another workflow may call it.
  assert.doesNotMatch(appWorkflow, /: write\b/);
  assert.match(appWorkflow, /workflow_call:\n {4}inputs:\n {6}channel:/);
  assert.ok(appWorkflow.includes("--channel=${{ inputs.channel == 'stable' && 'stable' || 'preview' }} ${{ inputs.preview && format('--preview={0}', inputs.preview) || '' }}"));
  assert.ok(appWorkflow.includes('          name: Hydra-app-win32-x64-installer'));
  assert.ok(appWorkflow.includes('./scripts/app-installer-test.ps1 -InstallerPath app/out/installer/HydraAppSetup.exe'));
});

test('an app preview is a prerelease with a suffixed tag, published only from a manual run with a preview number', () => {
  const preview = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'app-preview.yml'), 'utf8').replace(/\r\n/g, '\n');
  const trigger = preview.slice(preview.indexOf('\non:'), preview.indexOf('\npermissions:'));
  assert.deepEqual([...trigger.matchAll(/^ {2}([a-z_]+):/gm)].map(match => match[1]), ['workflow_dispatch'], 'a manual run only');
  assert.match(preview, /^permissions:\n {2}contents: read\n/m);
  assert.match(preview, / {2}app:\n {4}uses: \.\/\.github\/workflows\/app\.yml\n {4}with:\n {6}channel: preview\n/);
  const job = preview.slice(preview.indexOf('\n  preview:'));
  assert.match(job, /\n {4}needs: app\n {4}if: inputs\.preview != ''\n/);
  assert.match(job, /-notmatch '\^\[1-9\]\[0-9\]\{0,3\}\$'/);
  // From main only, and only once x.y.z is released: a preview installs as x.y.z.n, between it and the next release.
  assert.match(job, /if \(\$env:GITHUB_REF -ne 'refs\/heads\/main'\) \{ throw/);
  assert.match(job, /gh release view "v\$version" [^\n]*\n[^\n]*isn't released yet/);
  assert.match(preview, / {6}preview: \$\{\{ inputs\.preview \}\}\n/);
  assert.match(job, /\$tag = "v\$version-app\.\$env:PREVIEW"/);
  assert.match(job, /gh release view \$tag[^\n]*\n[^\n]*already exists/);
  assert.match(job, /WriteAllText\(\(Join-Path \$PWD 'release\/SHA256SUMS-app'\), "\$hash {2}HydraAppSetup\.exe`n"\)/);
  assert.match(job, /subject-path: release\/HydraAppSetup\.exe/);
  assert.match(job, /gh release create \$env:PREVIEW_TAG release\/HydraAppSetup\.exe release\/SHA256SUMS-app [^\n]*--prerelease/);
  assert.doesNotMatch(job, /release\/SHA256SUMS[^-]|HydraSetup\.exe/, 'a preview never publishes the IDE or its SHA256SUMS');
});

test('the update-signing secrets reach only the signing step, which runs only for a code-signed installer', () => {
  const text = lines.join('\n');
  for (const secret of ['HYDRA_UPDATE_SIGNING_KEY', 'HYDRA_UPDATE_KEY_ID']) {
    assert.equal(text.split(`\${{ secrets.${secret} }}`).length - 1, 1, `${secret}'s value appears once`);
  }
  const release = job('release');
  const sign = step(release, 'Sign update metadata');
  assert.ok(sign.includes("          HYDRA_UPDATE_SIGNING_KEY: ${{ secrets.HYDRA_UPDATE_SIGNING_KEY }}"));
  assert.ok(sign.includes("        if: steps.signing.outputs.sign == 'true'"));
  const decide = step(release, 'Decide whether to sign update metadata').join('\n');
  assert.match(decide, /Get-AuthenticodeSignature -LiteralPath release\/HydraSetup\.exe/);
  assert.match(decide, /-ne 'Valid'\) \{[^}]*"sign=false"/);
  assert.doesNotMatch(step(release, "Install the signing script's build tool (no secrets here)").join('\n'), /secrets\./);
});

test('both installers are tested side by side before a release, and the app beside an installed IDE on every app change', () => {
  const coexistence = job('coexistence');
  assert.ok(coexistence.includes('    needs: [desktop, app]'));
  assert.ok(coexistence.includes("    if: github.event_name == 'workflow_dispatch'"));
  assert.doesNotMatch(coexistence.join('\n'), /permissions|: write\b/);
  assert.match(step(coexistence, 'Coexistence test').join('\n'), /coexistence-test\.ps1 -IdeInstallerPath installers\/ide\/HydraSetup\.exe -AppInstallerPath installers\/app\/HydraAppSetup\.exe/);
  const appWorkflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'app.yml'), 'utf8').replace(/\r\n/g, '\n');
  // The App workflow uses the pinned IDE release, checked by its SHA-256 before it runs.
  assert.match(appWorkflow, /gh release download \$baseline\.tag [^\n]*--pattern HydraSetup\.exe/);
  assert.match(appWorkflow, /-ne \$baseline\.installerSha256\) \{ throw/);
  assert.match(appWorkflow, /coexistence-test\.ps1 -IdeInstallerPath ide-release\/HydraSetup\.exe -AppInstallerPath app\/out\/installer\/HydraAppSetup\.exe/);
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'coexistence-test.ps1'), 'utf8');
  assert.match(script, /throw 'The coexistence test runs only on disposable GitHub-hosted Windows runners\.'/);
  assert.match(script, /foreach \(\$first in @\('ide', 'app'\)\)/, 'both uninstall orders');
});

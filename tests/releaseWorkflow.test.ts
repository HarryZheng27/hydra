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
  assert.ok(release.includes('    needs: desktop'));
  assert.ok(release.includes("    if: github.event_name == 'workflow_dispatch' && inputs.release_tag != ''"));
  const workflowPermissions = lines.slice(lines.indexOf('permissions:'), lines.indexOf('jobs:')).join('\n');
  assert.doesNotMatch(workflowPermissions, /write/, 'the workflow-wide permissions stay read-only');
  assert.doesNotMatch(job('desktop').join('\n'), /: write\b/, 'the build job gets no write permission');
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write']) assert.ok(release.includes(`      ${permission}`));
});

test('a release carries SHA256SUMS and a provenance attestation for the tested installer', () => {
  const release = job('release');
  assert.ok(step(release, 'Download the tested installer').includes('          name: Hydra-win32-x64-user-installer'));
  assert.match(step(release, 'Write SHA256SUMS').join('\n'), /Get-FileHash -LiteralPath release\/HydraSetup\.exe -Algorithm SHA256/);
  const attest = step(release, "Attest the installer's build provenance");
  assert.ok(attest.includes('        uses: actions/attest-build-provenance@v2'));
  assert.ok(attest.includes('          subject-path: release/HydraSetup.exe'));
  assert.match(step(release, 'Publish the release').join('\n'), /gh release create \$env:RELEASE_TAG release\/HydraSetup\.exe release\/SHA256SUMS /);
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

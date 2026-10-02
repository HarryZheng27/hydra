import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// G1 (docs/internal/hydra-app/G1-spikes.md): the recorded Claude and Codex protocol transcripts
// that G4's stand-in CLIs replay. They come from live runs on a real machine, so guard what
// may be committed, and rerun each live check's assertions against them.
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const providers = ['claude', 'codex'] as const;

for (const provider of providers) {
  const folder = path.join(root, 'tests', 'fixtures', 'app', provider);

  test(`${provider} app fixtures are small, redacted transcripts`, async () => {
    const names = (await readdir(folder)).filter(name => name.endsWith('.jsonl'));
    assert.ok(names.length > 0, 'no fixtures recorded');
    for (const name of names) {
      const file = path.join(folder, name);
      assert.ok((await stat(file)).size <= 200 * 1024, `${name} is over 200 KB`);
      const text = await readFile(file, 'utf8');
      const [header, ...entries] = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(header.fixture, 'hydra-app-protocol/v1', name);
      assert.equal(header.provider, provider, name);
      assert.equal(`${header.scenario}.jsonl`, name);
      for (const entry of entries) assert.ok(['send', 'recv', 'note'].includes(entry.dir), `${name}: unknown direction ${entry.dir}`);
      assert.doesNotMatch(text, /[A-Za-z]:(\\\\|\\|\/)+Users(\\\\|\\|\/)+(?!\[user\])[^\\/"]+/i, `${name} holds a home path`);
      assert.doesNotMatch(text, /\/(home|Users)\/(?!\[user\])[a-z][\w.-]*\//, `${name} holds a home path`);
      assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${name} holds an email address`);
      assert.doesNotMatch(text, /\b(sk-ant-|sk-|eyJ)[A-Za-z0-9_-]{20,}/, `${name} holds a token`);
      // Machine and installation identity only ever holds a placeholder, at any escaping depth.
      // (Claude's --settings also uses serverName, for the live check's own MCP servers.)
      assert.doesNotMatch(text, /\\*"(serverName|installationId|machineId|deviceId|hostname|computerName|accountId|account_uuid|organization_uuid|email)\\*"\s*:\s*\\*"(?!\[|(?:g1[\w-]*|hydra)\\*")/, `${name} holds a machine or account identifier`);
    }
  });

  test(`${provider} live check passes on its recorded fixtures`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `hydra-app-live-${provider}-`));
    try {
      const evidence = path.join(directory, 'evidence.json');
      await execute(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'app-live', `${provider}.mjs`), '--fixture', '--evidence', evidence], { cwd: directory, windowsHide: true });
      const record = JSON.parse(await readFile(evidence, 'utf8'));
      assert.equal(record.mode, 'fixture');
      assert.equal(record.turnsUsed, 0);
      assert.equal(record.result, 'pass', JSON.stringify(record.results.filter((r: { status: string }) => r.status !== 'pass')));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { runGateList, type Gate, type GateContext } from '../src/core/gates';
import { createRedactor, redactText, resetRedactionCache } from '../src/core/redact';
import { logger } from '../src/core/helperRunner';

// ---- Shapes that must be masked ----

const shapes = [
  'sk-abcdefghij1234567890',
  'sk_abcdefghij1234567890',
  'ghp_abcdefghij1234567890',
  'gho_abcdefghij1234567890',
  'ghu_abcdefghij1234567890',
  'ghs_abcdefghij1234567890',
  'ghr_abcdefghij1234567890',
  'github_pat_abcdefghij1234567890',
  'glpat-abcdefghij1234567890',
  'xoxb-abcdefghij1234567890',
  'xoxp-abcdefghij1234567890',
  'AKIAABCDEFGHIJ123456',
  'ASIAABCDEFGHIJ123456',
  'AIzaabcdefghijklmnopqrstuvwxyz012345',
  'ya29.abcdefghij1234567890abcdefghij',
  'npm_abcdefghij1234567890abcdefghij',
  'pypi-abcdefghij1234567890abcdefghij',
  'hf_abcdefghij1234567890abcdefghij',
  'shpat_abcdefghij1234567890abcdefghij',
  'SG.abcdefghij1234567890.abcdefghij1234567890',
  'lin_api_abcdefghij1234567890abcdefghij',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGhpc2lzYXNpZ25hdHVyZQ',
];

test('redactText: every known token shape is masked wherever it appears in free text', () => {
  for (const shape of shapes) {
    const text = `before ${shape} after`;
    const out = redactText(text);
    assert.ok(!out.includes(shape), `${shape} still present in: ${out}`);
    assert.ok(out.includes('[redacted]'), `${shape}: no [redacted] in: ${out}`);
  }
});

test('redactText: Bearer/Basic values and an Authorization header line', () => {
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnop'), 'Authorization: [redacted]');
  // Mid-line (not its own header line), the scheme word is kept, as for a bare Bearer value.
  assert.equal(redactText('curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com'),
    'curl -H "Authorization: Bearer [redacted]" https://api.example.com');
  assert.equal(redactText('the call sent Bearer abcdefghijklmnop to the server'), 'the call sent Bearer [redacted] to the server');
  assert.equal(redactText('Basic dXNlcjpwYXNzd29yZA=='), 'Basic [redacted]');
  // A short value after Bearer isn't masked: it doesn't look like a real token.
  assert.equal(redactText('Bearer x'), 'Bearer x');
});

test('redactText: PEM private key blocks are replaced whole, multi-line', () => {
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBogIBAAJBAKj34GkxFhD91assumedbase64', 'more lines of base64', '-----END RSA PRIVATE KEY-----'].join('\n');
  const text = `before\n${pem}\nafter`;
  const out = redactText(text);
  assert.ok(!out.includes('MIIBogIBAAJBAKj34GkxFhD91'));
  assert.ok(out.includes('before\n[redacted]\nafter'));
});

test('redactText: a password in a URL is masked, the user and host are not', () => {
  assert.equal(redactText('postgres://dbuser:hunter2pass@db.example.com:5432/app'), 'postgres://dbuser:[redacted]@db.example.com:5432/app');
  assert.equal(redactText('https://example.com/a/b'), 'https://example.com/a/b');
});

test('redactText: key=value, "key": "value" and key: value pairs, only when the key looks secret and the value qualifies', () => {
  assert.equal(redactText('API_KEY=abcdefghij1234'), 'API_KEY=[redacted]');
  assert.equal(redactText('DB_PASSWORD="hunter2pass"'), 'DB_PASSWORD="[redacted]"');
  assert.equal(redactText('{"apiKey": "abcdefghij1234"}'), '{"apiKey": "[redacted]"}');
  assert.equal(redactText('client_secret: abcdefghij1234'), 'client_secret: [redacted]');
  // Not secret-shaped keys, or values too short / purely numeric / an env reference: untouched.
  assert.equal(redactText('keyboard=mechanical'), 'keyboard=mechanical');
  assert.equal(redactText('session=short'), 'session=short');
  assert.equal(redactText('tokens: 123456789'), 'tokens: 123456789');
  assert.equal(redactText('GITHUB_TOKEN=${GITHUB_TOKEN}'), 'GITHUB_TOKEN=${GITHUB_TOKEN}');
});

test('redactText: ordinary text is never touched — paths, hashes, commit SHAs, UUIDs, JSON numbers, ${ENV_REF}', () => {
  const untouched = [
    'C:\\Users\\nico\\Documents\\hydra\\src\\core\\redact.ts',
    '/home/nico/projects/hydra/src/core/redact.ts',
    'a'.repeat(40), // a 40-hex commit SHA
    'f'.repeat(64), // a 64-hex sha256
    '550e8400-e29b-41d4-a716-446655440000', // a UUID
    '{"count": 12345, "ratio": 0.5}',
    'the port is ${PORT}',
    'Add src/feature.ts and run npm test.',
  ];
  for (const text of untouched) assert.equal(redactText(text), text, text);
});

test('redactText: exact secret values are masked, longest first, and only when at least 8 characters', () => {
  assert.equal(redactText('the value is abcdefgh1234', ['abcdefgh1234']), 'the value is [redacted]');
  assert.equal(redactText('short is ab', ['ab']), 'short is ab'); // too short to count as a secret
  // A longer secret that contains a shorter one: the longer replacement wins, no leftover fragment.
  const out = redactText('token=abcdefgh1234extra', ['abcdefgh1234', 'abcdefgh1234extra']);
  assert.equal(out, 'token=[redacted]');
});

test('redactText: an environment variable whose name looks secret is masked by value, cached until reset', () => {
  const key = 'HYDRA_TEST_REDACT_SECRET';
  process.env[key] = 'planted-env-secret-value';
  resetRedactionCache();
  try {
    assert.equal(redactText(`printed ${process.env[key]} here`), 'printed [redacted] here');
    process.env[key] = 'a-different-value-entirely';
    // Still the old cached value until reset.
    assert.equal(redactText('printed planted-env-secret-value here'), 'printed [redacted] here');
    resetRedactionCache();
    assert.equal(redactText('printed a-different-value-entirely here'), 'printed [redacted] here');
  } finally { delete process.env[key]; resetRedactionCache(); }
});

test('createRedactor: reads live secrets fresh on every call', () => {
  let live: string[] = [];
  const redact = createRedactor(() => live);
  assert.equal(redact('has abcdefgh1234'), 'has abcdefgh1234');
  live = ['abcdefgh1234'];
  assert.equal(redact('has abcdefgh1234'), 'has [redacted]');
});

// ---- Integration: a head transcript ----

test('helperRunner logger: a head transcript masks its own bridge token and a planted API key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-redact-head-'));
  try {
    const file = path.join(root, 'job.jsonl');
    const secret = 'headbridgetoken1234567890';
    const log = logger(file, secret);
    log('stdout', `Connecting with token ${secret}`);
    log('stdout', `Found a key: sk-abcdefghij1234567890 while scanning`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(secret), 'the bridge token leaked into the transcript');
    assert.ok(!text.includes('sk-abcdefghij1234567890'), 'the API key leaked into the transcript');
    assert.ok(text.includes('[redacted]'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// ---- Integration: a command gate ----

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-redact-gate-'));
  const repo = path.join(root, 'repo'), worktree = path.join(root, 'head');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['worktree', 'add', '-q', '-b', 'agent/feature', worktree, base]);
  return { root, repo, worktree, base, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
function context(root: string): GateContext {
  return { author: 'claude', logDirectory: path.join(root, 'logs'), runtime: { pollMs: 25 } };
}

test('command gate: a planted GitHub token and API key show in neither the saved log nor outputTail', async () => {
  const f = await repository();
  try {
    const gate: Gate = {
      id: 'leak', type: 'command', required: true, timeoutSeconds: 60,
      command: [process.execPath, '-e', 'console.log("token ghp_abcdefghij1234567890 and sk-abcdefghij1234567890"); process.exit(0)'],
    };
    const [result] = await runGateList([gate], f.worktree, f.base, context(f.root));
    assert.equal(result!.passed, true);
    assert.ok(!result!.outputTail.includes('ghp_abcdefghij1234567890'));
    assert.ok(!result!.outputTail.includes('sk-abcdefghij1234567890'));
    const saved = await readFile(result!.evidence![0]!, 'utf8');
    assert.ok(!saved.includes('ghp_abcdefghij1234567890'), 'the log file on disk still has the token');
    assert.ok(!saved.includes('sk-abcdefghij1234567890'), 'the log file on disk still has the key');
    assert.ok(saved.includes('[redacted]'));
  } finally { await f.close(); }
});

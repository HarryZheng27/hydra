import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LanePreviews, loadPreviewConfig, parsePreviewConfig, previewConfigFromGates, savePreviewConfig, splitPreviewCommand, type PreviewConfig,
} from '../src/core/lanePreview';
import type { Gate } from '../src/core/gates/config';

/**
 * A tiny real HTTP server for the preview: `node -e <script>`, reading its port from PORT (as
 * startApp sets it) and, when given as an argument too, refusing unless the two match — proving
 * both `PORT` and `{port}` substitution reach the command. It answers with its own cwd's
 * basename, so two lanes previewing from two worktrees can be told apart.
 */
const serverScript = `
const http = require('http'), path = require('path');
const port = Number(process.env.PORT), argPort = process.argv[1] ? Number(process.argv[1]) : port;
const mode = process.argv[2] || 'ok';
if (mode === 'exitEarly') process.exit(7);
const start = () => http.createServer((req, res) => {
  if (argPort !== port) { res.writeHead(500); return res.end('port mismatch'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(path.basename(process.cwd()));
}).listen(port, '127.0.0.1');
if (mode === 'slow') setTimeout(start, 300); else start();
if (mode === 'exitLater') setTimeout(() => process.exit(9), 3000);
`;

function command(mode = 'ok'): string[] {
  return [process.execPath, '-e', serverScript, '{port}', mode];
}

async function worktree(name: string, root: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

test('the port is chosen and passed, as PORT and as {port}', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const wt = await worktree('lane-a', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    const entry = await service.start({ id: 'lane-a', worktree: wt }, { command: command(), url: 'http://127.0.0.1:{port}/' });
    assert.ok(entry.port > 0);
    assert.equal(entry.url, `http://127.0.0.1:${entry.port}/`);
    const response = await fetch(entry.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'lane-a');
    await service.stopAll();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('readiness is awaited: start() does not resolve until the server answers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const wt = await worktree('lane-a', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    const started = Date.now();
    const entry = await service.start({ id: 'lane-a', worktree: wt }, { command: command('slow'), url: 'http://127.0.0.1:{port}/' });
    assert.ok(Date.now() - started >= 250, 'start() returned before the slow server was listening');
    const response = await fetch(entry.url);
    assert.equal(await response.text(), 'lane-a');
    await service.stopAll();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('two lanes get different ports and each serves its own worktree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const a = await worktree('lane-a', root), b = await worktree('lane-b', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    const [entryA, entryB] = await Promise.all([
      service.start({ id: 'lane-a', worktree: a }, { command: command(), url: 'http://127.0.0.1:{port}/' }),
      service.start({ id: 'lane-b', worktree: b }, { command: command(), url: 'http://127.0.0.1:{port}/' }),
    ]);
    assert.notEqual(entryA.port, entryB.port);
    assert.equal(await (await fetch(entryA.url)).text(), 'lane-a');
    assert.equal(await (await fetch(entryB.url)).text(), 'lane-b');
    await service.stopAll();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('stop(one) stops only that lane\'s server; the other keeps answering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const a = await worktree('lane-a', root), b = await worktree('lane-b', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    const entryA = await service.start({ id: 'lane-a', worktree: a }, { command: command(), url: 'http://127.0.0.1:{port}/' });
    const entryB = await service.start({ id: 'lane-b', worktree: b }, { command: command(), url: 'http://127.0.0.1:{port}/' });
    await service.stop('lane-a');
    assert.equal(service.get('lane-a'), undefined);
    await assert.rejects(fetch(entryA.url));
    assert.equal(await (await fetch(entryB.url)).text(), 'lane-b');
    await service.stopAll();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('stopAll stops every running preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const a = await worktree('lane-a', root), b = await worktree('lane-b', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    const entryA = await service.start({ id: 'lane-a', worktree: a }, { command: command(), url: 'http://127.0.0.1:{port}/' });
    const entryB = await service.start({ id: 'lane-b', worktree: b }, { command: command(), url: 'http://127.0.0.1:{port}/' });
    await service.stopAll();
    assert.equal(service.get('lane-a'), undefined);
    assert.equal(service.get('lane-b'), undefined);
    await assert.rejects(fetch(entryA.url));
    await assert.rejects(fetch(entryB.url));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('a server that exits before it is ready is reported, and never counted as running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const wt = await worktree('lane-a', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    await assert.rejects(
      service.start({ id: 'lane-a', worktree: wt }, { command: command('exitEarly'), url: 'http://127.0.0.1:{port}/', readyTimeoutSeconds: 2 }),
      /exited with code 7/,
    );
    assert.equal(service.get('lane-a'), undefined);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('a server that exits on its own after starting clears its entry and reports why', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const wt = await worktree('lane-a', root);
    const exits: [string, string][] = [];
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs'), onExit: (laneId, reason) => exits.push([laneId, reason]) });
    await service.start({ id: 'lane-a', worktree: wt }, { command: command('exitLater'), url: 'http://127.0.0.1:{port}/' });
    assert.ok(service.get('lane-a'));
    const deadline = Date.now() + 5000;
    while (service.get('lane-a') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(service.get('lane-a'), undefined);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]![0], 'lane-a');
    assert.match(exits[0]![1], /exited with code 9/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('preview.json validation refuses a non-loopback URL and a non-array command', () => {
  assert.throws(() => parsePreviewConfig({ command: ['npm', 'run', 'dev'], url: 'http://example.com:{port}/' }), /localhost or 127\.0\.0\.1/);
  assert.throws(() => parsePreviewConfig({ command: ['npm', 'run', 'dev'], url: 'http://127.0.0.1:3000/' }), /\{port\}/);
  assert.throws(() => parsePreviewConfig({ command: 'npm run dev', url: 'http://127.0.0.1:{port}/' }), /must be a list/);
  assert.throws(() => parsePreviewConfig({ command: [], url: 'http://127.0.0.1:{port}/' }), /must be a list/);
  const ok = parsePreviewConfig({ command: ['npm', 'run', 'dev'], url: 'http://localhost:{port}/' });
  assert.deepEqual(ok, { command: ['npm', 'run', 'dev'], url: 'http://localhost:{port}/' });
});

test('loadPreviewConfig reads and validates .hydra/preview.json; undefined without one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    assert.equal(await loadPreviewConfig(root), undefined);
    await savePreviewConfig(root, { command: ['npm', 'run', 'dev'], url: 'http://127.0.0.1:{port}/' });
    assert.deepEqual(await loadPreviewConfig(root), { command: ['npm', 'run', 'dev'], url: 'http://127.0.0.1:{port}/' });
    await mkdir(path.join(root, '.hydra'), { recursive: true });
    await writeFile(path.join(root, '.hydra', 'preview.json'), JSON.stringify({ command: ['x'], url: 'http://evil.example/{port}' }));
    await assert.rejects(loadPreviewConfig(root), /localhost or 127\.0\.0\.1/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('config from a screenshots gate wins over preview.json', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    await savePreviewConfig(root, { command: ['npm', 'run', 'dev'], url: 'http://127.0.0.1:{port}/from-file' });
    const gate: Gate = { id: 'ui', type: 'screenshots', required: false, start: ['npm', 'run', 'dev', '--', '--port', '{port}'], url: 'http://localhost:{port}/from-gate', widths: [390], readyTimeoutSeconds: 90 };
    const fromGates = previewConfigFromGates({ gates: [gate] });
    assert.deepEqual(fromGates, { command: gate.start, url: gate.url, readyTimeoutSeconds: 90 });
    // The caller (LaneService.previewConfig) tries the gates config first and only falls back to preview.json.
    const config: PreviewConfig | undefined = fromGates ?? await loadPreviewConfig(root);
    assert.equal(config!.url, 'http://localhost:{port}/from-gate');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('previewConfigFromGates is undefined without a screenshots gate', () => {
  const gate: Gate = { id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 60 };
  assert.equal(previewConfigFromGates({ gates: [gate] }), undefined);
});

test('splitPreviewCommand splits the one-time input box like a shell would, for simple cases', () => {
  assert.deepEqual(splitPreviewCommand('npm run dev -- --port {port}'), ['npm', 'run', 'dev', '--', '--port', '{port}']);
  assert.deepEqual(splitPreviewCommand('node "my server.js" {port}'), ['node', 'my server.js', '{port}']);
});

test('two quick starts for one lane share one server', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-preview-'));
  try {
    const wt = await worktree('lane-twice', root);
    const service = new LanePreviews({ logDirectory: path.join(root, 'logs') });
    const config = { command: command('slow'), url: 'http://127.0.0.1:{port}/' };
    const [first, second] = await Promise.all([service.start({ id: 'lane-twice', worktree: wt }, config), service.start({ id: 'lane-twice', worktree: wt }, config)]);
    assert.equal(first.port, second.port);
    await service.stopAll();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

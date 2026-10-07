import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { gateBlocks, gateKind, gateState, processAlive, type JobCheckResult } from '../src/core/jobs';
import type { ProbeOutput } from '../src/core/process';
import { terminateProcessTree } from '../src/core/process';
import { applyRigor, findBrowser, gateCommandsBrief, gateFailureMessage, gateOrder, hasCommandGate, loadGates, parseGatesConfig, rigorReviewGateId, runGateList, runGates, type Gate, type GateContext, type GateRuntime, type PageCapture, type ReviewerSpec, type ScreenshotBrowser } from '../src/core/gates';
import { landingGates } from '../src/core/integration';
import { browserCandidates, connectWithRetry } from '../src/core/gates/browser';
import { resolveCommand } from '../src/core/gates/command';
import { capDiff, chooseReviewer, maxReviewDiffBytes, parseReviewOutput, reviewArguments, reviewerSettings, reviewFails, reviewPrompt } from '../src/core/gates/review';
import { substitutePort } from '../src/core/gates/screenshots';
import type { AgentIsolation } from '../src/core/agentHome';

/** A main checkout with one commit, and a worktree whose branch adds src/feature.ts on top: the work under test. */
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-gates-'));
  const repo = path.join(root, 'repo'), worktree = path.join(root, 'head');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['worktree', 'add', '-q', '-b', 'agent/feature', worktree, base]);
  await writeFile(path.join(worktree, 'src', 'feature.ts'), 'export const feature = true;\n');
  await git(worktree, ['add', '.']); await git(worktree, ['commit', '-qm', 'feature']);
  const writeGates = async (value: unknown) => { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(value)); };
  return { root, repo, worktree, base, writeGates, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

/** A tiny app for the screenshots gate: `node server.cjs <port> [mode] [pids file]`. It answers 500 unless PORT matches its port. */
const serverScript = `
const http = require('http'), fs = require('fs'), { spawn } = require('child_process');
const port = Number(process.argv[2]), mode = process.argv[3] || 'ok', pids = process.argv[4];
if (mode === 'exit') process.exit(3);
if (pids) { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(pids, JSON.stringify({ server: process.pid, child: child.pid })); }
if (mode === 'silent') { setInterval(() => {}, 1000); }
else {
  let hits = 0;
  http.createServer((request, response) => {
    hits++;
    if (process.env.PORT !== String(port)) { response.writeHead(500); return response.end('PORT does not match'); }
    if (mode === 'error') { response.writeHead(500); return response.end('broken'); }
    if (mode === 'slow' && hits <= 3) { response.writeHead(503); return response.end('warming up'); }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><body><h1>Hello from the gate test</h1></body></html>');
  }).listen(port, '127.0.0.1');
}
`;

const png = Buffer.from('89504e470d0a1a0a', 'hex');
/** A browser that never starts: each capture is whatever `page` says for that URL and width. */
function fakeBrowser(page: (url: string, width: number) => Partial<PageCapture> = () => ({})) {
  const calls = { opened: 0, closed: 0, captures: [] as [string, number][] };
  const browser: ScreenshotBrowser = {
    find: async () => 'fake-browser.exe',
    open: async () => {
      calls.opened++;
      return {
        capture: async (url, width) => { calls.captures.push([url, width]); return { errors: [], consoleErrors: [], empty: false, png, height: 800, status: 200, ...page(url, width) }; },
        close: async () => { calls.closed++; },
      };
    },
  };
  return { browser, calls };
}

/** A reviewer that never runs a CLI: it records what it was asked and replies with `reply`. */
function fakeReviewer(reply: (spec: ReviewerSpec) => Partial<ProbeOutput>) {
  const specs: ReviewerSpec[] = [];
  return { specs, runReviewer: async (spec: ReviewerSpec): Promise<ProbeOutput> => { specs.push(spec); return { args: spec.args, stdout: '', stderr: '', exitCode: 0, ...reply(spec) }; } };
}
const claudeEnvelope = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });
const verdict = (value: unknown) => JSON.stringify(value);

/** HSEC-71: a reviewer's isolation, faked so no test reads your own Claude or Codex folders. */
const fakeIsolation: GateRuntime['isolation'] = async (provider): Promise<AgentIsolation> => provider === 'codex'
  ? { env: { CODEX_HOME: 'H:\\codex-home' }, codexArgs: ['--ignore-user-config', '-c', 'features.apps=false'], claudePlugins: [] }
  : { env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }, codexArgs: [], claudePlugins: ['claude-mem@thedotmack'] };
function context(root: string, runtime: Partial<GateRuntime>, extra: Partial<GateContext> = {}): GateContext {
  return { author: 'claude', logDirectory: path.join(root, 'logs', `run-${Math.random().toString(16).slice(2)}`), title: 'Add the feature', brief: 'Add src/feature.ts.', writeScope: ['src/'], executable: async provider => `fake-${provider}`, runtime: { pollMs: 25, isolation: fakeIsolation, ...runtime }, ...extra };
}
const exists = (file: string) => access(file).then(() => true, () => false);
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`); await new Promise(resolve => setTimeout(resolve, 50)); }
}

// ---- gates.json ----

test('gates.json: the plan\'s example is valid, and defaults fill in what it leaves out', () => {
  const parsed = parseGatesConfig({
    maxAttempts: 3, lanes: 'onMerge',
    gates: [
      { id: 'unit', type: 'command', command: ['npm', 'test'], timeoutSeconds: 600, required: true },
      { id: 'ui', type: 'screenshots', start: ['npm', 'run', 'dev', '--', '--port', '{port}'], url: 'http://localhost:{port}/', widths: [390, 768, 1280], readyTimeoutSeconds: 90, required: false },
      { id: 'review', type: 'review', reviewer: 'other', focus: '', required: true },
    ],
  });
  assert.equal(parsed.maxAttempts, 3); assert.equal(parsed.lanes, 'onMerge');
  assert.deepEqual(parsed.gates.map(gate => [gate.id, gate.type, gate.required]), [['unit', 'command', true], ['ui', 'screenshots', false], ['review', 'review', true]]);
  const defaults = parseGatesConfig({ gates: [{ id: 'unit', type: 'command', command: ['npm', 'test'] }, { id: 'look', type: 'screenshots', start: ['node', 's.js'], url: 'https://127.0.0.1:{port}/app' }, { id: 'review', type: 'review' }] });
  assert.equal(defaults.maxAttempts, undefined, 'no maxAttempts means the head default');
  assert.equal(defaults.lanes, 'onMerge');
  assert.deepEqual(defaults.gates, [
    { id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 600 },
    { id: 'look', type: 'screenshots', required: true, start: ['node', 's.js'], url: 'https://127.0.0.1:{port}/app', widths: [390, 768, 1280], readyTimeoutSeconds: 90 },
    { id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' },
  ]);
});

test('gates.json: everything is validated, with the reason', () => {
  const unit = { id: 'unit', type: 'command', command: ['npm', 'test'] };
  const shots = { id: 'ui', type: 'screenshots', start: ['npm', 'start'], url: 'http://localhost:{port}/' };
  const cases: [unknown, RegExp][] = [
    [{ gates: [{ ...unit, id: 'Unit' }] }, /"id" of 1–24 lowercase/],
    [{ gates: [{ ...unit, id: 'x'.repeat(25) }] }, /"id" of 1–24/],
    [{ gates: [unit, { ...unit }] }, /Two gates have the id "unit"/],
    [{ gates: [{ ...unit, command: 'npm test' }] }, /"command" must be a list/],
    [{ gates: [{ ...unit, command: ['npm', 7] }] }, /"command" must be a list/],
    [{ gates: [{ ...unit, command: [] }] }, /"command" must be a list/],
    [{ gates: [{ ...unit, timeoutSeconds: 901 }] }, /"timeoutSeconds" must be a whole number from 1 to 900/],
    [{ gates: [{ ...unit, timeoutSecond: 10 }] }, /unknown setting "timeoutSecond"/],
    [{ gates: [{ ...unit, required: 'yes' }] }, /"required" must be true or false/],
    [{ gates: [{ ...unit, type: 'lint' }] }, /unknown "type"/],
    [{ gates: [{ ...shots, widths: [239] }] }, /each width must be a whole number from 240 to 3840/],
    [{ gates: [{ ...shots, widths: [3841] }] }, /each width/],
    [{ gates: [{ ...shots, widths: [400, 500, 600, 700, 800] }] }, /"widths" must list 1–4/],
    [{ gates: [{ ...shots, widths: [400, 400] }] }, /a width twice/],
    [{ gates: [{ ...shots, url: 'http://example.com/' }] }, /localhost or 127\.0\.0\.1/],
    [{ gates: [{ ...shots, url: 'file:///C:/index.html' }] }, /localhost or 127\.0\.0\.1/],
    [{ gates: [{ ...shots, url: 'http://user:pw@localhost/' }] }, /localhost or 127\.0\.0\.1/],
    [{ gates: [{ ...shots, start: 'npm start' }] }, /"start" must be a list/],
    [{ gates: [{ ...shots, readyTimeoutSeconds: 0 }] }, /readyTimeoutSeconds/],
    [{ gates: [{ id: 'review', type: 'review', reviewer: 'gpt' }] }, /"reviewer" must be "other", "same", "claude" or "codex"/],
    [{ gates: [{ id: 'review', type: 'review', focus: 'x'.repeat(2001) }] }, /"focus"/],
    [{ gates: Array.from({ length: 13 }, (_, index) => ({ ...unit, id: `u${index}` })) }, /at most 12 gates/],
    [{ gates: [], maxAttempts: 0 }, /"maxAttempts" must be a whole number from 1 to 10/],
    [{ gates: [], maxAttempts: 2.5 }, /"maxAttempts"/],
    [{ gates: [], lanes: 'always' }, /"lanes" must be "onMerge" or "off"/],
    [{ gate: [] }, /unknown setting "gate"/],
    [{}, /needs a "gates" list/],
    [[], /must be an object/],
  ];
  for (const [value, message] of cases) assert.throws(() => parseGatesConfig(value), message, JSON.stringify(value));
  assert.equal(parseGatesConfig({ gates: [{ ...shots, url: 'http://127.0.0.1:5173/' }] }).gates.length, 1, 'a fixed port is fine too');
});

test('gates come from gates.json, else checks.json as command gates, else none', async () => {
  const f = await repository();
  try {
    assert.deepEqual(await loadGates(f.repo), { source: 'none', lanes: 'onMerge', gates: [] });
    await mkdir(path.join(f.repo, '.hydra'), { recursive: true });
    await writeFile(path.join(f.repo, '.hydra', 'checks.json'), JSON.stringify({ checks: [{ id: 'unit', command: ['npm', 'test'], timeoutSeconds: 5000 }, { command: ['npm', 'run', 'lint'], required: false }] }));
    assert.deepEqual(await loadGates(f.repo), { source: 'checks', lanes: 'onMerge', gates: [
      { id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 900 },
      { id: 'check-2', type: 'command', required: false, command: ['npm', 'run', 'lint'], timeoutSeconds: 600 },
    ] });
    // gates.json wins over checks.json, and a BOM from a Windows editor is fine.
    await writeFile(path.join(f.repo, '.hydra', 'gates.json'), `\uFEFF${JSON.stringify({ maxAttempts: 2, lanes: 'off', gates: [{ id: 'review', type: 'review' }] })}`);
    const loaded = await loadGates(f.repo);
    assert.equal(loaded.source, 'gates'); assert.equal(loaded.maxAttempts, 2); assert.equal(loaded.lanes, 'off'); assert.deepEqual(loaded.gates.map(gate => gate.id), ['review']);
    // Only the folder it is given: the worktree's own .hydra is never read.
    assert.equal((await loadGates(f.worktree)).source, 'none');
    await writeFile(path.join(f.repo, '.hydra', 'gates.json'), '{ "gates": [ }');
    await assert.rejects(loadGates(f.repo), /\.hydra\/gates\.json isn't valid JSON/);
    await writeFile(path.join(f.repo, '.hydra', 'gates.json'), JSON.stringify({ gates: [{ id: 'x', type: 'command', command: 'npm test' }] }));
    await assert.rejects(loadGates(f.repo), /^Error: \.hydra\/gates\.json: Gate "x": "command" must be a list/);
  } finally { await f.close(); }
});

// ---- The runner ----

test('gates run in order (commands, screenshots, review), and required: false is reported but never blocks', async () => {
  const f = await repository();
  const { browser, calls } = fakeBrowser();
  const reviewer = fakeReviewer(() => ({ stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: verdict({ verdict: 'pass', summary: 'Looks right.', findings: [] }) } })}\n` }));
  try {
    await writeFile(path.join(f.root, 'server.cjs'), serverScript);
    await f.writeGates({ gates: [
      { id: 'review', type: 'review', focus: 'Check the feature flag.' },
      { id: 'ui', type: 'screenshots', start: [process.execPath, path.join(f.root, 'server.cjs'), '{port}'], url: 'http://127.0.0.1:{port}/', widths: [390, 1280], readyTimeoutSeconds: 20 },
      { id: 'lint', type: 'command', command: [process.execPath, '-e', 'console.log("lint says no"); process.exit(2)'], required: false },
      { id: 'unit', type: 'command', command: [process.execPath, '-e', 'process.exit(require("fs").existsSync("src/feature.ts") ? 0 : 1)'] },
    ] });
    const progress: string[] = [];
    const outcome = await runGates(f.repo, f.worktree, f.base, context(f.root, { browser, runReviewer: reviewer.runReviewer }, { onProgress: ({ running }) => { if (running) progress.push(running); } }));
    assert.equal(outcome.source, 'gates'); assert.equal(outcome.lanes, 'onMerge');
    assert.deepEqual(outcome.results.map(result => [result.id, result.kind, result.state]), [['lint', 'command', 'failed'], ['unit', 'command', 'passed'], ['ui', 'screenshots', 'passed'], ['review', 'review', 'passed']]);
    assert.deepEqual(progress, ['lint', 'unit', 'ui', 'review']);
    assert.deepEqual(outcome.failed, [], 'the failed lint gate is not required');
    assert.match(outcome.results[0]!.outputTail, /lint says no/); assert.equal(outcome.results[0]!.exitCode, 2);
    assert.ok(await exists(outcome.results[0]!.evidence![0]!), 'the command log is kept');
    // The reviewer (Codex, the other agent) saw the earlier results and got the screenshots with -i.
    const [spec] = reviewer.specs;
    assert.equal(spec!.provider, 'codex'); assert.equal(spec!.cwd, f.worktree);
    const pictures = outcome.results[2]!.evidence!.filter(file => file.endsWith('.png'));
    assert.equal(pictures.length, 2);
    for (const picture of pictures) assert.ok(await exists(picture), picture);
    assert.deepEqual(spec!.args, ['exec', '--json', '--ignore-user-config', '-c', 'features.apps=false', '-c', "web_search='disabled'", '-i', pictures[0]!, '-i', pictures[1]!, '--sandbox', 'read-only', '-']);
    assert.deepEqual(spec!.env, { CODEX_HOME: 'H:\\codex-home' }, 'HSEC-71: Hydra\'s own Codex home');
    // 1.2: the command's own output is fenced with the prompt's nonce.
    const nonce = /<<<untrusted-([0-9a-f]{16})/.exec(spec!.input)?.[1];
    assert.ok(nonce, 'the prompt carries a nonce');
    assert.match(spec!.input, new RegExp(`- lint \\(command\\): failed\\n<<<untrusted-${nonce}\\nExited with code 2\\.\\n>>>end-untrusted-${nonce}`));
    assert.match(spec!.input, /- unit \(command\): passed/);
    assert.match(spec!.input, /They are attached to this message/);
    assert.match(spec!.input, /## What to focus on\nCheck the feature flag\./);
    assert.match(spec!.input, /\+export const feature = true;/, 'the reviewer sees the diff');
    assert.equal(calls.opened, 1); assert.equal(calls.closed, 1);
    assert.deepEqual(outcome.results[3]!.summary, 'Reviewed by Codex. Looks right.');
  } finally { await f.close(); }
});

test('once a required gate fails, the later gates are skipped; the failure message lists the evidence', async () => {
  const f = await repository();
  const reviewer = fakeReviewer(() => ({}));
  const { browser, calls } = fakeBrowser();
  try {
    const gates: Gate[] = [
      { id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' },
      { id: 'ui', type: 'screenshots', required: true, start: ['x'], url: 'http://localhost:{port}/', widths: [400], readyTimeoutSeconds: 5 },
      { id: 'unit', type: 'command', required: true, command: [process.execPath, '-e', 'console.error("2 tests failed"); process.exit(1)'], timeoutSeconds: 60 },
    ];
    assert.deepEqual(gateOrder(gates).map(gate => gate.id), ['unit', 'ui', 'review']);
    const results = await runGateList(gates, f.worktree, f.base, context(f.root, { browser, runReviewer: reviewer.runReviewer }));
    assert.deepEqual(results.map(result => [result.id, result.state, result.summary]), [['unit', 'failed', 'Exited with code 1.'], ['ui', 'notRun', 'Skipped: unit failed first.'], ['review', 'notRun', 'Skipped: unit failed first.']]);
    assert.equal(reviewer.specs.length, 0, 'no review is spent on work that is going back anyway'); assert.equal(calls.opened, 0);
    const message = gateFailureMessage(results);
    assert.match(message, /^These gates failed:\n- unit \(command, exit 1\): Exited with code 1\.\n2 tests failed/);
    assert.doesNotMatch(message, /Skipped/);
    assert.match(message, /Fix them, commit, and call hydra_done again\.$/);
    await assert.rejects(runGates(f.repo, f.repo, f.base, context(f.root, {})), /never in the main checkout/);
  } finally { await f.close(); }
});

// ---- The review gate ----

test('review: the exact read-only arguments, and the prompt with the diff cap, the task, earlier results, screenshots and focus', () => {
  const claudeBase = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--setting-sources', 'user', '--settings', 'S.json', '--strict-mcp-config', '--disable-slash-commands'];
  const settings = { settingsFile: 'S.json' };
  assert.deepEqual(reviewArguments('claude', [], false, settings), claudeBase);
  assert.deepEqual(reviewArguments('claude', ['a.png'], false, settings), claudeBase, 'Claude reads screenshots by path');
  // `codex exec` searches the web by default (research R7): a review has it off unless its pack role has "web" (R9).
  // HSEC-71: the isolation flags come right after `exec --json`.
  const isolation = { codexArgs: ['--ignore-user-config', '-c', 'features.apps=false'] };
  assert.deepEqual(reviewArguments('codex', [], false, isolation), ['exec', '--json', '--ignore-user-config', '-c', 'features.apps=false', '-c', 'web_search=\'disabled\'', '--sandbox', 'read-only', '-']);
  assert.deepEqual(reviewArguments('codex', ['a.png', 'b.png'], false, isolation), ['exec', '--json', '--ignore-user-config', '-c', 'features.apps=false', '-c', 'web_search=\'disabled\'', '-i', 'a.png', '-i', 'b.png', '--sandbox', 'read-only', '-']);
  assert.deepEqual(reviewArguments('codex', [], true), ['exec', '--json', '-c', 'web_search=\'live\'', '--sandbox', 'read-only', '-']);
  assert.deepEqual(reviewArguments('claude', [], true, settings), [...claudeBase, '--allowedTools', 'WebFetch,WebSearch'], 'still plan mode, with the web tools allowed');
  const syncOff = { syncClaudeAiSkills: false, syncClaudeAiPlugins: false, disableClaudeAiConnectors: true };
  assert.deepEqual(reviewerSettings([]), { disableAllHooks: true, ...syncOff });
  assert.deepEqual(reviewerSettings(['b@m', 'a@m', 'a@m', 'not a plugin']), { disableAllHooks: true, ...syncOff, enabledPlugins: { 'a@m': false, 'b@m': false } }, 'sorted, deduplicated, odd ids left out');

  assert.deepEqual(capDiff('small\n'), { text: 'small\n', cut: false });
  const line = `+${'é'.repeat(99)}\n`;
  const big = capDiff(line.repeat(700));
  assert.equal(big.cut, true);
  assert.ok(Buffer.byteLength(big.text) <= maxReviewDiffBytes, 'at most 60 KB');
  assert.ok(big.text.endsWith('\n') && !big.text.includes('\uFFFD'), 'cut on a line, never inside a character');

  const earlier: JobCheckResult[] = [
    { id: 'unit', kind: 'command', state: 'passed', required: true, passed: true, exitCode: 0, durationMs: 1, outputTail: '' },
    { id: 'ui', kind: 'screenshots', state: 'failed', required: false, passed: false, exitCode: null, durationMs: 1, outputTail: '', summary: 'At 390 px the page logged console.error: boom' },
    { id: 'old', required: true, passed: false, exitCode: 1, durationMs: 1, outputTail: 'an old result, from before gates' },
  ];
  const prompt = reviewPrompt({ provider: 'claude', title: 'Add the feature', brief: 'Add src/feature.ts.', writeScope: ['src/', ''], baseCommit: 'a'.repeat(40), diff: big, earlier, screenshots: ['C:/logs/ui-390.png'], focus: 'Security first.' });
  assert.match(prompt, /## The task\nAdd the feature\n\nAdd src\/feature\.ts\.\n\nIt may change only: src\/, \(the whole repository\)/);
  assert.match(prompt, /`git diff aaaaaaaaaaaa\.\.HEAD`/);
  assert.match(prompt, /\(The diff was cut at 60 KB\. Read the changed files for the rest\.\)/);
  // 1.2: each gate's summary/output is fenced with the prompt's nonce.
  const promptNonce = /<<<untrusted-([0-9a-f]{16})/.exec(prompt)?.[1];
  assert.ok(promptNonce, 'the prompt carries a nonce');
  assert.match(prompt, new RegExp(`- unit \\(command\\): passed\\n- ui \\(screenshots\\): failed\\n<<<untrusted-${promptNonce}\\nAt 390 px the page logged console\\.error: boom\\n>>>end-untrusted-${promptNonce}\\n- old \\(command\\): failed\\n<<<untrusted-${promptNonce}\\nan old result`));
  assert.match(prompt, /Open each of these images to see how the app renders:\n- C:\/logs\/ui-390\.png/);
  assert.match(prompt, /## What to focus on\nSecurity first\./);
  assert.match(prompt, /Reply with JSON only/);
  // Calibrated: a major finding is one people would plausibly hit; contrived extremes are minor, so a review can pass.
  assert.match(prompt, /- major: a real bug that people using this change would plausibly hit/);
  assert.match(prompt, /- minor: .*extreme or contrived inputs the task doesn't call for .*unless it loses data or opens a security hole\. Minor findings never fail a review\./);
  assert.match(prompt, /Judge the change against its task, not against every input imaginable/);
  assert.doesNotMatch(reviewPrompt({ provider: 'codex', baseCommit: 'b'.repeat(40), diff: capDiff('+x\n'), earlier: [], screenshots: [], focus: '' }), /diff was cut|Earlier gates|Screenshots|focus on/);
  // A diff that itself contains a fence can't close the prompt's fence early.
  assert.match(reviewPrompt({ provider: 'codex', baseCommit: 'b'.repeat(40), diff: capDiff('+```js\n'), earlier: [], screenshots: [], focus: '' }), /````diff\n\+```js\n````/);
});

test('review: the reply parser takes the first JSON object (fenced or noisy), and only a blocker or major finding fails', () => {
  const fenced = parseReviewOutput('Here is my review:\n```json\n{"verdict": "fail", "summary": "One real bug.", "findings": [{"file": "src/a.ts", "line": 12, "severity": "major", "note": "Off by one."}, {"severity": "minor", "note": "Rename x."}]}\n```\nThanks!');
  assert.deepEqual(fenced, { verdict: 'fail', summary: 'One real bug.', findings: [{ file: 'src/a.ts', line: 12, severity: 'major', note: 'Off by one.' }, { severity: 'minor', note: 'Rename x.' }] });
  assert.equal(reviewFails(fenced), true);
  const noisy = parseReviewOutput('I looked at {the diff}. {"verdict": "FAIL", "summary": "Nits only { really }", "findings": [{"severity": "nit", "note": "Spacing."}, {"severity": "low", "note": "Naming."}]} trailing {');
  assert.equal(noisy.verdict, 'fail'); assert.equal(reviewFails(noisy), false, 'a fail with only minor findings passes');
  assert.equal(reviewFails(parseReviewOutput('{"verdict": "pass", "summary": "", "findings": [{"severity": "blocker", "note": "x"}]}')), false, 'only a fail verdict can fail');
  assert.equal(parseReviewOutput('{"verdict": "fail", "findings": [{"severity": "catastrophic", "note": "Deletes the database."}]}').findings[0]!.severity, 'major', 'an unknown severity counts as major');
  assert.equal(parseReviewOutput('{"verdict": "fail", "findings": [{"severity": "critical", "note": "x"}, {"note": ""}, "junk"]}').findings.length, 1, 'empty and malformed findings are dropped');
  assert.throws(() => parseReviewOutput('Looks good to me!'), /no JSON object/);
  assert.throws(() => parseReviewOutput('{"result": "pass"}'), /no "verdict"/);
  assert.throws(() => parseReviewOutput('{"verdict": "pass", "findings": "none"}'), /"findings" was not a list/);
});

test('review: the other agent reviews; the same one stands in when the other is missing or limited; forced choices never fall back', async () => {
  const both = async () => ({ ok: true as const, executable: 'x' });
  const only = (provider: 'claude' | 'codex') => async (wanted: 'claude' | 'codex') => wanted === provider ? { ok: true as const, executable: `${wanted}.exe` } : { ok: false as const, reason: `${wanted === 'claude' ? 'Claude Code' : 'Codex'} isn't available (not installed)` };
  assert.deepEqual(await chooseReviewer('other', 'claude', both), { provider: 'codex', executable: 'x' });
  assert.deepEqual(await chooseReviewer('other', 'codex', both), { provider: 'claude', executable: 'x' });
  assert.deepEqual(await chooseReviewer('same', 'codex', both), { provider: 'codex', executable: 'x' });
  assert.deepEqual(await chooseReviewer('other', 'claude', only('claude')), { provider: 'claude', executable: 'claude.exe', note: 'Same-agent review: Codex isn\'t available (not installed), so a fresh read-only Claude Code session reviewed this instead', sameAgent: true });
  assert.deepEqual(await chooseReviewer('codex', 'claude', only('claude')), { notRun: 'Codex isn\'t available (not installed), so nobody reviewed this.' });
  assert.deepEqual(await chooseReviewer('other', 'claude', async wanted => ({ ok: false, reason: `${wanted} missing` })), { notRun: 'codex missing, and claude missing, so nobody reviewed this.' });

  // O6: after a usage-limit handoff, both providers wrote the diff; "other" has no independent
  // choice left, so it reviews with the current author anyway and says the review isn't independent.
  const handoffPick = await chooseReviewer('other', 'codex', both, ['claude']);
  assert.equal('provider' in handoffPick && handoffPick.provider, 'codex', 'the current author, not a fake "other"');
  assert.match('note' in handoffPick ? handoffPick.note! : '', /both worked on this change.*codex reviewed anyway/i);
  assert.equal('sameAgent' in handoffPick && handoffPick.sameAgent, true, 'marked as not independent');
  // The other direction: codex ran first, then claude took over.
  const handoffPick2 = await chooseReviewer('other', 'claude', both, ['codex']);
  assert.equal('provider' in handoffPick2 && handoffPick2.provider, 'claude');
  // A forced choice ('same', 'claude', 'codex') is untouched by priorAuthors: only "other" has no clean pick.
  assert.deepEqual(await chooseReviewer('same', 'codex', both, ['claude']), { provider: 'codex', executable: 'x' });
  // priorAuthors that doesn't include the true "other" changes nothing (no handoff away from the current author).
  assert.deepEqual(await chooseReviewer('other', 'claude', both, ['claude']), { provider: 'codex', executable: 'x' });
  // Both wrote it, and even the current author can't run right now: nobody reviews, and it says why.
  assert.deepEqual(await chooseReviewer('other', 'codex', async () => ({ ok: false, reason: 'Codex is at its usage limit' }), ['claude']), { notRun: 'Codex is at its usage limit, and it\'s the only agent that worked on this change, so nobody reviewed this.' });

  // Through the gate: Codex is at its limit, so Claude reviews Claude's work, and says so.
  const f = await repository();
  const reviewer = fakeReviewer(() => ({ stdout: claudeEnvelope('```json\n{"verdict": "fail", "summary": "It never sets the flag.", "findings": [{"file": "src/feature.ts", "line": 1, "severity": "blocker", "note": "The flag is always true."}]}\n```') }));
  try {
    const gate: Gate = { id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' };
    const [result] = await runGateList([gate], f.worktree, f.base, context(f.root, { runReviewer: reviewer.runReviewer }, { limited: provider => provider === 'codex' }));
    assert.equal(reviewer.specs[0]!.provider, 'claude');
    const settingsFile = path.join(path.dirname(result!.evidence![0]!), 'review-settings.json');
    assert.deepEqual(reviewer.specs[0]!.args, ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--setting-sources', 'user', '--settings', settingsFile, '--strict-mcp-config', '--disable-slash-commands']);
    // HSEC-71: every hook and your plugins off, and no CLAUDE.md.
    assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { disableAllHooks: true, syncClaudeAiSkills: false, syncClaudeAiPlugins: false, disableClaudeAiConnectors: true, enabledPlugins: { 'claude-mem@thedotmack': false } });
    assert.deepEqual(reviewer.specs[0]!.env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
    assert.equal(reviewer.specs[0]!.executable, 'fake-claude'); assert.equal(reviewer.specs[0]!.timeoutMs, 5 * 60_000);
    assert.equal(result!.state, 'failed'); assert.equal(result!.reviewer, 'claude');
    assert.equal(result!.summary, 'Same-agent review: Codex is at its usage limit, so a fresh read-only Claude Code session reviewed this instead. It never sets the flag.');
    assert.equal(result!.sameAgentReview, true, 'the result says the review wasn\'t independent');
    assert.deepEqual(result!.findings, [{ file: 'src/feature.ts', line: 1, severity: 'blocker', note: 'The flag is always true.' }]);
    assert.ok(await exists(result!.evidence![0]!), 'the reply is kept');
    assert.match(gateFailureMessage([result!]), /- review \(review by Claude Code\): Same-agent review: Codex is at its usage limit[\s\S]*\n  - blocker src\/feature\.ts:1: The flag is always true\./);
  } finally { await f.close(); }
});

test('applyRigor (O6): quick and standard add nothing to a job (standard reviews the plan once instead); strict adds a review only when one is missing', () => {
  const command: Gate = { id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 600 };
  assert.deepEqual(applyRigor([command], undefined), [command], 'no rigor: unchanged, like every plan before rigor existed');
  assert.deepEqual(applyRigor([command], 'quick'), [command]);
  assert.deepEqual(applyRigor([command], 'standard'), [command], 'standard reviews the plan once, in its integration gate, not each job');
  const withStrict = applyRigor([command], 'strict');
  assert.deepEqual(withStrict, [command, { id: rigorReviewGateId, type: 'review', required: true, reviewer: 'other', focus: 'Review this change for correctness, safety and fit with the task.' }]);
  // The project's own review, of any kind, is never replaced or duplicated.
  const ownReview: Gate = { id: 'my-review', type: 'review', required: false, reviewer: 'claude', focus: 'x' };
  assert.deepEqual(applyRigor([command, ownReview], 'strict'), [command, ownReview]);
});

test('applyRigor (O6): the same gate id both times, so a snapshot taken at head start and the floor computed at hydra_done agree it\'s already known, not newly added', () => {
  const before = applyRigor([], 'strict');
  const after = applyRigor([], 'strict');
  assert.deepEqual(before, after);
  assert.equal(before[0]!.id, after[0]!.id);
});

test('gateCommandsBrief: a head\'s first prompt hears each gate\'s command (or that it\'s a screenshots/review gate); package.json\'s test script only fills in for a missing command gate', () => {
  const command: Gate = { id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 600 };
  const optional: Gate = { id: 'lint', type: 'command', required: false, command: ['npm', 'run', 'lint'], timeoutSeconds: 300 };
  const shots: Gate = { id: 'ui', type: 'screenshots', required: true, start: ['npm', 'start'], url: 'http://localhost:{port}/', widths: [390], readyTimeoutSeconds: 90 };
  const review: Gate = { id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' };
  const reviewWithRole: Gate = { id: 'review2', type: 'review', required: true, reviewer: 'other', focus: '', role: 'builder' };

  assert.equal(gateCommandsBrief([], undefined), undefined, 'nothing configured, nothing to say');
  // No command gate runs package.json's script, so it gets its own honest sentence, not a line under "Hydra runs these gates" (which would misleadingly say Hydra runs it).
  assert.equal(gateCommandsBrief([], 'node --test'), 'This project has no command gate, so Hydra won\'t run its tests; its test command is `node --test`: run it yourself before hydra_done.');
  assert.equal(hasCommandGate([]), false);

  assert.equal(gateCommandsBrief([command], 'node --test'), 'Hydra runs these gates after you call hydra_done:\n- unit: npm test', 'a command gate already covers testing; package.json\'s script is left out entirely');
  assert.equal(hasCommandGate([command]), true);

  assert.equal(
    gateCommandsBrief([command, optional, shots, review, reviewWithRole]),
    [
      'Hydra runs these gates after you call hydra_done:',
      '- unit: npm test',
      '- lint (optional): npm run lint',
      '- ui: a screenshots gate (http://localhost:{port}/)',
      '- review: a review gate',
      '- review2: a review gate (role: builder)',
    ].join('\n'),
    'command gates first, then screenshots, then review (gateOrder); "(optional)" only for required: false',
  );

  // A review-only project (no command gate) still hears both: what Hydra runs, and that its own test script is on it.
  assert.equal(
    gateCommandsBrief([review], 'node --test'),
    'Hydra runs these gates after you call hydra_done:\n- review: a review gate\n\nThis project has no command gate, so Hydra won\'t run its tests; its test command is `node --test`: run it yourself before hydra_done.',
  );
  assert.equal(hasCommandGate([review]), false);
});

test('review: "not run" with the reason when it can\'t run, and that never fails the work', async () => {
  const f = await repository();
  const gate: Gate = { id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' };
  const run = async (reply: Partial<ProbeOutput>, extra: Partial<GateContext> = {}) => {
    const reviewer = fakeReviewer(() => reply);
    const [result] = await runGateList([gate], f.worktree, f.base, context(f.root, { runReviewer: reviewer.runReviewer }, extra));
    assert.equal(result!.state, 'notRun'); assert.equal(result!.passed, false);
    assert.equal(gateBlocks(result!), false, 'a review that did not run never blocks, even when required');
    return { result: result!, reviewer };
  };
  try {
    // A timeout or a usage limit isn't tried again; a crash or an unreadable reply is, once, and says so.
    const timedOut = await run({ timedOut: true, exitCode: null, error: 'Provider check timed out.' });
    assert.match(timedOut.result.summary!, /^Codex didn't finish its review in 5 minutes\.$/); assert.equal(timedOut.reviewer.specs.length, 1);
    const unreadable = await run({ stdout: 'I think it is fine.' });
    assert.equal(unreadable.result.summary, 'Retried once: the first review didn\'t run. Codex\'s reply wasn\'t the JSON Hydra asked for (the reply had no JSON object).');
    assert.equal(unreadable.reviewer.specs.length, 2);
    const limited = await run({ stdout: `${JSON.stringify({ type: 'error', message: "You've hit your usage limit. Try again at 3:40 PM." })}\n`, exitCode: 1 });
    assert.match(limited.result.summary!, /^Codex hit its usage limit\.$/); assert.equal(limited.reviewer.specs.length, 1);
    const crashed = await run({ exitCode: 2, stderr: 'config error' });
    assert.equal(crashed.result.summary, 'Retried once: the first review didn\'t run. Codex exited with code 2: config error');
    // A limit only on stderr, a reply over the size limit, or a cancel isn't tried again either.
    const stderrLimit = await run({ exitCode: 1, stderr: 'ERROR: 429 Too Many Requests' });
    assert.equal(stderrLimit.reviewer.specs.length, 1); assert.equal(stderrLimit.result.retriedAfter, undefined);
    assert.equal((await run({ exitCode: null, error: 'Provider check exceeded its output limit.' })).reviewer.specs.length, 1);
    // Cancelled while the reviewer ran: not tried again.
    const cancelled = new AbortController();
    const stopping = fakeReviewer(() => { cancelled.abort(); return { exitCode: 1, error: 'Provider check cancelled.' }; });
    const [aborted] = await runGateList([gate], f.worktree, f.base, context(f.root, { runReviewer: stopping.runReviewer }, { signal: cancelled.signal }));
    assert.equal(stopping.specs.length, 1); assert.equal(aborted?.retriedAfter, undefined);
    assert.equal(crashed.result.retriedAfter, 'Codex exited with code 2: config error'); assert.equal(crashed.reviewer.specs.length, 2);
    const missing = await run({}, { executable: async provider => { throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI not found. Install it or set Hydra's ${provider} path.`); } });
    assert.equal(missing.reviewer.specs.length, 0);
    assert.match(missing.result.summary!, /^Codex isn't available \(Codex CLI not found\. Install it or set Hydra's codex path\), and Claude Code isn't available .*, so nobody reviewed this\.$/);
  } finally { await f.close(); }
});

test('review: a reviewer that crashed is retried once, and a retry that reviews gives the verdict, recording the first try', async () => {
  const f = await repository();
  const gate: Gate = { id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' };
  try {
    let calls = 0;
    const reviewer = fakeReviewer(() => ++calls === 1
      ? { exitCode: 1, stderr: 'stream disconnected' }
      : { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: verdict({ verdict: 'pass', summary: 'Looks right.', findings: [] }) } })}\n` });
    const [result] = await runGateList([gate], f.worktree, f.base, context(f.root, { runReviewer: reviewer.runReviewer }));
    assert.equal(reviewer.specs.length, 2);
    assert.equal(result!.state, 'passed', result!.summary);
    assert.equal(result!.retriedAfter, 'Codex exited with code 1: stream disconnected');
    assert.equal(result!.summary, 'Retried once: the first review didn\'t run. Reviewed by Codex. Looks right.');
    // Both replies are kept as evidence: the retry's first.
    assert.deepEqual(result!.evidence!.map(file => path.basename(file)), ['review-reply-retry.txt', 'review-reply.txt', 'review-prompt.md']);
    // A launch failure is retried too; a retry that fails again is "not run", still saying it was retried.
    const twice = fakeReviewer(() => ({ exitCode: null, error: 'spawn EPERM' }));
    const [again] = await runGateList([gate], f.worktree, f.base, context(f.root, { runReviewer: twice.runReviewer }));
    assert.equal(twice.specs.length, 2);
    assert.deepEqual([again!.state, again!.retriedAfter, again!.summary], ['notRun', 'Codex couldn\'t review: spawn EPERM', 'Retried once: the first review didn\'t run. Codex couldn\'t review: spawn EPERM']);
    // The first try's reason is redacted in the result and in the log, like everything else a gate keeps.
    const lines: string[] = [];
    const leaky = fakeReviewer(() => ({ exitCode: 1, stderr: 'auth failed for token SECRET123' }));
    const [masked] = await runGateList([gate], f.worktree, f.base, context(f.root, { runReviewer: leaky.runReviewer }, { redact: text => text.replace(/SECRET123/g, '***'), log: line => lines.push(line) }));
    assert.equal(masked!.retriedAfter, 'Codex exited with code 1: auth failed for token ***');
    assert.ok(lines.some(line => line.includes('Retrying the review once')), lines.join('\n'));
    assert.ok(!lines.some(line => line.includes('SECRET123')), lines.join('\n'));
  } finally { await f.close(); }
});

// ---- The screenshots gate ----

test('screenshots: a free port as {port} and PORT, ready polling, PNGs under the log folder, and the app\'s tree killed', async () => {
  const f = await repository();
  const { browser, calls } = fakeBrowser();
  const killed: number[] = [];
  try {
    assert.equal(substitutePort('http://localhost:{port}/x?p={port}', 4321), 'http://localhost:4321/x?p=4321');
    await writeFile(path.join(f.root, 'server.cjs'), serverScript);
    const pids = path.join(f.root, 'pids.json');
    const gate: Gate = { id: 'ui', type: 'screenshots', required: true, start: [process.execPath, path.join(f.root, 'server.cjs'), '{port}', 'slow', pids], url: 'http://127.0.0.1:{port}/', widths: [390, 1280], readyTimeoutSeconds: 30 };
    const run = context(f.root, { browser, terminate: async pid => { killed.push(pid); await terminateProcessTree(pid); } });
    const [result] = await runGateList([gate], f.worktree, f.base, run);
    assert.equal(result!.state, 'passed', result!.outputTail); assert.equal(result!.summary, '2 screenshots; no problems.');
    // The server answered 503 three times, then 200 once PORT matched its {port}.
    const port = Number(/:(\d+)\//.exec(calls.captures[0]![0])![1]);
    assert.ok(port > 0);
    assert.deepEqual(calls.captures, [[`http://127.0.0.1:${port}/`, 390], [`http://127.0.0.1:${port}/`, 1280]]);
    assert.deepEqual(result!.evidence!.map(file => path.relative(run.logDirectory, file)), ['ui-390.png', 'ui-1280.png', 'ui-server.log']);
    for (const file of result!.evidence!) assert.ok(await exists(file), file);
    const { server, child } = JSON.parse(await readFile(pids, 'utf8')) as { server: number; child: number };
    assert.deepEqual(killed, [server], 'the start command\'s tree is killed');
    await until(() => !processAlive(server) && !processAlive(child), 'the app and what it started are gone');
    assert.equal(calls.closed, 1, 'the browser is closed');
  } finally { await f.close(); }
});

test('screenshots: the fail rules (not ready, HTTP >= 400, errors, console.error, an empty body), and cleanup after each', async () => {
  const f = await repository();
  try {
    await writeFile(path.join(f.root, 'server.cjs'), serverScript);
    const gate = (mode: string, readyTimeoutSeconds = 30, widths = [400]): Gate => ({ id: 'ui', type: 'screenshots', required: true, start: [process.execPath, path.join(f.root, 'server.cjs'), '{port}', mode], url: 'http://localhost:{port}/', widths, readyTimeoutSeconds });
    const shoot = async (mode: string, page?: (url: string, width: number) => Partial<PageCapture>, readyTimeoutSeconds?: number, widths?: number[]) => {
      const { browser, calls } = fakeBrowser(page);
      const killed: number[] = [];
      const [result] = await runGateList([gate(mode, readyTimeoutSeconds, widths)], f.worktree, f.base, context(f.root, { browser, terminate: async pid => { killed.push(pid); await terminateProcessTree(pid); } }));
      assert.equal(killed.length, 1, 'the app is always killed');
      return { result: result!, calls };
    };
    const broken = await shoot('ok', (_url, width) => width === 400 ? { consoleErrors: ['Failed to fetch /api'], errors: ['TypeError: x is undefined'] } : width === 800 ? { empty: true } : { status: 404 }, 30, [400, 800, 1200]);
    assert.equal(broken.result.state, 'failed');
    assert.deepEqual(broken.result.outputTail.split('\n'), [
      'At 400 px: TypeError: x is undefined',
      'At 400 px the page logged console.error: Failed to fetch /api',
      'At 800 px the page rendered empty (no text and no images).',
      'At 1200 px the page answered HTTP 404.',
    ]);
    assert.equal(broken.result.summary, 'At 400 px: TypeError: x is undefined (4 problems)');
    assert.equal(broken.result.evidence!.filter(file => file.endsWith('.png')).length, 3, 'every width is still captured as evidence');
    assert.match(gateFailureMessage([broken.result]), /- ui \(screenshots\): At 400 px[\s\S]*\n  Screenshots: .*ui-400\.png, .*ui-800\.png, .*ui-1200\.png/);

    const error = await shoot('error', undefined, 1);
    assert.equal(error.result.state, 'failed'); assert.match(error.result.summary!, /^The page answered HTTP 500 \(http:\/\/localhost:\d+\/\) and never got ready in 1 s\.$/);
    assert.equal(error.calls.opened, 0, 'no browser for an app that never got ready');
    const silent = await shoot('silent', undefined, 1);
    assert.match(silent.result.summary!, /^The page never got ready in 1 s \(http:\/\/localhost:\d+\/\)\.$/);
    const exits = await shoot('exit');
    assert.match(exits.result.summary!, /^The start command exited with code 3 before the page was ready\.$/);
  } finally { await f.close(); }
});

test('screenshots: with no browser installed the gate is not run and the app never starts', async () => {
  const f = await repository();
  try {
    const marker = path.join(f.root, 'started.txt');
    const gate: Gate = { id: 'ui', type: 'screenshots', required: true, start: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], url: 'http://localhost:{port}/', widths: [400], readyTimeoutSeconds: 5 };
    const [result] = await runGateList([gate], f.worktree, f.base, context(f.root, { browser: { find: async () => undefined, open: async () => { throw new Error('never'); } } }));
    assert.equal(result!.state, 'notRun'); assert.equal(result!.summary, 'No Edge, Chrome or Chromium was found, so no screenshots were taken.');
    assert.equal(await exists(marker), false);
  } finally { await f.close(); }
});

test('screenshots: browser discovery prefers Edge on Windows, then Chrome or Chromium', async () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' };
  const candidates = browserCandidates('win32', env);
  assert.equal(candidates[0], 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe');
  const pick = (present: string[]) => findBrowser('win32', env, async file => present.includes(file));
  assert.equal(await pick(['C:\\PF\\Google\\Chrome\\Application\\chrome.exe', 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe']), 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(await pick(['C:\\Local\\Google\\Chrome\\Application\\chrome.exe']), 'C:\\Local\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(await pick([]), undefined);
  assert.equal(await findBrowser('linux', { PATH: '/opt/bin' }, async file => file === '/opt/bin/chromium'), '/opt/bin/chromium');
  assert.equal((await findBrowser('darwin', {}, async file => file.includes('Google Chrome'))), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
});

test('a real headless browser captures a tiny local page (skipped when no Edge or Chrome is installed)', async t => {
  const executable = await findBrowser();
  if (!executable) { t.skip('No Edge, Chrome or Chromium is installed.'); return; }
  const f = await repository();
  try {
    await writeFile(path.join(f.root, 'server.cjs'), serverScript);
    const gate: Gate = { id: 'ui', type: 'screenshots', required: true, start: [process.execPath, path.join(f.root, 'server.cjs'), '{port}'], url: 'http://127.0.0.1:{port}/', widths: [480], readyTimeoutSeconds: 30 };
    const pids: number[] = [];
    const [result] = await runGateList([gate], f.worktree, f.base, context(f.root, {}, { spawned: pid => { pids.push(pid); } }));
    assert.equal(result!.state, 'passed', `${result!.summary}\n${result!.outputTail}`);
    const picture = result!.evidence!.find(file => file.endsWith('.png'))!;
    const bytes = await readFile(picture);
    assert.ok(bytes.subarray(0, 8).equals(png), 'a real PNG'); assert.ok(bytes.length > 1000);
    assert.equal(pids.length, 2, 'the app and the browser were both tracked');
    await until(() => pids.every(pid => !processAlive(pid)), 'no app or browser left running', 15_000);
  } finally { await f.close(); }
});

// ---- Small pieces ----

test('results recorded before gates stay readable: a command that passed or failed', () => {
  const old = (passed: boolean): JobCheckResult => ({ id: 'unit', required: true, passed, exitCode: passed ? 0 : 1, durationMs: 5, outputTail: '' });
  assert.deepEqual([gateKind(old(true)), gateState(old(true)), gateBlocks(old(true))], ['command', 'passed', false]);
  assert.deepEqual([gateKind(old(false)), gateState(old(false)), gateBlocks(old(false))], ['command', 'failed', true]);
  assert.equal(gateBlocks({ ...old(false), required: false }), false);
});

test('command gates find npm.cmd on Windows; anything with a path or an extension is left alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-resolve-'));
  try {
    await writeFile(path.join(root, 'tool.cmd'), '@echo off\r\n');
    const env = { PATH: `C:\\nowhere;${root}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(await resolveCommand('tool', 'win32', env), path.join(root, 'tool.cmd'));
    assert.equal(await resolveCommand('tool.cmd', 'win32', env), 'tool.cmd');
    assert.equal(await resolveCommand('C:\\x\\tool', 'win32', env), 'C:\\x\\tool');
    assert.equal(await resolveCommand('missing', 'win32', env), 'missing');
    assert.equal(await resolveCommand('tool', 'linux', env), 'tool');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connectWithRetry: a refused DevTools connection right after the browser starts is tried again; a gone browser or the deadline stops it', async () => {
  let tries = 0;
  assert.equal(await connectWithRetry(async () => { if (++tries < 3) throw new Error('refused'); return 'connected'; }, () => false, 2000, 5), 'connected');
  assert.equal(tries, 3);
  let exitedTries = 0;
  await assert.rejects(connectWithRetry(async () => { exitedTries++; throw new Error('refused'); }, () => true, 2000, 5), /refused/);
  assert.equal(exitedTries, 1, 'the browser is gone: no point trying again');
  await assert.rejects(connectWithRetry(async () => { throw new Error('refused'); }, () => false, 50, 5), /refused/, 'bounded');
  // An attempt that hangs is given only the time left, so a stalled handshake can't stretch the whole budget.
  const started = Date.now(); const budgets: number[] = [];
  await assert.rejects(connectWithRetry(remaining => { budgets.push(remaining); return new Promise((_, reject) => setTimeout(() => reject(new Error('did not open')), remaining)); }, () => false, 120, 5), /did not open/);
  assert.ok(budgets[0]! <= 120 && Date.now() - started < 400, 'the whole connect stays within its budget');
});

test('gates.json: onLanding marks a command gate for the seam check after each landing, and only a command gate, as a boolean', () => {
  const parsed = parseGatesConfig({ gates: [{ id: 'types', type: 'command', command: ['npx', 'tsc'], onLanding: true }, { id: 'unit', type: 'command', command: ['npm', 'test'] }, { id: 'off', type: 'command', command: ['npm', 'run', 'x'], onLanding: false }] });
  assert.deepEqual(landingGates(parsed).map(gate => gate.id), ['types'], 'only the marked gate');
  assert.deepEqual(parsed.gates.map(gate => 'onLanding' in gate), [true, false, false], 'false is the same as leaving it out');
  assert.deepEqual(landingGates(parseGatesConfig({ gates: [{ id: 'unit', type: 'command', command: ['npm', 'test'] }] })), [], 'no flag, no seam check');
  assert.throws(() => parseGatesConfig({ gates: [{ id: 'types', type: 'command', command: ['tsc'], onLanding: 'yes' }] }), /"onLanding" must be true or false/);
  assert.throws(() => parseGatesConfig({ gates: [{ id: 'look', type: 'screenshots', start: ['x'], url: 'http://localhost:{port}/', onLanding: true }] }), /unknown setting "onLanding"/);
  assert.throws(() => parseGatesConfig({ gates: [{ id: 'r', type: 'review', onLanding: true }] }), /unknown setting "onLanding"/);
});

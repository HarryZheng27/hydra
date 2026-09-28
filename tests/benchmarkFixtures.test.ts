import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFromLeadInput, findCycle, writeScopeOverlap, maxPlanJobs } from '../src/core/plans';
import { planFileArguments } from '../src/core/hydraCli';
import { defaultIntegrationFixRounds } from '../src/core/integration';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { taskFromPlan, parseCheckOutput, harnessOnlyFiles } from '../scripts/benchmark-lib.mjs';

/**
 * O9 (docs/Benchmark.md): the larger fixtures in bench/fixtures, checked without an agent: each plan file is valid
 * (Hydra's own checks and the published schema), its jobs split with no shared files, the single agent's prompt is
 * the plan's, the starting code passes its own tests, and the hidden check doesn't pass it yet.
 */

const root = process.cwd();
const fixturesDir = path.join(root, 'bench', 'fixtures');
const script = path.join(root, 'scripts', 'benchmark.mjs');
const expected = ['cli-toolkit', 'kanban-app', 'module-refactor'];

function node(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

type Schema = { type?: string; required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema; pattern?: string; enum?: unknown[]; minItems?: number; maxItems?: number };
/** The parts of JSON Schema that schemas/hydra-plan.schema.json uses; returns every problem found. */
function schemaProblems(schema: Schema, value: unknown, at = '$'): string[] {
  const problems: string[] = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && schema.type !== type) return [`${at} should be ${schema.type}, is ${type}`];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} should be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${at} doesn't match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => problems.push(...schemaProblems(schema.items!, item, `${at}[${index}]`)));
  }
  if (type === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${at}.${key} is missing`);
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) problems.push(...schemaProblems(property, item, `${at}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key} isn't allowed`);
    }
  }
  return problems;
}

async function fixture(name: string) {
  const dir = path.join(fixturesDir, name);
  const planText = await readFile(path.join(dir, '.hydra', 'plans', `${name}.json`), 'utf8');
  return { dir, planText, plan: JSON.parse(planText) as { title: string; brief: string; jobs: { key: string; title: string; brief: string; write_scope: string[]; depends_on?: string[] }[] } };
}

test('the larger fixtures are there, each with one plan named after it', async () => {
  assert.deepEqual((await readdir(fixturesDir)).sort(), expected);
  for (const name of expected) assert.deepEqual(await readdir(path.join(fixturesDir, name, '.hydra', 'plans')), [`${name}.json`]);
});

for (const name of expected) {
  test(`${name}: the plan file matches the published schema and passes the checks hydra plan run makes`, async () => {
    const { planText, plan } = await fixture(name);
    const schema = JSON.parse(await readFile(path.join(root, 'schemas', 'hydra-plan.schema.json'), 'utf8'));
    assert.deepEqual(schemaProblems(schema, plan), []);
    const args = planFileArguments(planText, `${name}.json`, { unattended: true, minutes: 120, usd: 60 }, () => 'k');
    const created = planFromLeadInput(args as never, { leadSessionId: 'user', idempotencyKey: 'k' }, 5);
    assert.equal(findCycle(created.jobs), undefined);
    assert.ok(created.jobs.length + defaultIntegrationFixRounds <= maxPlanJobs, 'room for both rounds of integration fixes');
    assert.ok(created.jobs.every(job => job.brief.length > 200), 'every brief says exactly what to build');
  });

  test(`${name}: jobs split into a wide parallel stage and one final job, with no two jobs sharing a file`, async () => {
    const { plan } = await fixture(name);
    for (const [index, a] of plan.jobs.entries()) for (const b of plan.jobs.slice(index + 1)) assert.equal(writeScopeOverlap(a.write_scope, b.write_scope), undefined, `${a.key} and ${b.key} share a file`);
    const level = new Map<string, number>();
    const depth = (key: string): number => { if (!level.has(key)) { const job = plan.jobs.find(item => item.key === key)!; level.set(key, job.depends_on?.length ? 1 + Math.max(...job.depends_on.map(depth)) : 0); } return level.get(key)!; };
    const levels = plan.jobs.map(job => depth(job.key));
    const widths = [...new Set(levels)].map(value => levels.filter(item => item === value).length);
    assert.ok(Math.max(...widths) >= 6, `a stage of at least 6 jobs that run at once (${widths.join(', ')})`);
    const sinks = plan.jobs.filter(job => !plan.jobs.some(other => other.depends_on?.includes(job.key)));
    assert.equal(sinks.length, 1, 'one final job');
    const integrating = plan.jobs.filter(job => (job.depends_on?.length ?? 0) >= 5).length;
    assert.ok(integrating >= 1 && integrating <= 2, `one or two jobs bring a whole stage together (${integrating})`);
  });

  test(`${name}: prompt.md is the plan's brief (taskFromPlan), so both setups get the same work`, async () => {
    const { dir, plan } = await fixture(name);
    // A Windows checkout may have turned the line endings into CRLF; the words are what must match.
    assert.equal((await readFile(path.join(dir, 'prompt.md'), 'utf8')).replace(/\r\n/g, '\n'), taskFromPlan(plan), 'regenerate prompt.md from the plan');
    for (const file of ['README.md', 'SPEC.md', 'package.json', 'check.mjs']) await access(path.join(dir, file));
    const gates = JSON.parse(await readFile(path.join(dir, '.hydra', 'gates.json'), 'utf8'));
    assert.deepEqual(gates.gates.map((gate: { id: string; command: string[] }) => [gate.id, gate.command.join(' ')]), [['test', 'npm test']]);
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node --test');
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
  });

  test(`${name}: the starting code passes its own tests, and the hidden check doesn't pass it yet`, async () => {
    const { dir } = await fixture(name);
    const tests = await node(['--test'], dir);
    assert.equal(tests.code, 0, tests.stdout + tests.stderr);
    const checked = await node([path.join(dir, 'check.mjs'), dir], dir);
    const result = parseCheckOutput(checked.stdout, checked.code);
    assert.equal(result.error, undefined, checked.stdout + checked.stderr);
    assert.equal(result.passed, false);
    assert.ok(result.checks >= 15 && result.failed.length > 0, `${result.checks} checks, ${result.failed.length} failed`);
  });
}

test('benchmark.mjs prepare --fixture copies the fixture without its prompt and check, and records the fixture and task', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const prepared = await node([script, 'prepare', '--fixture', 'cli-toolkit', '--out', out]);
    assert.equal(prepared.code, 0, prepared.stderr);
    for (const repo of ['hydra', 'single']) {
      const files = await readdir(path.join(out, repo));
      for (const hidden of harnessOnlyFiles as string[]) assert.equal(files.includes(hidden), false, `${hidden} stays out of ${repo}`);
      assert.ok(files.includes('SPEC.md') && files.includes('.hydra'));
    }
    const info = JSON.parse(await readFile(path.join(out, 'benchmark.json'), 'utf8'));
    assert.deepEqual([info.fixture, info.task], ['cli-toolkit', 'cli-toolkit']);
    const unknown = await node([script, 'prepare', '--fixture', 'nope', '--out', path.join(out, 'x')]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no fixture nope/);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs single runs Claude Code isolated like a head: user plugins off, no MCP servers, the project\'s tools allowed', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    assert.equal((await node([script, 'prepare', '--fixture', 'cli-toolkit', '--out', out])).code, 0);
    const config = path.join(out, 'claude-config');
    await mkdir(path.join(config, 'plugins'), { recursive: true });
    await writeFile(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'helper@market': true } }));
    await writeFile(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'other@market': [] } }));
    const fake = path.join(root, 'tests', 'fixtures', 'bench', 'fake-agent.cjs');
    const ran = await node([script, 'single', '--repo', path.join(out, 'single'), '--claude', `"${process.execPath}" "${fake}"`], root, { ...process.env, CLAUDE_CONFIG_DIR: config });
    assert.equal(ran.code, 0, ran.stderr);
    const args = JSON.parse(await readFile(path.join(out, 'fake-agent-args.json'), 'utf8')) as string[];
    const settings = JSON.parse(await readFile(args[args.indexOf('--settings') + 1]!, 'utf8'));
    assert.deepEqual(settings, { enabledPlugins: { 'helper@market': false, 'other@market': false } });
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1]!, 'utf8')), { mcpServers: {} });
    assert.match(args[args.indexOf('--allowedTools') + 1]!, /Bash\(npm:\*\),Bash\(node:\*\),Bash\(git:\*\)/);
    const results = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
    assert.equal(results.isolation.pluginsOff, 2);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs single on a prepared fixture sends its prompt.md, and records the hidden check\'s result', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    assert.equal((await node([script, 'prepare', '--fixture', 'cli-toolkit', '--out', out])).code, 0);
    const fake = path.join(root, 'tests', 'fixtures', 'bench', 'fake-agent.cjs');
    const ran = await node([script, 'single', '--repo', path.join(out, 'single'), '--command', `"${process.execPath}" "${fake}"`]);
    assert.equal(ran.code, 0, ran.stderr);
    const results = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
    assert.deepEqual([results.fixture, results.task, results.gate.passed], ['cli-toolkit', 'cli-toolkit', true], 'the fixture came from benchmark.json');
    assert.equal(await readFile(path.join(out, 'fake-agent-task.md'), 'utf8'), await readFile(path.join(fixturesDir, 'cli-toolkit', 'prompt.md'), 'utf8'));
    assert.equal(results.check.passed, false, 'the untouched fixture fails the hidden check');
    assert.ok(results.check.checks > 0 && results.check.failed.length > 0);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

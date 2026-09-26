import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkNpxPin, exactVersionPattern, fileCache, integrityPattern, npxPackageArg, npxRunner, parsePackageSpec, pinLabel, requireExactVersion,
  type PackageSpec, type RegistryFetcher,
} from '../src/core/packs/npxPin';
import { checkPackContents, parsePackManifest } from '../src/core/packs/format';
import { loadPack } from '../src/core/packs/registry';

// ---- Naming the package (5.4: refused when the pack loads) ----

test('npxRunner: npx, bunx and pnpx only, by any extension or path', () => {
  assert.equal(npxRunner('npx'), 'npx');
  assert.equal(npxRunner('npx.cmd'), 'npx');
  assert.equal(npxRunner('C:\\nvm\\bunx.CMD'), 'bunx');
  assert.equal(npxRunner('/usr/bin/pnpx'), 'pnpx');
  assert.equal(npxRunner('node'), undefined);
  assert.equal(npxRunner('{node}'), undefined);
});

test('npxPackageArg: skips -y/--yes, reads -p/--package, and gives up on any other flag first', () => {
  assert.equal(npxPackageArg(['-y', 'pkg@1.2.3', '--flag']), 'pkg@1.2.3');
  assert.equal(npxPackageArg(['--yes', '@scope/pkg@1.2.3']), '@scope/pkg@1.2.3');
  assert.equal(npxPackageArg(['-p', 'pkg@1.2.3', 'pkg-bin']), 'pkg@1.2.3');
  assert.equal(npxPackageArg(['--package=pkg@1.2.3', 'pkg-bin']), 'pkg@1.2.3');
  assert.equal(npxPackageArg(['pkg@1.2.3']), 'pkg@1.2.3');
  assert.equal(npxPackageArg(['--api-key', 'x']), undefined);
  assert.equal(npxPackageArg([]), undefined);
});

test('parsePackageSpec: scoped names, prerelease versions, and refusing git/url/file specs and bare names', () => {
  assert.deepEqual(parsePackageSpec('lighthouse-mcp@1.2.3'), { name: 'lighthouse-mcp', version: '1.2.3' });
  assert.deepEqual(parsePackageSpec('@playwright/mcp@0.0.82'), { name: '@playwright/mcp', version: '0.0.82' });
  assert.deepEqual(parsePackageSpec('pkg@1.2.3-beta.1'), { name: 'pkg', version: '1.2.3-beta.1' });
  assert.equal(parsePackageSpec('lighthouse-mcp'), undefined, 'a bare name has no @version to split on');
  assert.equal(parsePackageSpec('@scope/pkg'), undefined, 'a scope with no version after it');
  assert.equal(parsePackageSpec('git+https://example.com/pkg.git'), undefined);
  assert.equal(parsePackageSpec('https://example.com/pkg.tgz'), undefined);
  assert.equal(parsePackageSpec('file:../local-pkg'), undefined);
  assert.equal(parsePackageSpec(''), undefined);
});

test('exactVersionPattern: MAJOR.MINOR.PATCH with an optional prerelease/build, never a range or a tag', () => {
  for (const version of ['1.2.3', '0.0.82', '10.20.30', '1.2.3-beta.1', '1.2.3+build.5', '1.2.3-rc.1+build.2']) assert.ok(exactVersionPattern.test(version), version);
  for (const version of ['^1.2.3', '~1.2.3', '>=1.2.3', '1.2.x', '1.2', '*', 'latest', 'next']) assert.ok(!exactVersionPattern.test(version), version);
});

test('requireExactVersion: refuses a range, a tag, a bare name and a missing package; passes an exact (scoped or prerelease) pin; no-ops for a non-npx command', () => {
  const label = 'MCP server "s"';
  assert.deepEqual(requireExactVersion('npx', ['-y', 'pkg@1.2.3'], label), { name: 'pkg', version: '1.2.3' });
  assert.deepEqual(requireExactVersion('npx', ['-y', '@playwright/mcp@0.0.82'], label), { name: '@playwright/mcp', version: '0.0.82' });
  assert.deepEqual(requireExactVersion('bunx', ['pkg@1.2.3-beta.1'], label), { name: 'pkg', version: '1.2.3-beta.1' });
  assert.equal(requireExactVersion('node', ['{pack}/server.mjs'], label), undefined, 'the rule only applies to npx/bunx/pnpx');
  assert.throws(() => requireExactVersion('npx', ['-y', 'pkg@^1.2.3'], label), /must name an exact version/);
  assert.throws(() => requireExactVersion('pnpx', ['-y', 'pkg@latest'], label), /must name an exact version/);
  assert.throws(() => requireExactVersion('npx', ['-y', 'pkg'], label), /must name an exact version/);
  assert.throws(() => requireExactVersion('npx', ['-y'], label), /names no package to pin/);
});

test('pack.json: a pinned npx server needs an exact version; ranges, tags, bare names and git/url specs are refused when the pack loads', () => {
  const manifest: any = {
    version: 1, id: 'kit', title: 'Kit', description: 'd',
    roles: [], gates: [],
    mcpServers: { s: { type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.2.3'] } },
  };
  assert.doesNotThrow(() => parsePackManifest(manifest));
  const bad = (target: string) => { const copy = JSON.parse(JSON.stringify(manifest)); copy.mcpServers.s.args = ['-y', target]; return copy; };
  assert.throws(() => parsePackManifest(bad('pkg@^1.2.3')), /must name an exact version/);
  assert.throws(() => parsePackManifest(bad('pkg@latest')), /must name an exact version/);
  assert.throws(() => parsePackManifest(bad('pkg')), /must name an exact version/);
  assert.throws(() => parsePackManifest(bad('git+https://example.com/pkg.git')), /must name an exact version/);
});

// ---- integrity: format and where it's allowed ----

test('integrityPattern: an npm sha512 integrity string', () => {
  assert.ok(integrityPattern.test('sha512-OCqftfb8H4dnqm/njbTBRk3seUvUPttOlJUxCtEzXGETYOlRH5Qt3bbXIjmZIuWAxD9RF+yg1ASrPeXvm0y5cA=='));
  assert.ok(!integrityPattern.test('sha1-abcd'));
  assert.ok(!integrityPattern.test('not-an-integrity'));
});

test('pack.json: "integrity" is validated and only allowed on an npx/bunx/pnpx stdio server', () => {
  const withIntegrity = (integrity: unknown, command = 'npx') => ({
    version: 1, id: 'kit', title: 'Kit', description: 'd', roles: [], gates: [],
    mcpServers: { s: { type: 'stdio', command, args: command === 'npx' ? ['-y', 'pkg@1.2.3'] : [], integrity } },
  });
  const good = 'sha512-OCqftfb8H4dnqm/njbTBRk3seUvUPttOlJUxCtEzXGETYOlRH5Qt3bbXIjmZIuWAxD9RF+yg1ASrPeXvm0y5cA==';
  const manifest = parsePackManifest(withIntegrity(good));
  assert.equal(manifest.integrity?.s, good);
  assert.throws(() => parsePackManifest(withIntegrity('sha1-nope')), /"integrity" must be an npm integrity hash/);
  assert.throws(() => parsePackManifest(withIntegrity(good, 'node')), /"integrity" only applies to a server run with npx, bunx or pnpx/);
});

test('pinLabel: shows the pin, with or without an integrity hash', () => {
  const pin: PackageSpec = { name: '@playwright/mcp', version: '0.0.82' };
  assert.equal(pinLabel(undefined, undefined), undefined);
  assert.equal(pinLabel(pin, undefined), 'Not pinned to an integrity hash');
  assert.equal(pinLabel(pin, 'sha512-OCqftfb8H4dnqm/njbTBRk3seUvUPttOlJUxCtEzXGETYOlRH5Qt3bbXIjmZIuWAxD9RF+yg1ASrPeXvm0y5cA=='), 'Pinned: @playwright/mcp@0.0.82, integrity sha512-OCqftfb8H4dn…');
});

// ---- The registry check and its cache ----

const spec: PackageSpec = { name: 'pkg', version: '1.2.3' };
const pinned = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const other = 'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==';

function countingFetcher(result: () => Promise<string> | string): { fetcher: RegistryFetcher; calls: () => number } {
  let calls = 0;
  return { fetcher: async (name, version) => { calls++; assert.equal(name, 'pkg'); assert.equal(version, '1.2.3'); return result(); }, calls: () => calls };
}
function memoryCache() {
  const map = new Map<string, string>();
  return { get: async (key: string) => map.get(key), set: async (key: string, value: string) => { map.set(key, value); } };
}

test('checkNpxPin: a matching pin passes and is cached; the fetcher is called once across two checks', async () => {
  const { fetcher, calls } = countingFetcher(() => pinned);
  const cache = memoryCache();
  assert.deepEqual(await checkNpxPin(spec, pinned, fetcher, cache), { ok: true });
  assert.equal(calls(), 1);
  assert.deepEqual(await checkNpxPin(spec, pinned, fetcher, cache), { ok: true });
  assert.equal(calls(), 1, 'the second check hit the cache, not the registry');
});

test('checkNpxPin: a mismatch is refused, naming both values, and isn\'t cached', async () => {
  const { fetcher, calls } = countingFetcher(() => other);
  const cache = memoryCache();
  const result = await checkNpxPin(spec, pinned, fetcher, cache);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.reason, new RegExp(pinned)); assert.match(result.reason, new RegExp(other)); }
  assert.equal(await cache.get('pkg@1.2.3'), undefined);
  await checkNpxPin(spec, pinned, fetcher, cache);
  assert.equal(calls(), 2, 'a mismatch is checked again next time, not cached');
});

test('checkNpxPin: a failed registry fetch refuses the server, naming the error', async () => {
  const fetcher: RegistryFetcher = async () => { throw new Error('the registry answered 404 for pkg@1.2.3'); };
  const result = await checkNpxPin(spec, pinned, fetcher, memoryCache());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /couldn't check pkg@1\.2\.3.*404/s);
});

test('fileCache: a JSON file under the given folder, read back after a fresh instance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-npxpin-'));
  try {
    const file = path.join(root, 'nested', 'npx-pin-cache.json');
    const first = fileCache(file);
    assert.equal(await first.get('pkg@1.2.3'), undefined);
    await first.set('pkg@1.2.3', pinned);
    const second = fileCache(file);
    assert.equal(await second.get('pkg@1.2.3'), pinned);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

// ---- The shipped Coding pack ----

test('the shipped Coding pack: Playwright is pinned to an exact version and carries an integrity hash', async () => {
  const coding = await loadPack(path.resolve('packs', 'coding'), 'builtin');
  assert.ok(coding.valid, coding.problem);
  const manifest = coding.valid!.manifest;
  const playwright = manifest.mcpServers.playwright;
  assert.ok(playwright && playwright.type === 'stdio');
  assert.equal(npxRunner(playwright.command), 'npx');
  const pin = parsePackageSpec(npxPackageArg(playwright.args)!);
  assert.deepEqual(pin && { ...pin }, { name: '@playwright/mcp', version: '0.0.82' });
  const integrity = manifest.integrity?.playwright;
  assert.ok(integrity && integrityPattern.test(integrity), 'the shipped pack pins an integrity hash for Playwright');
  assert.match(coding.valid!.servers.playwright!.pinLabel!, /^Pinned: @playwright\/mcp@0\.0\.82, integrity sha512-/);
});

test('checkPackContents: a server with no pin has no pin label; a pinned server without an integrity says so', () => {
  const manifest: any = {
    version: 1, id: 'kit', title: 'Kit', description: 'd', roles: [], gates: [],
    mcpServers: {
      local: { type: 'stdio', command: '{node}', args: ['{pack}/server.mjs'] },
      lookup: { type: 'stdio', command: 'npx', args: ['-y', 'lookup-mcp@1.2.3'] },
    },
  };
  const parsed = parsePackManifest(manifest);
  const files = new Map([['server.mjs', Buffer.from('x')]]);
  const valid = checkPackContents(parsed, files);
  assert.equal(valid.servers.local!.pin, undefined);
  assert.equal(valid.servers.lookup!.pin?.name, 'lookup-mcp');
  assert.equal(valid.servers.lookup!.pinLabel, 'Not pinned to an integrity hash');
});

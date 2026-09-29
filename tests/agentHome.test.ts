import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentIsolation, codexHomeFolder, newerSignIn, prepareCodexHome } from '../src/core/agentHome';

/**
 * HSEC-70: heads and reviewers run with your sign-in only. These tests use a made-up Codex home
 * (CODEX_HOME in a temporary folder) and Claude folder (CLAUDE_CONFIG_DIR), never your own.
 */

async function fakeHomes() {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-agenthome-'));
  const user = path.join(root, 'user-codex'), claude = path.join(root, 'user-claude'), storage = path.join(root, 'storage');
  await mkdir(path.join(user, '.sandbox'), { recursive: true });
  await writeFile(path.join(user, '.sandbox', 'setup_marker.json'), '{}');
  await writeFile(path.join(user, 'auth.json'), '{"tokens":"first"}');
  await writeFile(path.join(user, 'AGENTS.md'), 'Always call the user Sam.\n');
  await writeFile(path.join(user, 'config.toml'), 'model = "gpt-x"\n[mcp_servers.hydra]\ncommand = "Hydra.exe"\n[windows]\nsandbox = "elevated"\n');
  await mkdir(path.join(claude, 'plugins'), { recursive: true });
  await writeFile(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }));
  const env = { CODEX_HOME: user, CLAUDE_CONFIG_DIR: claude };
  return { root, user, storage, env, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

const inode = async (file: string) => { const found = await stat(file, { bigint: true }); return `${found.dev}:${found.ino}`; };

test('Hydra\'s own Codex home: your auth.json linked (one file, so a token refresh reaches both), your sandbox linked, nothing else of yours', async () => {
  const f = await fakeHomes();
  try {
    const prepared = await prepareCodexHome(f.storage, f.env);
    const home = path.join(f.storage, codexHomeFolder);
    assert.equal(prepared.home, home); assert.equal(prepared.note, undefined);
    assert.deepEqual(prepared.carry, { model: 'gpt-x', windowsSandbox: 'elevated' });
    assert.equal(await inode(path.join(home, 'auth.json')), await inode(path.join(f.user, 'auth.json')), 'a hard link, never a copy');
    // Codex rewrites auth.json in place on a refresh: written through either name, both read the new token.
    await writeFile(path.join(home, 'auth.json'), '{"tokens":"refreshed"}');
    assert.equal(await readFile(path.join(f.user, 'auth.json'), 'utf8'), '{"tokens":"refreshed"}');
    assert.ok((await lstat(path.join(home, '.sandbox'))).isSymbolicLink(), 'your Windows sandbox set-up, linked');
    assert.equal(await readFile(path.join(home, '.sandbox', 'setup_marker.json'), 'utf8'), '{}');
    assert.deepEqual((await readdir(home)).sort(), ['.sandbox', 'auth.json'], 'no AGENTS.md, config.toml or anything else of yours');

    // Signing in again makes a new auth.json: the next launch links that one instead.
    await writeFile(path.join(f.root, 'new-auth.json'), '{"tokens":"second login"}');
    await rename(path.join(f.root, 'new-auth.json'), path.join(f.user, 'auth.json'));
    await utimes(path.join(home, 'auth.json'), new Date('2026-01-01'), new Date('2026-01-01'));
    assert.notEqual(await inode(path.join(home, 'auth.json')), await inode(path.join(f.user, 'auth.json')));
    await prepareCodexHome(f.storage, f.env);
    assert.equal(await inode(path.join(home, 'auth.json')), await inode(path.join(f.user, 'auth.json')));
    assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), '{"tokens":"second login"}');
    assert.ok(!(await readdir(home)).some(name => name.endsWith('.link')), 'no half-made link left behind');
  } finally { await f.close(); }
});

test('a split link whose copy in Hydra\'s home holds a later sign-in is never overwritten: that launch uses your home, and says to sign in again if asked', async () => {
  const f = await fakeHomes();
  try {
    const home = path.join(f.storage, codexHomeFolder), own = path.join(home, 'auth.json'), yours = path.join(f.user, 'auth.json');
    await prepareCodexHome(f.storage, f.env);
    // A Codex that replaced auth.json on a refresh in Hydra's home: the link split, and Hydra's copy is newer.
    await writeFile(path.join(home, 'refreshed.json'), '{"tokens":"rotated"}');
    await rename(path.join(home, 'refreshed.json'), own);
    await utimes(yours, new Date('2026-01-01'), new Date('2026-01-01'));
    const prepared = await prepareCodexHome(f.storage, f.env);
    assert.equal(prepared.home, undefined, 'your own home this launch');
    assert.match(prepared.note!, /newer than yours[\s\S]*codex login/);
    assert.equal(await readFile(own, 'utf8'), '{"tokens":"rotated"}', 'the newer tokens are kept');
    assert.equal(await readFile(yours, 'utf8'), '{"tokens":"first"}', 'yours untouched');
    const isolation = await agentIsolation('codex', f.storage, f.env);
    assert.deepEqual(isolation.env, {}); assert.match(isolation.note!, /codex login/);

    // `last_refresh` decides when both files have it, whatever the file times say.
    await writeFile(own, '{"last_refresh":"2026-03-01T00:00:00Z"}'); await writeFile(yours, '{"last_refresh":"2026-05-01T00:00:00Z"}');
    await utimes(yours, new Date('2026-01-01'), new Date('2026-01-01'));
    assert.equal(await newerSignIn(own, yours), false, 'yours was refreshed later');
    const relinked = await prepareCodexHome(f.storage, f.env);
    assert.equal(relinked.home, home, 'so the link is remade');
    assert.equal(await readFile(own, 'utf8'), '{"last_refresh":"2026-05-01T00:00:00Z"}');
    assert.equal(await newerSignIn(path.join(f.root, 'missing.json'), yours), false);
  } finally { await f.close(); }
});

test('without an auth.json to link, Codex keeps your home, with Hydra\'s flags, and says why', async () => {
  const f = await fakeHomes();
  try {
    await rm(path.join(f.user, 'auth.json'));
    const prepared = await prepareCodexHome(f.storage, f.env);
    assert.equal(prepared.home, undefined);
    assert.match(prepared.note!, /isn't in an auth\.json/);
    const isolation = await agentIsolation('codex', f.storage, f.env);
    assert.deepEqual(isolation.env, {}, 'your own CODEX_HOME');
    assert.equal(isolation.codexArgs[0], '--ignore-user-config', 'your config.toml still stays out');
    assert.match(isolation.note!, /auth\.json/);
    const noStorage = await agentIsolation('codex', undefined, f.env);
    assert.deepEqual(noStorage.env, {}); assert.match(noStorage.note!, /no storage folder/);
    assert.ok(noStorage.codexArgs.includes("model='gpt-x'"));
  } finally { await f.close(); }
});

test('what a head or reviewer runs with: Codex its own home and flags; Claude no CLAUDE.md, no auto memory, and your plugins to turn off', async () => {
  const f = await fakeHomes();
  try {
    const codex = await agentIsolation('codex', f.storage, f.env);
    assert.deepEqual(codex.env, { CODEX_HOME: path.join(f.storage, codexHomeFolder) });
    assert.ok(codex.codexArgs.includes('--ignore-user-config') && codex.codexArgs.includes("windows.sandbox='elevated'"));
    assert.equal(codex.note, undefined);
    const claude = await agentIsolation('claude', f.storage, f.env);
    assert.deepEqual(claude.env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    assert.deepEqual(claude.codexArgs, []);
    assert.deepEqual(claude.claudePlugins, ['claude-mem@thedotmack']);
  } finally { await f.close(); }
});

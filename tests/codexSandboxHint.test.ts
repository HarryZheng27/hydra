import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexSandboxHint } from '../src/core/headSandbox';

test('a failed sandbox check names Codex\'s empty deny-read state file and how to fix it, and says nothing it doesn\'t recognise', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hydra-codex-home-'));
  try {
    const folder = path.join(home, '.sandbox');
    await mkdir(folder);
    assert.equal(await codexSandboxHint(home), undefined, 'no setup error: nothing to say');
    await writeFile(path.join(folder, 'setup_error.json'), JSON.stringify({ code: 'helper_unknown_error', message: 'apply deny-read ACLs' }));
    assert.equal(await codexSandboxHint(home), undefined, 'the error alone, with no log saying why: nothing to say');
    await writeFile(path.join(folder, 'sandbox.2026-10-05.log'), 'old day\n');
    await writeFile(path.join(folder, 'sandbox.2026-10-06.log'), [
      '[2026-10-06T02:28:29Z] setup error: apply deny-read ACLs', '', 'Caused by:',
      `    0: parse deny-read ACL state ${path.join(folder, 'deny_read_acl_state.json')}`, '    1: EOF while parsing a value at line 1 column 0', '',
    ].join('\n'));
    const hint = await codexSandboxHint(home);
    assert.ok(hint?.includes(path.join(folder, 'deny_read_acl_state.json')), hint);
    assert.match(hint ?? '', /empty or damaged\. Rename that file/);
    // Another cause in the newest log: not this one.
    await writeFile(path.join(folder, 'sandbox.2026-10-07.log'), 'setup error: apply deny-read ACLs\nCaused by:\n    0: access denied\n');
    assert.equal(await codexSandboxHint(home), undefined);
    assert.equal(await codexSandboxHint(path.join(home, 'missing')), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

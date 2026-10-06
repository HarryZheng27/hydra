import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTitle, codexTitle, titlePrompt } from '../src/main/chatTitles';

test('a chat name from Claude is one short line, without quotes, labels or end punctuation; anything odd is dropped', () => {
  assert.equal(cleanTitle('Minimize Project Chats on Hover\n'), 'Minimize Project Chats on Hover');
  assert.equal(cleanTitle('"Fix flaky onboarding test."'), 'Fix flaky onboarding test');
  assert.equal(cleanTitle('Title: Products & Solutions page'), 'Products & Solutions page');
  assert.equal(cleanTitle('**Sidebar redesign**'), 'Sidebar redesign');
  assert.equal(cleanTitle(''), undefined);
  assert.equal(cleanTitle('x'.repeat(61)), undefined);
  assert.equal(cleanTitle('one two three four five six seven eight nine ten eleven'), undefined);
  assert.equal(cleanTitle('Bell\u0007 name'), 'Bell name');
  assert.ok(titlePrompt('a'.repeat(10_000)).length < 4500, 'only the start of a long message is sent');
  assert.match(titlePrompt('hello'), /hello$/);
});

test('a Codex name comes from one ephemeral, read-only codex exec on the user\'s own login, read from the file Hydra names; a failure or a slow reply leaves no name and no files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-codex-title-'));
  try {
    // A stand-in codex: reads the prompt from stdin, notes how it was called, and writes its last message to -o.
    fs.writeFileSync(path.join(dir, 'fake.js'), `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      let input = ''; process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input }));
        if (process.env.FAKE_MODE === 'fail') process.exit(3);
        if (process.env.FAKE_MODE === 'hang') return setTimeout(() => undefined, 60000);
        fs.writeFileSync(args[args.indexOf('-o') + 1], '"Fix the login page."\\n');
      });`);
    const exe = process.platform === 'win32' ? path.join(dir, 'codex.cmd') : path.join(dir, 'codex');
    fs.writeFileSync(exe, process.platform === 'win32' ? `@"${process.execPath}" "%~dp0fake.js" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'fake.js')}" "$@"\n`, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.json');
    const before = new Set(fs.readdirSync(path.join(os.tmpdir(), 'hydra-chat-titles')).filter(name => name.startsWith('codex-')));
    assert.equal(await codexTitle(exe, 'the login page throws when the password has a quote in it'), 'Fix the login page');
    const called = JSON.parse(fs.readFileSync(process.env.FAKE_LOG, 'utf8')) as { args: string[]; input: string };
    for (const flag of ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'read-only']) assert.ok(called.args.includes(flag), flag);
    assert.match(called.input, /the login page throws when the password has a quote in it$/);
    process.env.FAKE_MODE = 'fail';
    assert.equal(await codexTitle(exe, 'x'), undefined);
    process.env.FAKE_MODE = 'hang';
    assert.equal(await codexTitle(exe, 'x', 1500), undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(fs.readdirSync(path.join(os.tmpdir(), 'hydra-chat-titles')).filter(name => name.startsWith('codex-') && !before.has(name)), [], 'its temp folder is removed');
  } finally { delete process.env.FAKE_MODE; delete process.env.FAKE_LOG; fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

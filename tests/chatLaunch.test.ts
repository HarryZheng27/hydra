import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chatLaunch, npmCodexBinary } from '../src/core/chat/launch';

const windows = process.platform === 'win32';

test('npm\'s codex.cmd starts Codex\'s own native binary, as npm\'s launcher does; any other shim goes through PowerShell in UTF-8', { skip: !windows }, () => {
  const npm = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-npm-'));
  try {
    const shim = path.join(npm, 'codex.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    assert.equal(npmCodexBinary(shim), undefined, 'no binary where the package puts it');
    const root = path.join(npm, 'node_modules', '@openai', 'codex');
    const binary = path.join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '');
    const launch = chatLaunch(shim, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(launch, { executable: binary, args: ['app-server', '--listen', 'stdio://'], env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root } });

    // A codex.cmd that isn't npm's launcher, or another CLI's shim, runs as before but with a UTF-8 console.
    const other = path.join(npm, 'other', 'codex.cmd');
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, '@echo off\r\nnode something-else.js %*\r\n');
    for (const shimPath of [other, path.join(npm, 'claude.cmd')]) {
      const wrapped = chatLaunch(shimPath, ['-p']);
      assert.match(wrapped.executable, /powershell\.exe$/i);
      const script = Buffer.from(wrapped.args.at(-1)!, 'base64').toString('utf16le');
      assert.match(script, /^\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\); \$OutputEncoding = \[Console\]::OutputEncoding; & '/);
      assert.ok(script.includes(`& '${shimPath}' '-p'`), script);
    }
    assert.deepEqual(chatLaunch('C:\\x\\claude.exe', ['-p']), { executable: 'C:\\x\\claude.exe', args: ['-p'] }, 'a native CLI runs as it is');
  } finally { fs.rmSync(npm, { recursive: true, force: true }); }
});

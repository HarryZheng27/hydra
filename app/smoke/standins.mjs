// Stand-in `claude` and `codex` for the app's tests and smoke: Windows .cmd programs that answer only `--version` and
// `--help` (and Codex's `app-server --help`), the way the real CLIs do, and log every call to <name>-calls.log beside
// them, retrying while the other one holds its file. A call that can't be logged fails (exit 9) rather than go unseen.
// Anything else exits 3. They never start a model, so app CI needs no provider and no sign-in.
import fs from 'node:fs';
import path from 'node:path';

const program = (name, version, help, extra = '') => [
  '@echo off',
  'set tries=0',
  ':log',
  `(>>"%~dp0${name}-calls.log" echo ${name} %*) 2>nul || (set /a tries+=1 >nul & if %tries% lss 50 (ping -n 1 127.0.0.1 >nul & goto log) else exit /b 9)`,
  extra,
  'if "%~1"=="--version" goto version',
  'if "%~1"=="--help" goto help',
  'exit /b 3',
  ':version',
  `echo ${version}`,
  'exit /b 0',
  ':help',
  `echo ${help}`,
  'exit /b 0',
  '',
].filter(line => line !== '').join('\r\n') + '\r\n';

/** Writes claude.cmd and codex.cmd into `dir`. Pass `false` to leave one out, as if it weren't installed. */
export function writeStandins(dir, { claude = '2.1.282', codex = '0.157.1' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (claude) fs.writeFileSync(path.join(dir, 'claude.cmd'), program('claude', `${claude} (Claude Code)`, 'Usage: claude [options] --output-format stream-json --input-format stream-json --resume --permission-prompt-tool'));
  if (codex) fs.writeFileSync(path.join(dir, 'codex.cmd'), program('codex', `codex-cli ${codex}`, 'Commands: exec app-server login',
    'if "%~1"=="app-server" if "%~2"=="--help" (echo app-server generate-json-schema& exit /b 0)'));
  return dir;
}

/** Every call the stand-ins in `dir` received, as "name args". */
export function standinCalls(dir) {
  const read = name => { try { return fs.readFileSync(path.join(dir, `${name}-calls.log`), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean); } catch { return []; } };
  return [...read('claude'), ...read('codex')];
}

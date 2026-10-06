import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveCommand } from './gates/command';
import { bashQuote, confinedEnvironment, envValue, guardScript, insideScript, treeScript, wrapperScript, type HeadShell } from './confine';
import type { AuditEvent } from './audit';

/**
 * Codex's Windows sandbox around a head's shell and the gate commands
 * (Step 2, design 1, 5 and 7). Once per window, the first time a head or a gate needs it, Hydra finds
 * Codex's own executable and Git Bash, writes the wrapper scripts into its own storage (never under
 * a worktree), and checks them: a harmless command must run inside a test folder, and a write to a
 * sibling folder outside it must be refused. The result is kept for the window. When anything is
 * missing or the check fails, heads get no shell and gate commands run as before, and Settings →
 * Heads says why.
 */

const exists = (file: string) => access(file).then(() => true, () => false);

/**
 * Codex's own executable from the CLI Hydra found (`hydra.codexPath` or PATH), as the research ran it:
 * `codex sandbox` must be the Rust binary, not the npm `.cmd` shim, whose extra layers would stand
 * between Claude Code's command line and the sandbox. The npm package keeps it at
 * `node_modules/@openai/codex/node_modules/@openai/codex-win32-<arch>/vendor/<triple>/bin/codex.exe`
 * (or hoisted beside it, or under the package's own `vendor`).
 */
export async function codexSandboxExecutable(found: string, arch: string = process.arch, has: (file: string) => Promise<boolean> = exists): Promise<string | undefined> {
  if (/\.exe$/i.test(found)) return await has(found) ? found : undefined;
  const target = arch === 'arm64' ? { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' } : { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' };
  const folder = path.win32.dirname(found);
  const root = path.win32.join(folder, 'node_modules', '@openai', 'codex');
  const candidates = [
    path.win32.join(root, 'node_modules', '@openai', target.pkg, 'vendor', target.triple, 'bin', 'codex.exe'),
    path.win32.join(folder, 'node_modules', '@openai', target.pkg, 'vendor', target.triple, 'bin', 'codex.exe'),
    path.win32.join(root, 'vendor', target.triple, 'bin', 'codex.exe'),
    path.win32.join(root, 'vendor', target.triple, 'codex', 'codex.exe'),
  ];
  for (const candidate of candidates) if (await has(candidate)) return candidate;
  return undefined;
}

export interface GitBash {
  /** Git for Windows' folder. */
  root: string;
  /** `usr\bin\bash.exe`: runs the command inside the sandbox. */
  bash: string;
  /** `bin`, holding the `bash.exe` launcher: first on a head's PATH, so the `bash` cross-spawn looks up for the wrapper is Git's. */
  bin: string;
}

/**
 * Git Bash, as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH when set, else from `git.exe` on
 * PATH (`<Git>\cmd`, `<Git>\bin` or `<Git>\mingw64\bin`), else the usual install folders.
 */
export async function findGitBash(env: Readonly<Record<string, string | undefined>>, has: (file: string) => Promise<boolean> = exists): Promise<GitBash | undefined> {
  const read = (name: string) => { const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase()); return key ? env[key] : undefined; };
  const roots: string[] = [];
  const configured = read('CLAUDE_CODE_GIT_BASH_PATH');
  if (configured) {
    const up = /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(configured) ? 3 : /[\\/]bin[\\/]bash\.exe$/i.test(configured) ? 2 : 0;
    if (up) roots.push(path.win32.resolve(configured, ...Array(up).fill('..')));
  }
  for (const folder of (read('PATH') ?? '').split(';').filter(Boolean)) {
    if (!await has(path.win32.join(folder, 'git.exe'))) continue;
    const name = path.win32.basename(folder).toLowerCase(), parent = path.win32.dirname(folder);
    if (name === 'cmd' || name === 'bin') roots.push(path.win32.basename(parent).toLowerCase() === 'mingw64' ? path.win32.dirname(parent) : parent);
  }
  for (const base of [read('ProgramW6432'), read('ProgramFiles'), read('ProgramFiles(x86)')]) if (base) roots.push(path.win32.join(base, 'Git'));
  const local = read('LOCALAPPDATA');
  if (local) roots.push(path.win32.join(local, 'Programs', 'Git'));
  for (const root of roots) {
    const bash = path.win32.join(root, 'usr', 'bin', 'bash.exe'), bin = path.win32.join(root, 'bin');
    if (await has(bash) && await has(path.win32.join(bin, 'bash.exe'))) return { root, bash, bin };
  }
  return undefined;
}

/** One program run to the end, or stopped at `timeoutMs`. */
function runOnce(executable: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-8000); });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    child.on('error', error => { stderr += error.message; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** A gate command, or anything else Hydra runs in a worktree, rewritten to run through the wrapper. */
export interface WrappedCommand { executable: string; args: string[]; environment: Record<string, string> }
export interface CommandSandbox {
  /**
   * `command` in Codex's sandbox with `worktree` writable, the allowlisted environment plus
   * `command.env`, and `temp` as TEMP and TMP. Undefined when the sandbox isn't available: the
   * caller then runs the command as before.
   */
  wrap(command: { executable: string; args: string[]; env?: Record<string, string> }, worktree: string, temp: string): Promise<WrappedCommand | undefined>;
}

/**
 * Why Codex's sandbox couldn't start, in words a person can act on, from Codex's own setup files: its last setup error
 * (`.sandbox/setup_error.json`) and its newest sandbox log. Only one cause is named today, the one seen on Nico's machine:
 * the deny-read ACL state file left empty (an interrupted write), which fails every elevated sandbox from then on.
 * Undefined when the files say nothing Hydra recognises. Reads only; never changes Codex's files.
 */
export async function codexSandboxHint(codexHome: string): Promise<string | undefined> {
  const folder = path.join(codexHome, '.sandbox');
  const setup = await readFile(path.join(folder, 'setup_error.json'), 'utf8').catch(() => '');
  if (!/apply deny-read ACLs/.test(setup)) return undefined;
  const logs = (await readdir(folder).catch(() => [] as string[])).filter(name => /^sandbox\.\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
  const newest = logs.length ? await readFile(path.join(folder, logs[logs.length - 1]!), 'utf8').catch(() => '') : '';
  const state = path.join(folder, 'deny_read_acl_state.json');
  if (/parse deny-read ACL state[^\n]*\n[^\n]*EOF while parsing/.test(newest.slice(-20_000))) {
    return `Codex's sandbox can't start because its file ${state} is empty or damaged. Rename that file (Codex makes a new one), then check Hydra's sandbox again; nothing else in Codex needs to change.`;
  }
  return undefined;
}

export interface HeadSandboxOptions {
  /** Where the wrapper scripts and the check's folders go: Hydra's own storage, never a worktree. */
  folder: string;
  /** The Codex CLI Hydra would run (`hydra.codexPath`, else PATH), or undefined. */
  codex: () => Promise<string | undefined>;
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  /** Test seam: the check's two runs. */
  run?: typeof runOnce;
  /** Codex's own folder (CODEX_HOME, else ~/.codex), read for why its sandbox failed. */
  codexHome?: string;
  // ---- 5.2: the audit log ----
  /** Without it, a failed sandbox self-test is only logged, not recorded in the audit log. */
  audit?: (event: AuditEvent) => void;
}

export class HeadSandbox implements CommandSandbox {
  private check?: Promise<HeadShell>;
  private result?: HeadShell;
  constructor(private readonly options: HeadSandboxOptions) {}

  /** The check's result, once it has finished. */
  status(): HeadShell | undefined { return this.result; }
  /** A changed Codex path: check again next time. */
  reset(): void { this.check = undefined; this.result = undefined; }

  /** How heads' shells run in this window: checked once, the first time it's asked. */
  shell(): Promise<HeadShell> {
    this.check ??= this.selfCheck().catch(error => ({ kind: 'off' as const, reason: `the sandbox check failed (${error instanceof Error ? error.message : String(error)})` })).then(result => {
      this.result = result;
      this.options.log?.(`[heads] shell: ${result.kind === 'off' ? `off (${result.reason})` : result.kind}`);
      return result;
    });
    return this.check;
  }

  async wrap(command: { executable: string; args: string[]; env?: Record<string, string> }, worktree: string, temp: string): Promise<WrappedCommand | undefined> {
    const shell = await this.shell();
    if (shell.kind !== 'sandboxed') return undefined;
    await mkdir(temp, { recursive: true });
    // Bash runs a `.cmd` through cmd.exe, which reads its arguments again; the extensionless script
    // npm and its kind install beside it (npm, npx, pnpm…) takes them as they are.
    let executable = command.executable;
    const bare = executable.replace(/\.(cmd|bat)$/i, '');
    if (bare !== executable && /[\\/]/.test(executable) && await exists(bare)) executable = bare;
    const environment = confinedEnvironment({ base: this.env(), platform: this.platform, set: { ...command.env, TEMP: temp, TMP: temp, HYDRA_WT: worktree } });
    return { executable: path.win32.join(shell.gitBin, 'bash.exe'), args: [shell.wrapper, [executable, ...command.args].map(bashQuote).join(' ')], environment };
  }

  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  private env(): NodeJS.ProcessEnv { return this.options.env?.() ?? process.env; }

  private async selfCheck(): Promise<HeadShell> {
    if (this.platform !== 'win32') return { kind: 'unconfined' };
    const found = await this.options.codex().catch(() => undefined);
    if (!found) return { kind: 'off', reason: 'Codex isn\'t installed, and a head\'s shell runs in its Windows sandbox' };
    const codex = await codexSandboxExecutable(found);
    if (!codex) return { kind: 'off', reason: `Hydra couldn't find codex.exe for ${found}` };
    const git = await findGitBash(this.env());
    if (!git) return { kind: 'off', reason: 'Git Bash wasn\'t found' };
    const folder = this.options.folder;
    // Claude Code splits a prefix at its last " -" to pass flags, so a wrapper path with one would break.
    if (folder.includes(' -')) return { kind: 'off', reason: `Hydra's storage folder has " -" in its path (${folder}), which Claude Code can't pass to a shell wrapper` };
    await mkdir(folder, { recursive: true });
    const file = (name: string) => path.win32.join(folder, name);
    const powershell = path.win32.join(envValue(this.env(), 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const wrapper = file('hydra-shell.sh');
    await writeFile(file('hydra-shell-inside.sh'), insideScript(), 'utf8');
    await writeFile(file('hydra-shell-guard.sh'), guardScript(), 'utf8');
    await writeFile(file('hydra-process-tree.ps1'), treeScript(), 'utf8');
    await writeFile(wrapper, wrapperScript({ codex, bash: git.bash, inside: file('hydra-shell-inside.sh'), guard: file('hydra-shell-guard.sh'), tree: file('hydra-process-tree.ps1'), powershell }), 'utf8');
    const shell: HeadShell = { kind: 'sandboxed', wrapper, gitBin: git.bin };
    const problem = await this.test(shell, git);
    // 5.2: a denial — the sandbox self-test itself (not a missing prerequisite) failed, once per window.
    if (problem) this.options.audit?.({ kind: 'denial', what: 'sandbox self-test failed', detail: problem });
    return problem ? { kind: 'off', reason: problem } : shell;
  }

  /**
   * The check: a command runs in a fresh folder through the wrapper exactly as a head's Bash does,
   * writes a file there, and tries to write one in a sibling folder, which must be refused. Then
   * Hydra's own MCP route: the `bash` a head's PATH finds must be Git's, and a program started with
   * HYDRA_SHELL_DIRECT must run. The folders are removed afterwards.
   */
  private async test(shell: Extract<HeadShell, { kind: 'sandboxed' }>, git: GitBash): Promise<string | undefined> {
    const run = this.options.run ?? runOnce;
    const root = await mkdtemp(path.win32.join(this.options.folder, 'check-'));
    try {
      const work = path.win32.join(root, 'work'), outside = path.win32.join(root, 'outside'), temp = path.win32.join(root, 'temp');
      for (const folder of [work, outside, temp]) await mkdir(folder);
      const base = this.env();
      const env = confinedEnvironment({ base, platform: 'win32', provider: 'claude', set: { TEMP: temp, TMP: temp, HYDRA_WT: work, PATH: `${git.bin};${envValue(base, 'PATH', 'win32') ?? ''}` } });
      const escape = path.win32.join(outside, 'escape.txt').replace(/\\/g, '/');
      const line = `eval ${bashQuote(`printf hydra-inside > inside.txt && echo hydra-check-ran; (printf hydra-escape > ${bashQuote(escape)}) 2>/dev/null; true`)} < /dev/null`;
      const inside = await run(path.win32.join(git.bin, 'bash.exe'), [shell.wrapper, line], { cwd: work, env, timeoutMs: 90_000 });
      if (inside.timedOut) return 'the sandbox check didn\'t finish in 90 seconds';
      const wrote = await readFile(path.win32.join(work, 'inside.txt'), 'utf8').catch(() => '');
      if (inside.code !== 0 || !inside.stdout.includes('hydra-check-ran') || wrote !== 'hydra-inside') {
        const detail = (inside.stderr.trim().split(/\r?\n/).find(Boolean) ?? '').slice(0, 200);
        const hint = await codexSandboxHint(this.options.codexHome ?? (envValue(this.env(), 'CODEX_HOME', 'win32') || path.win32.join(envValue(this.env(), 'USERPROFILE', 'win32') ?? '', '.codex'))).catch(() => undefined);
        return hint ?? `Codex's sandbox didn't run a test command (exit ${inside.code ?? 'none'}${detail ? `: ${detail}` : ''})`;
      }
      if (await exists(path.win32.join(outside, 'escape.txt'))) return 'Codex\'s sandbox let a test command write outside its folder';
      // Hydra's bridge (hydra_done) starts through the wrapper too, via the `bash` on the head's PATH.
      const bash = await resolveCommand('bash', 'win32', { PATH: envValue(env, 'PATH', 'win32'), PATHEXT: envValue(env, 'PATHEXT', 'win32') });
      if (path.win32.resolve(bash).toLowerCase() !== path.win32.join(git.bin, 'bash.exe').toLowerCase()) return `a head's PATH finds ${bash} before Git's bash, so Hydra's own tools couldn't start`;
      const cmd = path.win32.join(envValue(base, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'cmd.exe');
      const direct = await run(bash, [shell.wrapper, [cmd, '/d', '/c', 'echo hydra-direct-ok'].map(bashQuote).join(' ')], { cwd: work, env: { ...env, HYDRA_SHELL_DIRECT: '1' }, timeoutMs: 30_000 });
      if (direct.code !== 0 || !direct.stdout.includes('hydra-direct-ok')) return `Hydra's own tools couldn't start through the shell wrapper (exit ${direct.code ?? 'none'})`;
      return undefined;
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
    }
  }
}

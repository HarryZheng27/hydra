// O9 (docs/Benchmark.md): how the benchmark runs a command (an agent, a gate, git, the hidden check), in its own
// module so tests can drive it.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

const quote = value => /[\s()"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
/** How long to wait for a finished command's output after it exits, before resolving without the rest. */
export const exitGraceMs = 2000;

/**
 * Kills a process and everything it started: on Windows `taskkill /T /F` (killing only the cmd.exe of a shell
 * command leaves the program it started running), elsewhere the process group (the child is started detached, so
 * it leads one).
 */
export function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      resolve();
    }
  });
}

/**
 * Runs a command without a window, optionally feeding stdin; resolves with its exit code and output.
 * - `timeoutMs`: past it, the whole process tree is killed and `timedOut` is true.
 * - It resolves once the command exits and its output has ended, or `exitGraceMs` after it exits when something it
 *   started still holds its output open (a server a test left running), so a lingering grandchild can't hang a run.
 */
export function run(command, argv, { cwd, input, timeoutMs, shell = process.platform === 'win32', graceMs = exitGraceMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell ? [command, ...argv].map(quote).join(' ') : command, shell ? [] : argv, { cwd, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, settled = false, exitCode = null, grace;
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; void killTree(child.pid); }, timeoutMs) : undefined;
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('exit', code => { exitCode = code; grace = setTimeout(() => finish(exitCode), graceMs); });
    child.on('close', code => finish(code ?? exitCode));
    // A command that exits without reading its input (git, say) closes the pipe first: that's not an error here.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input ?? '');
  });
}

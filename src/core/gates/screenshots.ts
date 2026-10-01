import { spawn } from 'node:child_process';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { processLaunch } from '../process';
import type { JobCheckResult } from '../jobs';
import type { ScreenshotsGate } from './config';
import type { BrowserSession } from './browser';
import type { CommandSandbox } from '../headSandbox';
import { redactText } from '../redact';
import { resolveCommand } from './command';
import { clip, gateTemp, notRun, tail, type GateRun, type GateRuntime } from './types';

/**
 * The screenshots gate (docs/internal/Gates_Plan.md). Hydra picks a free local port,
 * starts the app in the worktree with that port (as `{port}` and `PORT`), waits
 * until its URL answers below HTTP 400, and captures the page at each width in
 * a headless browser. It fails when the app never gets ready, answers HTTP 400
 * or more, throws or logs console.error, or renders an empty body. Afterwards
 * the app's whole process tree is always killed and the browser closed.
 */
const maxServerLog = 1024 * 1024;
const maxProblems = 20;

/** A free port on 127.0.0.1, found by letting the system choose one. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as AddressInfo; server.close(() => resolve(port)); });
  });
}
export const substitutePort = (value: string, port: number): string => value.replaceAll('{port}', String(port));

export interface AppServer { pid?: number; exitCode(): number | null | undefined; exited: Promise<void>; stop(): Promise<void> }

/**
 * Start the app as a tracked process tree in the worktree, its output going to a log. With Codex's
 * sandbox (Step 2, design 5), the app runs in it, with the worktree writable, the allowlisted
 * environment and the network on; stopping it ends the sandboxed tree through the wrapper's guard.
 * Exported for a lane's preview (Step E): the same tracked,
 * capped-log process, just kept running instead of stopped right after a capture.
 */
export async function startApp(command: string[], cwd: string, port: number, logFile: string, runtime: GateRuntime, spawned?: (pid: number) => void, env: Record<string, string> = {}, sandbox?: CommandSandbox, temp?: string): Promise<AppServer> {
  const log = await open(logFile, 'w');
  let written = 0, writes = Promise.resolve(), exitCode: number | null | undefined;
  const append = (data: Buffer) => {
    if (written >= maxServerLog) return;
    const part = data.subarray(0, maxServerLog - written); written += part.length;
    writes = writes.then(() => log.write(part).then(() => undefined)).catch(() => undefined);
  };
  const executable = await resolveCommand(command[0]!);
  const wrapped = sandbox && temp ? await sandbox.wrap({ executable, args: command.slice(1), env: { ...env, PORT: String(port) } }, cwd, temp) : undefined;
  const launch = wrapped ?? processLaunch(executable, command.slice(1));
  const child = spawn(launch.executable, launch.args, { cwd, env: wrapped ? wrapped.environment : { ...process.env, ...env, PORT: String(port) }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) spawned?.(child.pid);
  child.stdout.on('data', append); child.stderr.on('data', append);
  const exited = new Promise<void>(resolve => {
    child.once('close', code => { exitCode = code; resolve(); });
    child.once('error', error => { append(Buffer.from(`${error.message}\n`)); exitCode = null; resolve(); });
  });
  let stopping: Promise<void> | undefined;
  return {
    pid: child.pid, exited, exitCode: () => exitCode,
    // Always the whole tree: `npm run dev` is a shell, npm, node and the dev server.
    stop: () => stopping ??= (async () => {
      // Even after the command itself exits, what it started may still hold the port.
      if (child.pid) await runtime.terminate(child.pid).catch(() => { if (exitCode === undefined) child.kill(); });
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
      await writes; await log.close().catch(() => undefined);
    })(),
  };
}

/** Ask the URL until it answers below HTTP 400. Redirects aren't followed, so nothing leaves this machine. */
export async function waitUntilReady(url: string, timeoutMs: number, app: Pick<AppServer, 'exitCode' | 'exited'>, runtime: Pick<GateRuntime, 'fetch' | 'now' | 'pollMs'>, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = runtime.now() + timeoutMs;
  let lastStatus: number | undefined;
  for (;;) {
    if (signal?.aborted) return { ok: false, reason: 'Stopped before the app was ready.' };
    const code = app.exitCode();
    if (code !== undefined) return { ok: false, reason: `The start command exited${code === null ? '' : ` with code ${code}`} before the page was ready.` };
    try {
      const response = await runtime.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(250, Math.min(5000, deadline - runtime.now()))) });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 400) return { ok: true };
      lastStatus = response.status;
    } catch { /* not listening yet */ }
    if (runtime.now() >= deadline) {
      const seconds = Math.round(timeoutMs / 1000);
      return { ok: false, reason: lastStatus !== undefined ? `The page answered HTTP ${lastStatus} (${url}) and never got ready in ${seconds} s.` : `The page never got ready in ${seconds} s (${url}).` };
    }
    await Promise.race([new Promise(resolve => setTimeout(resolve, runtime.pollMs)), app.exited]);
  }
}

export async function runScreenshotsGate(gate: ScreenshotsGate, run: GateRun): Promise<JobCheckResult> {
  const { runtime } = run;
  const started = runtime.now();
  const elapsed = () => runtime.now() - started;
  const executable = await runtime.browser.find();
  if (!executable) return notRun(gate, 'No Edge, Chrome or Chromium was found, so no screenshots were taken.');
  const port = await runtime.freePort();
  const url = substitutePort(gate.url, port);
  const serverLog = path.join(run.logDirectory, `${gate.id}-server.log`);
  const appTemp = gateTemp(run, gate.id);
  const problems: string[] = [], pictures: string[] = [];
  let app: AppServer | undefined, session: BrowserSession | undefined, tooling: string | undefined;
  try {
    app = await startApp(gate.start.map(part => substitutePort(part, port)), run.worktree, port, serverLog, runtime, run.spawned, gate.env, run.sandbox, appTemp);
    const ready = await waitUntilReady(url, gate.readyTimeoutSeconds * 1000, app, runtime, run.signal);
    if (!ready.ok) problems.push(ready.reason);
    else {
      try { session = await runtime.browser.open(executable, { spawned: run.spawned }); }
      catch (error) { tooling = `The browser didn't start: ${error instanceof Error ? error.message : String(error)}`; }
      for (const width of session ? gate.widths : []) {
        if (run.signal?.aborted) break;
        let capture;
        try { capture = await session!.capture(url, width); }
        catch (error) { tooling = `The browser failed at ${width} px: ${error instanceof Error ? error.message : String(error)}`; break; }
        const file = path.join(run.logDirectory, `${gate.id}-${width}.png`);
        await writeFile(file, capture.png);
        pictures.push(file);
        if (capture.status !== undefined && capture.status >= 400) problems.push(`At ${width} px the page answered HTTP ${capture.status}.`);
        for (const error of capture.errors) problems.push(`At ${width} px: ${error}`);
        for (const message of capture.consoleErrors) problems.push(`At ${width} px the page logged console.error: ${clip(message, 300)}`);
        if (capture.empty) problems.push(`At ${width} px the page rendered empty (no text and no images).`);
      }
    }
  } finally {
    await app?.stop();
    await session?.close();
    if (run.sandbox) await rm(appTemp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
  }
  // 5.1: the app under test can print a secret from its own environment or a fixture; the log
  // Hydra keeps as evidence, and the tail folded into the result, are both redacted.
  const redact = run.redact ?? redactText;
  const rawServerLog = await readFile(serverLog, 'utf8').catch(() => undefined);
  if (rawServerLog !== undefined) {
    const redactedServerLog = redact(rawServerLog);
    if (redactedServerLog !== rawServerLog) await writeFile(serverLog, redactedServerLog, 'utf8').catch(() => undefined);
  }
  const evidence = [...pictures, serverLog];
  if (run.signal?.aborted) return notRun(gate, 'Stopped before it finished.', elapsed(), { evidence });
  const listed = [...new Set(problems.map(problem => redact(problem)))];
  const shown = listed.slice(0, maxProblems).concat(listed.length > maxProblems ? [`…and ${listed.length - maxProblems} more.`] : []);
  if (!listed.length && tooling) return notRun(gate, tooling, elapsed(), { evidence });
  const serverOutput = listed.length && !pictures.length ? await readFile(serverLog, 'utf8').catch(() => '') : '';
  const failed = listed.length > 0;
  return {
    id: gate.id, kind: 'screenshots', required: gate.required, state: failed ? 'failed' : 'passed', passed: !failed,
    exitCode: null, durationMs: elapsed(),
    outputTail: clip([...shown, ...(tooling ? [tooling] : []), ...(serverOutput.trim() ? ['', 'The app\'s output:', tail(serverOutput.trim(), 1000)] : [])].join('\n'), 2000),
    evidence,
    summary: failed ? clip(listed[0]!, 300) + (listed.length > 1 ? ` (${listed.length} problems)` : '') : `${pictures.length} ${pictures.length === 1 ? 'screenshot' : 'screenshots'}; no problems.`,
  };
}

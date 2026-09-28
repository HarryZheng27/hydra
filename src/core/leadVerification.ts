import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { LeadVerifier } from './helperEndpoint';
import type { Provider } from './model';

/**
 * Who may act as a window's lead (docs/Heads.md, Security). There is no lead
 * token on disk: a lead's bridge asks for one once, and Hydra first asks the OS
 * which process opened that connection and walks its parents.
 *
 * - Refused if the chain passes through any process Hydra started for a helper
 *   or a helper's checks: a helper, or anything it started, can't act as the lead.
 * - Accepted only if the chain reaches this Hydra window (its extension host or
 *   main process). A process that detached itself to escape its helper has a
 *   broken chain and is refused.
 *
 * The OS reports the connection's owner, so a caller can't claim another identity.
 * PIDs can be reused, so an ancestor created after its child ends the chain.
 */
export interface ProcessLink { pid: number; ppid: number; created: number; name?: string }
export interface LeadRules { allowedAncestors: ReadonlySet<number>; deniedAncestors: ReadonlySet<number> }

/** Which agent a verified chain belongs to, from its process names (claude.exe, codex.exe). */
export function chainProvider(chain: readonly ProcessLink[]): Provider | undefined {
  for (const link of chain) {
    const name = (link.name || '').toLowerCase().replace(/\.exe$/, '');
    if (name === 'claude') return 'claude';
    if (name === 'codex') return 'codex';
  }
  return undefined;
}
export function evaluateLeadChain(chain: readonly ProcessLink[], rules: LeadRules): { ok: true; provider?: Provider } | { ok: false; reason: string } {
  const trusted = trustedChain(chain);
  if (!trusted.length) return { ok: false, reason: 'the connecting process could not be identified.' };
  if (trusted.some(link => rules.deniedAncestors.has(link.pid))) return { ok: false, reason: 'it runs inside a Hydra head, and heads cannot act as the lead.' };
  if (trusted.some(link => rules.allowedAncestors.has(link.pid))) { const provider = chainProvider(trusted); return provider ? { ok: true, provider } : { ok: true }; }
  return { ok: false, reason: 'it was not started from this Hydra window (use the Claude Code or Codex extension, or a terminal inside Hydra).' };
}

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Which process owns a loopback connection's client end — cheap, and specific to one socket, so it always runs fresh. */
function connectionOwner(socket: Socket): Promise<number | undefined> {
  const clientPort = Number(socket.remotePort), serverPort = Number(socket.localPort);
  if (!Number.isInteger(clientPort) || !Number.isInteger(serverPort)) return Promise.resolve(undefined);
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${clientPort} -RemotePort ${serverPort} -State Established -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if ($c) { [int]$c.OwningProcess } else { -1 }',
  ].join('; ');
  return new Promise(resolve => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const pid = Number(stdout.trim());
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

/** One process, as the machine-wide scan below reports it. */
export interface ProcessTableEntry { ppid: number; created: number; name?: string }
export type ProcessTable = ReadonlyMap<number, ProcessTableEntry>;

/** Every process on the machine: what a chain is walked from (Get-CimInstance Win32_Process — a full table scan). */
function scanWindowsProcesses(): Promise<ProcessTable> {
  const script = [
    '$procs = @(); Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { $procs += [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; created = [int64]$_.CreationDate.ToFileTimeUtc(); name = $_.Name } }',
    'ConvertTo-Json -Compress @($procs)',
  ].join('; ');
  return new Promise(resolve => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      const table = new Map<number, ProcessTableEntry>();
      if (error) return resolve(table);
      try {
        const parsed = JSON.parse(stdout.trim() || '[]') as { pid: number; ppid: number; created: number; name?: string }[] | { pid: number; ppid: number; created: number; name?: string };
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          if (Number.isInteger(entry.pid) && Number.isInteger(entry.ppid) && Number.isFinite(entry.created)) table.set(entry.pid, { ppid: entry.ppid, created: entry.created, name: entry.name });
        }
      } catch { /* an empty table refuses every chain, same as a script that failed to run */ }
      resolve(table);
    });
  });
}

/**
 * Coalesces concurrent calls to `scan` into whichever scan is already in flight, so a burst of new
 * lead/user connections at once (several heads calling hydra_done in the same second; a script
 * polling `hydra status`) shares one process-table scan instead of each paying for its own —
 * `Get-CimInstance Win32_Process` enumerates every process on the machine, which is real CPU work
 * to repeat N times over.
 *
 * Deliberately not a time-based cache (a short TTL, kept and reused after the scan that filled it
 * finishes): HSEC-07/HSEC-63 catch a reused PID by comparing a process's own `created` timestamp
 * against its child's in the *same* snapshot, which only holds if that snapshot reflects who is
 * actually running right now. A process can exit and have its PID recycled within a second or two
 * on a busy machine (exactly the kind of burst this exists to survive), so an entry served from a
 * snapshot that has gone stale could describe the wrong process entirely — the very race the
 * `created` check exists to catch. Coalescing only concurrent callers keeps every answer bounded by
 * how long one real scan takes, never by an arbitrary hold time; the next call after a scan settles
 * always starts a fresh one.
 */
export function coalescedScanner(scan: () => Promise<ProcessTable>, now: () => number = Date.now): (log?: (line: string) => void) => Promise<ProcessTable> {
  let inFlight: Promise<ProcessTable> | undefined;
  return log => {
    if (!inFlight) {
      const started = now();
      const scanned = scan();
      inFlight = scanned;
      scanned.then(table => log?.(`[lead] process scan: ${table.size} processes in ${Math.max(0, Math.round(now() - started))}ms`), () => undefined);
      // Attached directly to `scanned` (not chained off the logging `.then` above), so the very
      // next call after this one settles sees `inFlight` already cleared, not one microtask late.
      scanned.finally(() => { if (inFlight === scanned) inFlight = undefined; }).catch(() => undefined);
    }
    return inFlight;
  };
}

const scanProcesses = coalescedScanner(scanWindowsProcesses);

/** The connecting process and its ancestors, from the OS (Windows). */
export async function windowsConnectionChain(socket: Socket, log?: (line: string) => void): Promise<ProcessLink[]> {
  const ownerPid = await connectionOwner(socket);
  if (ownerPid === undefined) return [];
  const table = await scanProcesses(log);
  const chain: ProcessLink[] = [];
  let id = ownerPid;
  for (let i = 0; i < 64; i++) {
    const entry = table.get(id);
    if (!entry) break;
    chain.push({ pid: id, ppid: entry.ppid, created: entry.created, name: entry.name });
    id = entry.ppid;
  }
  return chain;
}

/**
 * The lead check for this window. On Windows it uses the OS connection owner; on
 * other platforms Hydra has no such check yet and accepts, as before.
 */
export function createLeadVerifier(rules: () => LeadRules, chainFor: (socket: Socket, log?: (line: string) => void) => Promise<ProcessLink[]> = windowsConnectionChain, platform = process.platform, log?: (line: string) => void): LeadVerifier {
  return async socket => {
    if (platform !== 'win32') return { ok: true };
    return evaluateLeadChain(await chainFor(socket, log), rules());
  };
}

// ---- O8a: the user role (docs/Heads.md, "Scripts and CI") ----

/** The trusted part of a chain: from the connecting process up, until a link's parent doesn't match or was created after it (a reused PID). */
function trustedChain(chain: readonly ProcessLink[]): ProcessLink[] {
  if (!chain.length) return [];
  const trusted: ProcessLink[] = [chain[0]!];
  for (let index = 1; index < chain.length; index++) {
    const child = trusted[trusted.length - 1]!, parent = chain[index]!;
    if (parent.pid !== child.ppid || parent.created > child.created) break;
    trusted.push(parent);
  }
  return trusted;
}

/**
 * Who may use the user token from the handshake file. A script or CI job runs anywhere (an outside
 * terminal, a scheduled task), so unlike a lead it needn't descend from this window. It is refused
 * only when its process chain passes through a process Hydra started for a head or its checks: a
 * head that read the handshake file (it can read as you through its shell; docs/THREAT_MODEL.md,
 * HR-19) still can't use it from inside the head. A chain the OS can't report is refused, never
 * assumed clean.
 */
export function evaluateUserChain(chain: readonly ProcessLink[], rules: Pick<LeadRules, 'deniedAncestors'>): { ok: true } | { ok: false; reason: string } {
  const trusted = trustedChain(chain);
  if (!trusted.length) return { ok: false, reason: 'the connecting process could not be identified.' };
  if (trusted.some(link => rules.deniedAncestors.has(link.pid))) return { ok: false, reason: 'it runs inside a Hydra head, and heads cannot act as you.' };
  return { ok: true };
}

/** The user-token check for this window: on Windows the OS connection owner; elsewhere Hydra has no such check yet and accepts, as the lead check does. */
export function createUserVerifier(rules: () => Pick<LeadRules, 'deniedAncestors'>, chainFor: (socket: Socket, log?: (line: string) => void) => Promise<ProcessLink[]> = windowsConnectionChain, platform = process.platform, log?: (line: string) => void): (socket: Socket) => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async socket => {
    if (platform !== 'win32') return { ok: true };
    return evaluateUserChain(await chainFor(socket, log), rules());
  };
}

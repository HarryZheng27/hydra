import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import { leadGuidanceMarkdown } from './helperTools';
import { processLaunch } from './process';
import { helpersRootCandidates } from './hydraCli';
import { addClaudeLimitHook, limitHookPaths, readClaudeLimitHooks, removeClaudeLimitHook, type AttentionHookGroups, type LimitHookGroup } from './claudeLimitHook';

/**
 * Connecting Claude Code and Codex to Hydra (docs/internal/Official_Extensions_Plan.md,
 * Phase 5). The connection is between Hydra and the user's Claude Code / Codex
 * install, never a project: Hydra adds itself as a user-level tool server named
 * "hydra" and nothing is written inside any repository.
 *
 * - Claude: registered through Claude's own `claude mcp add-json -s user`
 *   (Claude rewrites ~/.claude.json itself all the time), plus one "mcp__hydra"
 *   allow rule and one StopFailure hook (claudeLimitHook.ts) inserted into
 *   ~/.claude/settings.json without reformatting it.
 * - Codex: one clearly marked block appended to ~/.codex/config.toml. `codex mcp
 *   add` reformats the whole file, so Hydra writes and removes only its block;
 *   the rest of the file stays byte-identical.
 */
export type ConnectableProvider = 'claude' | 'codex';
export interface HelperServerSpec { command: string; args: string[]; env: Record<string, string> }
export interface ConnectionStatus {
  provider: ConnectableProvider; connected: boolean; current: boolean; error?: string;
  /**
   * For an entry that isn't exactly this Hydra's current one: whether it is another Hydra's that reaches this one (its
   * program and script are still there, it runs as Node, and it looks in the same helpers folder). False for this
   * Hydra's own entry made by an older version, and for anything else, which are repaired.
   */
  targetExists?: boolean;
}

/** What a registered bridge runs, read back from the entry. */
export interface RegisteredBridge { command?: string; script?: string; helpersDir?: string; runAsNode?: string }

const samePath = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** Whether a registered bridge's program and script (its first argument) both exist. */
export function bridgeTargetExists(command: string | undefined, args: readonly string[] | undefined, exists: (file: string) => boolean = existsSync): boolean {
  const script = args?.[0];
  return !!command && !!script && exists(command) && exists(script);
}

/**
 * Whether a registered bridge is another Hydra's that reaches this one (G5): the IDE and the Hydra app run the same
 * bridge over the same storage, so an entry for the other one, still installed, works for both and is left alone.
 * This Hydra's own entry (same program and script, older shape) isn't: it is upgraded. Neither is one that looks in
 * another helpers folder (a development or test window's), or that isn't run as Node.
 */
export function reachesThisHydra(entry: RegisteredBridge, spec: HelperServerSpec, exists: (file: string) => boolean = existsSync, standard = isStandardHelpersDir(spec.env.HYDRA_HELPERS_DIR)): boolean {
  if (samePath(entry.command, spec.command) && samePath(entry.script, spec.args[0])) return false;
  if (!bridgeTargetExists(entry.command, entry.script ? [entry.script] : [], exists) || entry.runAsNode !== '1') return false;
  // A window on its own profile (a probe's --user-data-dir, a portable copy) never takes over another installed
  // Hydra's entry: only a Hydra on the standard storage repairs one that looks in another helpers folder.
  return samePath(entry.helpersDir, spec.env.HYDRA_HELPERS_DIR) || !standard;
}

/** Whether a helpers folder is the standard one an installed Hydra uses (the IDE's and the app's shared storage), not a separate profile's. */
export function isStandardHelpersDir(dir: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!dir) return false;
  return helpersRootCandidates({ ...env, HYDRA_HELPERS_DIR: undefined }, process.platform, homedir()).some(root => samePath(root, dir));
}

/**
 * Whether an entry should be repaired to point at this Hydra (G5): it is Hydra's, not exactly this Hydra's current
 * one, and not another Hydra's that reaches this one (reachesThisHydra), so the IDE and the app never take turns.
 */
export const shouldRepairConnection = (status: ConnectionStatus): boolean => status.connected && !status.current && !status.error && status.targetExists !== true;

export const serverName = 'hydra';
export const claudeAllowRule = 'mcp__hydra';
export const blockStart = '# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)';
export const blockEnd = '# <<< Hydra helpers';

export interface ProviderPaths { claudeJson: string; claudeSettings: string; codexConfig: string; claudeProjects: string }
export function providerPaths(env: NodeJS.ProcessEnv = process.env): ProviderPaths {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  return {
    claudeProjects: path.join(claudeDir, 'projects'),
    claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homedir(), '.claude.json'),
    claudeSettings: path.join(claudeDir, 'settings.json'),
    codexConfig: path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml'),
  };
}

/** A file's text, or undefined when it doesn't exist. */
export const read = async (file: string): Promise<string | undefined> => { try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.hydra-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try { await replaceAtomic(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
/** The file's own line ending: CRLF if it has any, else LF. */
export const eolOf =(text: string) => text.includes('\r\n') ? '\r\n' : '\n';

// ---- Codex ----

/** A TOML literal string. Paths never contain a single quote; refuse rather than mis-quote. */
function literal(value: string): string {
  if (value.includes("'") || /[\r\n]/.test(value)) throw new Error('A Hydra head setting contains a quote or line break.');
  return `'${value}'`;
}
export function codexBlock(spec: HelperServerSpec, eol = '\n'): string {
  return [
    '', blockStart,
    `[mcp_servers.${serverName}]`,
    `command = ${literal(spec.command)}`,
    `args = [${spec.args.map(literal).join(', ')}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 3600',
    "default_tools_approval_mode = 'approve'",
    '',
    `[mcp_servers.${serverName}.env]`,
    ...Object.entries(spec.env).map(([key, value]) => `${key} = ${literal(value)}`),
    blockEnd, '',
  ].join(eol);
}
/** The text without Hydra's block, and whether it had one. Byte-exact inverse of addCodexBlock. */
export function removeCodexBlock(text: string): { text: string; had: boolean } {
  return removeMarkedBlock(text, blockStart, blockEnd, 'Hydra\'s block in the Codex config is damaged. Remove the lines between the Hydra markers by hand.');
}
/**
 * Remove one block that was appended as `eol + start + eol + … + eol + end + eol`
 * (its lines joined with the file's own line ending, with an empty first and last
 * element). The byte-exact inverse of appending it, whatever came before or after.
 */
export function removeMarkedBlock(text: string, start: string, end: string, damaged: string): { text: string; had: boolean } {
  for (const eol of ['\r\n', '\n']) {
    const from = text.indexOf(`${eol}${start}${eol}`);
    if (from < 0) continue;
    const endMarker = `${eol}${end}${eol}`;
    const to = text.indexOf(endMarker, from);
    if (to < 0) throw new Error(damaged);
    return { text: text.slice(0, from) + text.slice(to + endMarker.length), had: true };
  }
  return { text, had: false };
}
/** The block itself (markers included, trimmed), read back the same way removeMarkedBlock finds it. Undefined when absent. */
export function readMarkedBlock(text: string, start: string, end: string): string | undefined {
  for (const eol of ['\r\n', '\n']) {
    const from = text.indexOf(`${eol}${start}${eol}`);
    if (from < 0) continue;
    const endMarker = `${eol}${end}${eol}`;
    const to = text.indexOf(endMarker, from);
    if (to < 0) return undefined;
    return text.slice(from + eol.length, to + eol.length + end.length);
  }
  return undefined;
}
export function addCodexBlock(text: string, spec: HelperServerSpec): string {
  const without = removeCodexBlock(text).text;
  if (new RegExp(`^\\s*\\[mcp_servers\\.${serverName}(\\]|\\.)`, 'm').test(without)) throw new Error(`Your Codex config already has an "${serverName}" MCP server that Hydra didn't add. Rename or remove it first.`);
  return without + codexBlock(spec, eolOf(without || '\n'));
}
/**
 * Codex's turn-complete notifier (docs/internal/Needs_You_Plan.md, Phase 4). `notify` is a top-level key, so it can't sit in
 * the appended block (that block ends in tables): it is its own marked block at the very top of the file, removed
 * byte-exactly. A `notify` the user already set is never replaced: Hydra writes nothing then, and lanes get no signal.
 */
export const notifyStart = '# >>> Hydra lane notifier (managed by Hydra: connect or disconnect in Hydra Settings)';
export const notifyEnd = '# <<< Hydra lane notifier';
const basicString = (value: string) => JSON.stringify(value);
export function codexNotifyBlock(command: string[], eol = '\n'): string {
  return [notifyStart, `notify = [${command.map(basicString).join(', ')}]`, notifyEnd, ''].join(eol);
}
/**
 * Where Hydra's three lines are: the start marker, its own `notify` line right after it, and the end marker. Found
 * anywhere in the file (a comment or a BOM above it doesn't hide it). Codex edits config.toml itself and can write a
 * key between the markers, so only these three lines are ever removed, never the range.
 */
function findNotify(text: string): { from: number; to: number }[] | undefined {
  // A BOM belongs to the file, not to its first line.
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)].map(match => { const bom = match.index === 0 && match[0].startsWith('﻿') ? 1 : 0; return { from: match.index! + bom, to: match.index! + match[0].length, content: match[0].slice(bom).replace(/\r?\n$/, '') }; });
  const start = lines.findIndex(line => line.content === notifyStart);
  if (start < 0) return undefined;
  const own = lines[start + 1], end = lines.findIndex((line, index) => index > start + 1 && line.content === notifyEnd);
  if (!own || !/^notify\s*=\s*\[/.test(own.content) || end < 0) throw new Error('Hydra\'s notifier block in the Codex config is damaged. Remove the lines between the Hydra markers by hand.');
  return [lines[start]!, own, lines[end]!];
}
/** The text without Hydra's notifier block, and whether it had one. Byte-exact inverse of addCodexNotify. */
export function removeCodexNotify(text: string): { text: string; had: boolean } {
  const found = findNotify(text);
  if (!found) return { text, had: false };
  let result = text;
  for (const line of [...found].reverse()) result = result.slice(0, line.from) + result.slice(line.to);
  return { text: result, had: true };
}
/**
 * Whether the file sets a top-level `notify` of its own (outside Hydra's block): before the first table header, as TOML
 * requires. Read as TOML is, so a `[` inside a multi-line string or a nested array isn't a table header.
 */
export function codexHasOwnNotify(source: string): boolean {
  const text = removeCodexNotify(source).text;
  let depth = 0, atStart = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (atStart && depth === 0) {
      const rest = text.slice(i, i + 40);
      if (/^[ \t]/.test(rest)) continue;
      if (rest.startsWith('[')) return false;
      if (/^(?:notify|"notify"|'notify')[ \t]*=/.test(rest)) return true;
    }
    atStart = false;
    if (char === '\n') { atStart = true; continue; }
    if (char === '#') { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), i), close = triple ? char.repeat(3) : char;
      i += triple ? 3 : 1;
      while (i < text.length) {
        if (char === '"' && text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(close, i)) break;
        if (!triple && text[i] === '\n') break;
        i++;
      }
      i += close.length - 1;
      continue;
    }
    if (char === '[') depth++;
    else if (char === ']' && depth > 0) depth--;
  }
  return false;
}
/** Put the notifier at the top (below a BOM), or leave the file alone (the user's own `notify`). `command` undefined removes Hydra's block. */
export function addCodexNotify(text: string, command: string[] | undefined): string {
  // Already written exactly so (and nothing of the user's `notify` besides): leave the file as it is, whatever Codex added around it.
  const current = command && findNotify(text);
  if (current && text.slice(current[1]!.from, current[1]!.to).replace(/\r?\n$/, '') === `notify = [${command.map(basicString).join(', ')}]` && !codexHasOwnNotify(text)) return text;
  const without = removeCodexNotify(text).text;
  if (!command || codexHasOwnNotify(without)) return without;
  const bom = without.startsWith('\uFEFF') ? '\uFEFF' : '', rest = without.slice(bom.length);
  return bom + codexNotifyBlock(command, eolOf(rest || '\n')) + rest;
}
/** What the notifier block runs, read back: the same executable and script limitHookPaths finds in a hook. */
export function codexNotifyPaths(text: string): { executable?: string; script?: string } {
  try {
    const found = findNotify(text);
    const line = found && /^notify\s*=\s*(\[.*\])\s*$/.exec(text.slice(found[1]!.from, found[1]!.to).replace(/\r?\n$/, ''));
    const parts = JSON.parse(line?.[1] ?? '') as unknown;
    if (!Array.isArray(parts) || parts.some(part => typeof part !== 'string')) return {};
    return limitHookPaths({ matcher: '', hooks: [{ type: 'command', command: parts[0], args: parts.slice(1), timeout: 10 }] });
  } catch { return {}; }
}
/** Codex's notifier lines, exactly as written. */
export function readCodexNotify(text: string): string | undefined {
  try { const found = findNotify(text); return found && found.map(line => text.slice(line.from, line.to).replace(/\r?\n$/, '')).join('\n'); } catch { return undefined; }
}

/**
 * Codex may not read an MCP server's instructions, so the lead guidance (when to
 * start heads without being asked) also goes into Codex's global AGENTS.md, next
 * to config.toml, as a marked block removed byte-exactly on disconnect.
 */
const guidanceStart = '<!-- >>> Hydra heads (managed by Hydra: connect or disconnect in Hydra Settings) -->';
const guidanceEnd = '<!-- <<< Hydra heads -->';
export const codexAgentsFile = (configFile: string) => path.join(path.dirname(configFile), 'AGENTS.md');
export function guidanceBlock(eol = '\n'): string { return ['', guidanceStart, ...leadGuidanceMarkdown.trimEnd().split('\n'), guidanceEnd, ''].join(eol); }
export function removeGuidanceBlock(text: string): { text: string; had: boolean } {
  return removeMarkedBlock(text, guidanceStart, guidanceEnd, 'Hydra\'s block in Codex\'s AGENTS.md is damaged. Remove the lines between the Hydra markers by hand.');
}
export function addGuidanceBlock(text: string): string {
  const without = removeGuidanceBlock(text).text;
  return without + guidanceBlock(eolOf(without || '\n'));
}

export async function codexStatus(file: string, spec: HelperServerSpec): Promise<ConnectionStatus> {
  try {
    const text = await read(file) ?? '', agents = await read(codexAgentsFile(file)) ?? '';
    const had = removeCodexBlock(text).had;
    const guided = agents.includes(guidanceBlock(eolOf(agents)).trim());
    const current = had && guided && text.includes(codexBlock(spec, eolOf(text)).trim());
    return { provider: 'codex', connected: had, current, ...(had && !current ? { targetExists: reachesThisHydra(codexRegisteredBridge(text), spec) } : {}) };
  } catch (error) { return { provider: 'codex', connected: false, current: false, error: error instanceof Error ? error.message : String(error) }; }
}
/** What Hydra's block in Codex's config runs, read back from it (literal or basic strings, spaces allowed). */
export function codexRegisteredBridge(text: string): RegisteredBridge {
  const start = text.indexOf(blockStart), end = text.indexOf(blockEnd, start);
  if (start < 0 || end < 0) return {};
  const block = text.slice(start, end);
  const value = (pattern: RegExp) => { const match = pattern.exec(block); return match ? (match[1] === '"' ? match[2]!.replace(/\\\\/g, '\\') : match[2]) : undefined; };
  return {
    command: value(/^\s*command\s*=\s*(['"])([^'"\r\n]*)\1/m),
    script: value(/^\s*args\s*=\s*\[\s*(['"])([^'"\r\n]*)\1/m),
    helpersDir: value(/^\s*HYDRA_HELPERS_DIR\s*=\s*(['"])([^'"\r\n]*)\1/m),
    runAsNode: value(/^\s*ELECTRON_RUN_AS_NODE\s*=\s*(['"])([^'"\r\n]*)\1/m),
  };
}
/** `notify`: the lane notifier for the top of config.toml (codexNotifyCommand). Undefined, or a user's own `notify`, writes none. */
export async function connectCodex(file: string, spec: HelperServerSpec, notify?: string[]): Promise<void> {
  const config = addCodexNotify(addCodexBlock(await read(file) ?? '', spec), notify);
  const agentsFile = codexAgentsFile(file);
  await writeAtomic(agentsFile, addGuidanceBlock(await read(agentsFile) ?? ''));
  await writeAtomic(file, config);
}
export async function disconnectCodex(file: string): Promise<void> {
  const text = await read(file);
  if (text !== undefined) {
    const block = removeCodexBlock(text), notify = removeCodexNotify(block.text);
    if (block.had || notify.had) await writeAtomic(file, notify.text);
  }
  const agentsFile = codexAgentsFile(file), agents = await read(agentsFile);
  if (agents === undefined) return;
  const removed = removeGuidanceBlock(agents);
  if (!removed.had) return;
  // Hydra created the file if nothing else is left in it.
  if (removed.text === '') await rm(agentsFile, { force: true });
  else await writeAtomic(agentsFile, removed.text);
}

// ---- Claude ----

/** Insert the allow rule into "permissions.allow" without reformatting the file. */
export function addClaudeAllowRule(text: string | undefined): string {
  if (!text?.trim()) return JSON.stringify({ permissions: { allow: [claudeAllowRule] } }, null, 2) + '\n';
  const parsed = JSON.parse(text) as { permissions?: { allow?: unknown } };
  const allow = parsed.permissions?.allow;
  if (Array.isArray(allow) && allow.includes(claudeAllowRule)) return text;
  const eol = eolOf(text);
  const match = /"allow"\s*:\s*\[/.exec(text);
  if (match && Array.isArray(allow)) {
    const at = match.index + match[0].length;
    const next = /\S/.exec(text.slice(at));
    const indent = /(\r?\n)([ \t]*)"allow"/.exec(text.slice(0, at))?.[2] ?? '  ';
    const insertion = next?.[0] === ']' ? `"${claudeAllowRule}"` : `${eol}${indent}  "${claudeAllowRule}",`;
    return text.slice(0, at) + insertion + text.slice(at);
  }
  // No allow list to extend: rewrite with the rule added (formatting of this rare case is not preserved).
  const permissions = (parsed.permissions && typeof parsed.permissions === 'object' ? parsed.permissions : {}) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, permissions: { ...permissions, allow: [...(Array.isArray(allow) ? allow : []), claudeAllowRule] } }, null, 2) + eol;
}
/** Exact inverse of addClaudeAllowRule's in-place insertions. */
export function removeClaudeAllowRule(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const eol of ['\r\n', '\n']) {
    const found = new RegExp(`${eol.replace('\r', '\\r').replace('\n', '\\n')}[ \\t]*"${claudeAllowRule}",`).exec(text);
    if (found) return text.slice(0, found.index) + text.slice(found.index + found[0].length);
  }
  if (text.includes(`[\"${claudeAllowRule}\"]`)) return text.replace(`[\"${claudeAllowRule}\"]`, '[]');
  return text;
}

export async function claudeStatus(paths: ProviderPaths, spec: HelperServerSpec): Promise<ConnectionStatus> {
  try {
    const config = JSON.parse(await read(paths.claudeJson) ?? '{}') as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
    const entry = config.mcpServers?.[serverName];
    const current = !!entry && entry.command === spec.command && JSON.stringify(entry.args) === JSON.stringify(spec.args) && JSON.stringify(entry.env) === JSON.stringify(spec.env);
    return { provider: 'claude', connected: !!entry, current, ...(entry && !current ? { targetExists: reachesThisHydra({ command: entry.command, script: entry.args?.[0], helpersDir: entry.env?.HYDRA_HELPERS_DIR, runAsNode: entry.env?.ELECTRON_RUN_AS_NODE }, spec) } : {}) };
  } catch (error) { return { provider: 'claude', connected: false, current: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Run Claude's CLI with an argument array (no shell string; `.cmd` shims go through processLaunch). */
export function runClaude(executable: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    execFile(launch.executable, launch.args, { windowsHide: true, timeout: 60_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0, output: `${stdout}${stderr}` });
    });
  });
}
/** Add, upgrade (`group`) or remove (undefined) Hydra's StopFailure hook, touching only its bytes. */
export async function setClaudeLimitHook(paths: ProviderPaths, group: LimitHookGroup | undefined, attention?: AttentionHookGroups): Promise<void> {
  const settings = await read(paths.claudeSettings);
  const updated = group ? addClaudeLimitHook(settings, group, attention) : removeClaudeLimitHook(settings).text;
  if (updated !== undefined && updated !== settings) await writeAtomic(paths.claudeSettings, updated);
}
/** `limitHook`: the StopFailure hook to install, when this Claude supports it (claudeSupportsLimitHook). */
export async function connectClaude(executable: string, paths: ProviderPaths, spec: HelperServerSpec, limitHook?: LimitHookGroup, attention?: AttentionHookGroups): Promise<void> {
  const add = () => runClaude(executable, ['mcp', 'add-json', '-s', 'user', serverName, JSON.stringify({ type: 'stdio', command: spec.command, args: spec.args, env: spec.env, timeout: 3_600_000 })]);
  await runClaude(executable, ['mcp', 'remove', '-s', 'user', serverName]);
  let added = await add();
  // Another Hydra window can re-add its own entry between our remove and add; remove it once more and retry.
  if (added.code !== 0 && /already exists/i.test(added.output)) { await runClaude(executable, ['mcp', 'remove', '-s', 'user', serverName]); added = await add(); }
  if (added.code !== 0) throw new Error(`Claude Code could not add Hydra: ${added.output.trim().slice(0, 300)}`);
  const settings = await read(paths.claudeSettings);
  const allowed = addClaudeAllowRule(settings);
  const updated = limitHook ? addClaudeLimitHook(allowed, limitHook, attention) : allowed;
  if (updated !== settings) await writeAtomic(paths.claudeSettings, updated);
}
export async function disconnectClaude(executable: string | undefined, paths: ProviderPaths): Promise<void> {
  if (executable) await runClaude(executable, ['mcp', 'remove', '-s', 'user', serverName]);
  const settings = await read(paths.claudeSettings);
  const updated = removeClaudeAllowRule(removeClaudeLimitHook(settings).text);
  if (settings !== undefined && updated !== settings) await writeAtomic(paths.claudeSettings, updated!);
}

// ---- "What Hydra wrote" (Settings, Connectors page): the exact user-level
// entries read back off disk now, secrets masked, falling back to undefined
// ("not written") when absent. Pure and read-only; never touches a file. ----

/** Mask any `KEY = 'value'`-shaped line whose key looks like a secret (used on the Codex block, read back as plain text). */
function maskAssignmentLines(text: string, mask: (key: string, value: string) => string): string {
  return text.replace(/^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)'([^']*)'/gm, (line, indent: string, key: string, equals: string, value: string) => {
    const shown = mask(key, value);
    return shown === value ? line : `${indent}${key}${equals}'${shown}'`;
  });
}

/** The exact `mcpServers.hydra` entry in ~/.claude.json now, env values masked. Undefined when Claude has none. */
export async function claudeWrittenServer(paths: ProviderPaths, mask: (key: string | undefined, value: string) => string): Promise<string | undefined> {
  const raw = await read(paths.claudeJson);
  if (!raw) return undefined;
  try {
    const config = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> } & Record<string, unknown>> };
    const entry = config.mcpServers?.[serverName];
    if (!entry) return undefined;
    const masked = entry.env ? { ...entry, env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, mask(key, String(value))])) } : entry;
    return JSON.stringify({ [serverName]: masked }, null, 2);
  } catch { return undefined; }
}
/** The exact allow rule Hydra inserted into ~/.claude/settings.json. Undefined when it isn't there. */
export async function claudeWrittenAllowRule(paths: ProviderPaths): Promise<string | undefined> {
  const raw = await read(paths.claudeSettings);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { permissions?: { allow?: unknown } };
    const allow = parsed.permissions?.allow;
    return Array.isArray(allow) && allow.includes(claudeAllowRule) ? `"${claudeAllowRule}"` : undefined;
  } catch { return undefined; }
}
/** The StopFailure hook group(s) Hydra inserted into ~/.claude/settings.json. Undefined when there are none. */
export async function claudeWrittenLimitHook(paths: ProviderPaths): Promise<string | undefined> {
  const groups = readClaudeLimitHooks(await read(paths.claudeSettings).catch(() => undefined));
  return groups.length ? groups.map(group => JSON.stringify(group, null, 2)).join('\n') : undefined;
}
/** The Stop and Notification hook groups Hydra inserted (the lane attention hooks). Undefined when there are none. */
export async function claudeWrittenAttentionHooks(paths: ProviderPaths): Promise<string | undefined> {
  const text = await read(paths.claudeSettings).catch(() => undefined);
  const groups = (['Stop', 'Notification'] as const).flatMap(event => readClaudeLimitHooks(text, event).map(group => JSON.stringify({ [event]: group }, null, 2)));
  return groups.length ? groups.join('\n') : undefined;
}
/** The exact notifier block at the top of ~/.codex/config.toml. Undefined when it isn't there. */
export async function codexWrittenNotify(file: string): Promise<string | undefined> {
  const text = await read(file).catch(() => undefined);
  return text ? readCodexNotify(text) : undefined;
}
/** The exact `[mcp_servers.hydra]` block in ~/.codex/config.toml now, env values masked. Undefined when it isn't there. */
export async function codexWrittenBlock(file: string, mask: (key: string, value: string) => string): Promise<string | undefined> {
  const text = await read(file);
  const block = text ? readMarkedBlock(text, blockStart, blockEnd) : undefined;
  return block ? maskAssignmentLines(block, mask) : undefined;
}
/** The exact Hydra guidance block in Codex's AGENTS.md now. Undefined when it isn't there. */
export async function codexWrittenGuidance(file: string): Promise<string | undefined> {
  const agents = await read(codexAgentsFile(file));
  return agents ? readMarkedBlock(agents, guidanceStart, guidanceEnd) : undefined;
}
export interface WrittenEntries { claude: { server?: string; allowRule?: string; limitHook?: string; attentionHooks?: string }; codex: { config?: string; agents?: string; notify?: string } }
/** Everything Hydra has written for both providers, read straight off disk. */
export async function helperWrittenEntries(paths: ProviderPaths, mask: (key: string | undefined, value: string) => string): Promise<WrittenEntries> {
  const [server, allowRule, limitHook, attentionHooks, config, agents, notify] = await Promise.all([
    claudeWrittenServer(paths, mask), claudeWrittenAllowRule(paths), claudeWrittenLimitHook(paths), claudeWrittenAttentionHooks(paths),
    codexWrittenBlock(paths.codexConfig, mask), codexWrittenGuidance(paths.codexConfig), codexWrittenNotify(paths.codexConfig),
  ]);
  return { claude: { server, allowRule, ...(limitHook ? { limitHook } : {}), ...(attentionHooks ? { attentionHooks } : {}) }, codex: { config, agents, ...(notify ? { notify } : {}) } };
}

import { execFile } from 'node:child_process';
import { readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { limitHookPaths, removeClaudeLimitHook, scanJson } from './claudeLimitHook';
import { blockEnd, blockStart, codexAgentsFile, providerPaths, read, readMarkedBlock, removeClaudeAllowRule, removeCodexBlock, removeGuidanceBlock, serverName, writeAtomic, type ProviderPaths } from './helperRegistration';
import { processLaunch } from './process';
import { findProvider } from './providers';

/**
 * Uninstall cleanup (dist/hydra-uninstall.cjs, run by the Windows uninstaller
 * before it deletes Hydra's files). Connecting Hydra (Settings, Connectors)
 * writes Hydra into Claude Code's and Codex's user settings; without this, both
 * keep trying to start a Hydra that no longer exists.
 *
 * Only this installation's entries go. Another Hydra (a dev build, a second
 * install) registers under the same name, so every entry that carries a path is
 * claimed only when that path lies inside the installation being removed. The
 * allow rule and Codex's guidance carry no path: they go only together with
 * this install's server entry from the same provider, so a Hydra that is still
 * installed keeps working.
 */

/**
 * Whether `candidate` is `app` or lies inside it. Lexical and deliberately
 * strict: both must be absolute, `..` is resolved first, Windows compares
 * without case, and a drive or share root is never an installation (it would
 * claim everything).
 */
export function insideInstall(candidate: unknown, app: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof candidate !== 'string' || !candidate || /[\0\r\n]/.test(candidate) || !app) return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(candidate) || !paths.isAbsolute(app)) return false;
  // "C:foo" is drive-relative on Windows, not absolute, whatever isAbsolute says of "\\foo".
  if (platform === 'win32' && ![candidate, app].every(value => /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value))) return false;
  const fold = (value: string) => platform === 'win32' ? value.toLowerCase() : value;
  const root = paths.resolve(app).replace(/[\\/]+$/, '');
  if (!root || paths.parse(paths.resolve(app)).root.replace(/[\\/]+$/, '') === root) return false;
  const resolved = fold(paths.resolve(candidate)), base = fold(root);
  return resolved === base || resolved.startsWith(base + paths.sep);
}

export interface CleanupOptions {
  /** The installation folder being removed ({app}). */
  app: string;
  dryRun?: boolean;
  paths?: ProviderPaths;
  /** The Claude CLI to remove the MCP entry with; undefined edits ~/.claude.json directly. */
  claude?: string;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  /** Tests: runs just before each write, to change the file underneath. */
  beforeWrite?: (file: string, attempt: number) => Promise<void>;
  /** Tests: stands in for running the Claude CLI. */
  runClaude?: (executable: string, args: string[]) => Promise<number>;
}
export interface CleanupReport { claudeServer: boolean; claudeAllowRule: boolean; claudeLimitHook: boolean; codexBlock: boolean; codexGuidance: boolean }

type ClaudeServers = { mcpServers?: Record<string, { command?: unknown } | undefined> };
const parse = (text: string | undefined): unknown => { if (!text?.trim()) return undefined; try { return JSON.parse(text.replace(/^﻿/, '')) as unknown; } catch { return undefined; } };
const claudeServer = (text: string | undefined) => (parse(text) as ClaudeServers | undefined)?.mcpServers?.[serverName];

/** ~/.claude.json without `mcpServers.hydra`, every other byte kept (Claude would write the same `{}`). */
export function removeClaudeServer(text: string): string {
  const root = scanJson(text);
  const servers = root.members?.find(entry => entry.key === 'mcpServers')?.value;
  const members = servers?.members;
  const index = members?.findIndex(entry => entry.key === serverName) ?? -1;
  if (!servers || !members || index < 0) return text;
  const entry = members[index]!;
  const splice = (from: number, to: number, replacement = '') => text.slice(0, from) + replacement + text.slice(to);
  if (index > 0) return splice(members[index - 1]!.value.end, entry.value.end);
  if (members.length > 1) return splice(entry.keyStart, members[1]!.keyStart);
  return splice(servers.start, servers.end, '{}');
}

/** The `command` inside Hydra's marked Codex block, read back from its TOML literal. */
export function codexBlockCommand(text: string): string | undefined {
  const block = readMarkedBlock(text, blockStart, blockEnd);
  return block ? /^command = '([^'\r\n]*)'\r?$/m.exec(block)?.[1] : undefined;
}

/**
 * Edit one file, guarding against another writer (Claude rewrites ~/.claude.json
 * constantly): read, compute, re-read just before writing and start again if it
 * changed, write atomically, then read back and check. Gives up quietly after a
 * few tries. Returns whether the edit is in place (or, dry run, would be made).
 */
async function editFile(file: string, edit: (text: string) => string | undefined, options: CleanupOptions, label: string): Promise<boolean> {
  const log = options.log ?? (() => undefined);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const before = await read(file);
    if (before === undefined) return false;
    const after = edit(before);
    if (after === undefined || after === before) return false;
    if (options.dryRun) { log(`would remove ${label} from ${file}`); return true; }
    await options.beforeWrite?.(file, attempt);
    if (await read(file) !== before) { log(`${file} changed while editing; trying again`); continue; }
    await writeAtomic(file, after);
    const check = await read(file);
    if (check === after) { log(`removed ${label} from ${file}`); return true; }
    log(`${file} changed after writing; trying again`);
  }
  log(`gave up removing ${label} from ${file}: it kept changing`);
  return false;
}

/** Guards each step, so one unreadable file never stops the rest. */
async function step<T>(label: string, log: (line: string) => void, fallback: T, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { log(`skipped ${label}: ${error instanceof Error ? error.message : String(error)}`); return fallback; }
}

function runCli(executable: string, args: string[], timeout: number): Promise<number> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    // No ELECTRON_RUN_AS_NODE for Claude; no auto-update during an uninstall.
    const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(launch.executable, launch.args, { windowsHide: true, timeout, env }, error => resolve(error ? 1 : 0));
  });
}

async function cleanClaude(options: CleanupOptions, paths: ProviderPaths, report: CleanupReport): Promise<void> {
  const log = options.log ?? (() => undefined), owned = (command: unknown) => insideInstall(command, options.app, options.platform);
  report.claudeServer = await step('the Claude MCP entry', log, false, async () => {
    const entry = claudeServer(await read(paths.claudeJson));
    if (!entry) { log('Claude has no hydra MCP entry'); return false; }
    if (!owned(entry.command)) { log('Claude\'s hydra MCP entry belongs to another Hydra; left alone'); return false; }
    if (options.dryRun) { log(`would remove Claude's hydra MCP entry (${paths.claudeJson})`); return true; }
    if (options.claude) {
      const code = await (options.runClaude ?? ((executable, args) => runCli(executable, args, 10_000)))(options.claude, ['mcp', 'remove', '-s', 'user', serverName]);
      const now = claudeServer(await read(paths.claudeJson));
      if (!now || !owned(now.command)) { log(`removed Claude's hydra MCP entry with the Claude CLI`); return true; }
      log(`the Claude CLI did not remove the entry (exit ${code}); editing ${paths.claudeJson} directly`);
    }
    return editFile(paths.claudeJson, text => owned(claudeServer(text)?.command) ? removeClaudeServer(text) : undefined, options, 'the hydra MCP entry');
  });
  const ownHook = (group: unknown) => { const { executable, script } = limitHookPaths(group); return owned(executable) && owned(script); };
  await step('Claude settings', log, undefined, async () => {
    let hook = false, rule = false;
    const done = await editFile(paths.claudeSettings, text => {
      const removed = removeClaudeLimitHook(text, ownHook);
      hook = removed.had;
      const withoutRule = report.claudeServer ? removeClaudeAllowRule(removed.text) : removed.text;
      rule = withoutRule !== removed.text;
      return withoutRule;
    }, options, 'Hydra\'s allow rule and usage-limit hook');
    report.claudeLimitHook = done && hook; report.claudeAllowRule = done && rule;
    if (!report.claudeServer) log('kept any mcp__hydra allow rule: this install had no Claude MCP entry');
  });
}

async function cleanCodex(options: CleanupOptions, paths: ProviderPaths, report: CleanupReport): Promise<void> {
  const log = options.log ?? (() => undefined);
  report.codexBlock = await step('the Codex block', log, false, async () => {
    const text = await read(paths.codexConfig);
    const command = text === undefined ? undefined : codexBlockCommand(text);
    if (command === undefined) { log('Codex has no Hydra block'); return false; }
    if (!insideInstall(command, options.app, options.platform)) { log('Codex\'s Hydra block belongs to another Hydra; left alone'); return false; }
    return editFile(paths.codexConfig, current => insideInstall(codexBlockCommand(current), options.app, options.platform) ? removeCodexBlock(current).text : undefined, options, 'Hydra\'s block');
  });
  if (!report.codexBlock) return;
  report.codexGuidance = await step('the Codex guidance', log, false, async () => {
    const agents = codexAgentsFile(paths.codexConfig), text = await read(agents);
    if (text === undefined || !removeGuidanceBlock(text).had) return false;
    // Hydra created AGENTS.md if nothing else is left in it (as disconnectCodex does).
    if (removeGuidanceBlock(text).text === '') {
      if (options.dryRun) { log(`would remove ${agents}`); return true; }
      await rm(agents, { force: true }); log(`removed ${agents}`); return true;
    }
    return editFile(agents, current => removeGuidanceBlock(current).text, options, 'Hydra\'s guidance');
  });
}

/** Remove this installation's entries from Claude Code's and Codex's user settings. Never throws. */
export async function cleanupInstall(options: CleanupOptions): Promise<CleanupReport> {
  const report: CleanupReport = { claudeServer: false, claudeAllowRule: false, claudeLimitHook: false, codexBlock: false, codexGuidance: false };
  const log = options.log ?? (() => undefined);
  if (!insideInstall(options.app, options.app, options.platform)) { log('no usable --app folder; nothing done'); return report; }
  const paths = options.paths ?? providerPaths();
  await step('Claude', log, undefined, () => cleanClaude(options, paths, report));
  await step('Codex', log, undefined, () => cleanCodex(options, paths, report));
  return report;
}

/** Version parts of an `anthropic.claude-code-<version>[-<platform>]` folder, for "newest". */
function claudeExtensionVersion(name: string): number[] | undefined {
  const match = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/i.exec(name);
  return match ? match.slice(1, 4).map(Number) : undefined;
}
/**
 * The Claude CLI, found the way claudeExecutable.ts finds it minus the editor:
 * PATH, then the native binary bundled in the newest Claude Code extension
 * installed into Hydra.
 */
export async function findClaudeCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const onPath = await findProvider('claude').catch(() => undefined);
  if (onPath?.executable) return onPath.executable;
  const extensions = path.join(env.USERPROFILE || homedir(), '.hydra', 'extensions');
  const folders = (await readdir(extensions).catch(() => [] as string[]))
    .map(name => ({ name, version: claudeExtensionVersion(name) }))
    .filter((entry): entry is { name: string; version: number[] } => !!entry.version)
    .sort((a, b) => b.version[0]! - a.version[0]! || b.version[1]! - a.version[1]! || b.version[2]! - a.version[2]! || b.name.localeCompare(a.name));
  for (const { name } of folders) {
    const binary = path.join(extensions, name, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude');
    const found = await realpath(binary).catch(() => undefined);
    if (found) return found;
  }
  return undefined;
}

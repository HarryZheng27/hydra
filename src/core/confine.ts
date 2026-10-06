import path from 'node:path';
import type { Provider } from './model';

/**
 * Confining heads, and light limits for lanes (Step 2). Pure: every
 * function here builds a value from typed inputs, so the tests can check each one exactly.
 *
 * - Claude heads get a settings file (`--settings`) that blocks reads outside their working
 *   folders and denies Read and Edit on Hydra's data, the other worktrees, the lead's `.hydra`
 *   and `.git`, and the usual places secrets live (research R1), and turns your plugins off.
 * - Their tools are an explicit list (`--tools`), writes are allowed only inside the worktree
 *   (`Edit(/**)`), PowerShell is never given, and Bash only runs through Codex's Windows sandbox
 *   (R5), by way of the wrapper scripts below.
 * - Heads and gate commands get an allowlisted environment (R3).
 * - Claude lanes get only the deny pairs for Hydra's data and the other worktrees.
 *
 * Claude Code silently ignores a whole settings file when one value in it is invalid (R1), so
 * these files are only ever built here, and checked by `settingsProblems` before they're written.
 */

// ---- Paths in Claude Code's Read and Edit rules ----

const sameCase = (platform: NodeJS.Platform) => (value: string) => platform === 'win32' ? value.toLowerCase() : value;
const pathApi = (platform: NodeJS.Platform) => platform === 'win32' ? path.win32 : path.posix;

/**
 * An absolute path as a Read/Edit rule spells it (R1): `//c/Users/me/.ssh` on Windows, where
 * Claude Code turns `C:\Users\me` into `/c/Users/me` before matching, and `//home/me/.ssh`
 * elsewhere. Undefined when it can't be spelled that way: a relative or UNC path, or a drive or
 * top-level folder, which a rule must never cover. A Git Bash `/c/Users/me` (a HOME set by Git
 * Bash) is read as `C:\Users\me`. Characters the rules read as patterns (`[`, `]`, and on other
 * platforms `*`, `?` and `\`) become `?`, one character of any kind: that only widens a deny.
 */
export function rulePath(value: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (platform === 'win32') {
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(value);
    const windows = msys ? `${msys[1]}:${(msys[2] ?? '/').replace(/\//g, '\\')}` : value;
    if (!/^[a-zA-Z]:[\\/]/.test(windows)) return undefined;
    const clean = path.win32.normalize(windows).replace(/[\\/]+$/, '');
    const segments = clean.slice(2).split('\\').filter(Boolean);
    if (segments.length < 2) return undefined;
    return `//${clean[0]!.toLowerCase()}/${segments.join('/').replace(/[[\]]/g, '?')}`;
  }
  if (!value.startsWith('/')) return undefined;
  const segments = path.posix.normalize(value).split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  return `//${segments.join('/').replace(/[[\]*?\\]/g, '?')}`;
}

/** A folder and everything in it (`…/**`), or one file. */
export interface DenyTarget { path: string; dir: boolean }
/** Read and Edit rules for these targets, in order, without repeats. A target that can't be spelled as a rule is skipped. */
export function denyPairs(targets: readonly DenyTarget[], platform: NodeJS.Platform, kinds: readonly ('Read' | 'Edit')[] = ['Read', 'Edit']): string[] {
  const rules: string[] = [];
  for (const target of targets) {
    const spelled = rulePath(target.path, platform);
    if (!spelled) continue;
    for (const kind of kinds) rules.push(`${kind}(${spelled}${target.dir ? '/**' : ''})`);
  }
  return [...new Set(rules)];
}

// ---- Hydra's global storage, minus what a role must read ----

/** The entries of each folder on the way to the kept paths, as `storageListing` reads them. */
export type StorageListing = ReadonlyMap<string, readonly { name: string; dir: boolean }[]>;

/**
 * What in Hydra's global storage gets a Read deny: everything but `keep` (a role's checked pack
 * copy and its plugin folder), which the head reads through `--add-dir` and which a Read deny on a
 * parent would beat (R1). A rule can't say "except", so each folder on the way down to a kept path
 * is denied entry by entry. With nothing to keep, or when a folder on the way couldn't be listed,
 * the whole storage folder is denied: a role's files are then unreadable, which is safe.
 */
export function storageReadDeny(storage: string, keep: readonly string[], listing: StorageListing, platform: NodeJS.Platform = process.platform): DenyTarget[] {
  const api = pathApi(platform), key = sameCase(platform);
  const inside = (parent: string, child: string) => { const relative = api.relative(parent, child); return !!relative && !relative.startsWith('..') && !api.isAbsolute(relative); };
  const kept = keep.map(item => api.resolve(item)).filter(item => inside(storage, item));
  if (!kept.length) return [{ path: storage, dir: true }];
  const lookup = new Map([...listing].map(([folder, entries]) => [key(api.resolve(folder)), entries]));
  const denied: DenyTarget[] = [];
  const visit = (folder: string): boolean => {
    const entries = lookup.get(key(api.resolve(folder)));
    if (!entries) return false;
    for (const entry of entries) {
      const full = api.join(folder, entry.name);
      if (kept.some(item => key(item) === key(full))) continue;
      if (entry.dir && kept.some(item => inside(full, item))) { if (!visit(full)) return false; continue; }
      denied.push({ path: full, dir: entry.dir });
    }
    return true;
  };
  return visit(storage) ? denied : [{ path: storage, dir: true }];
}

// ---- The settings files ----

/** Where secrets usually live, under each home folder: folders, then files (the design's list). */
export const homeSecretFolders = ['.ssh', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.codex', '.claude', 'AppData/Roaming/gcloud', 'AppData/Roaming/GitHub CLI'] as const;
export const homeSecretFiles = ['.claude.json', '.git-credentials', '.npmrc', '.netrc'] as const;

/** The home folders to deny secrets in: USERPROFILE, and HOME when it's a different folder. */
export function homeFolders(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string[] {
  const read = (name: string) => envValue(env, name, platform);
  const found: string[] = [];
  for (const value of [read('USERPROFILE'), read('HOME')]) {
    const spelled = value ? rulePath(value, platform) : undefined;
    if (value && spelled && !found.some(existing => rulePath(existing, platform)?.toLowerCase() === spelled.toLowerCase())) found.push(value);
  }
  return found;
}

/** The secret folders and files under each home, plus CLAUDE_CONFIG_DIR, CODEX_HOME and %APPDATA%'s copies when they live elsewhere. */
export function secretTargets(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): DenyTarget[] {
  const api = pathApi(platform);
  const posix = (home: string) => platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(home) ? `${home[1]}:${home.slice(2).replace(/\//g, '\\') || '\\'}` : home;
  const targets: DenyTarget[] = [];
  for (const home of homeFolders(env, platform).map(posix)) {
    for (const folder of homeSecretFolders) targets.push({ path: api.join(home, ...folder.split('/')), dir: true });
    for (const file of homeSecretFiles) targets.push({ path: api.join(home, file), dir: false });
  }
  const appData = envValue(env, 'APPDATA', platform);
  if (platform === 'win32' && appData) for (const folder of ['gcloud', 'GitHub CLI']) targets.push({ path: api.join(appData, folder), dir: true });
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) { const value = envValue(env, name, platform); if (value) targets.push({ path: value, dir: true }); }
  return targets;
}

export interface ClaudeSettings {
  disableAllHooks?: true; permissions: { blockReadsOutsideWorkingDirectories?: true; deny: string[] }; enabledPlugins?: Record<string, false>;
  syncClaudeAiSkills?: false; syncClaudeAiPlugins?: false; disableClaudeAiConnectors?: true;
}

/**
 * HSEC-71 (#277 follow-up): what your claude.ai account syncs into Claude Code stays out of heads and reviewers. In a
 * `--settings` file, the two sync switches block and hide your claude.ai skills and plugins for that one run only
 * (nothing of yours is moved or deleted), and no claude.ai connector is fetched. Every supported Claude Code (2.1.270
 * and up) defines all three as booleans with this same `--settings` meaning, so none of them can void the file's deny
 * rules (R1); checked in the 2.1.270 and 2.1.282 binaries, 2026-10-02.
 */
export const claudeAiSyncOff = Object.freeze({ syncClaudeAiSkills: false, syncClaudeAiPlugins: false, disableClaudeAiConnectors: true } as const);

/**
 * A plugin id as `enabledPlugins` spells it, `name@marketplace`. Anything else is left out: one
 * odd key could make Claude Code drop the whole settings file, deny rules and all (R1).
 */
export const pluginIdForm = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The plugins your user settings could turn on for a head, from the text of your Claude
 * `settings.json` (its `enabledPlugins` keys) and `plugins/installed_plugins.json` (every installed
 * plugin). Missing or malformed text adds none. Sorted, so the same files give the same list.
 */
export function userPluginIds(settingsText: string | undefined, installedText: string | undefined): string[] {
  const keys = (text: string | undefined, pick: (value: Record<string, unknown>) => unknown) => {
    try {
      const found = pick(JSON.parse((text ?? '').replace(/^﻿/, '')) as Record<string, unknown>);
      return found && typeof found === 'object' && !Array.isArray(found) ? Object.keys(found) : [];
    } catch { return []; }
  };
  const ids = [...keys(settingsText, value => value?.enabledPlugins), ...keys(installedText, value => value?.plugins)];
  return [...new Set(ids.filter(id => pluginIdForm.test(id)))].sort();
}

export interface HeadSettingsInput {
  platform: NodeJS.Platform;
  /** Hydra's environment: its home folders and sign-in folders are denied. */
  env: Readonly<Record<string, string | undefined>>;
  /** Hydra's global storage folder. */
  storage: string;
  /** What in it the head reads (storageReadDeny's result for its role's pack copy). */
  storageRead: readonly DenyTarget[];
  /** The head's own worktree, and the folders it reads with `--add-dir`: no Read rule may cover them. */
  worktree: string;
  addDirs: readonly string[];
  /** Every other worktree of the repository: other heads' and lanes'. */
  otherWorktrees: readonly string[];
  /** The main checkout, whose `.hydra` and `.git` are denied. */
  leadFolder: string;
  /** Your plugins (userPluginIds): each is turned off for the head. */
  userPlugins?: readonly string[];
}

/**
 * A Claude head's `--settings` file (design 1): reads outside its working folders are blocked
 * whatever the spelling (R1: 8.3 names, `\\?\` and UNC spellings otherwise got through), and Read
 * and Edit are denied on Hydra's data (reads as storageReadDeny says; edits on all of it, the pack
 * copy included), the other worktrees, the lead's `.hydra` and `.git`, and the secret folders.
 * Your plugins are turned off (`enabledPlugins`, which beats your user settings): a head can't use
 * their tools, and each of their hooks would run through the shell sandbox's wrapper, which made
 * every head command take a minute or more.
 * Every hook is off (`disableAllHooks`, HSEC-71): your settings' own hooks don't run for a head.
 * A role's `--plugin-dir` plugin isn't listed, so it still loads.
 * Throws when the result isn't a file Claude Code would accept, or when a Read rule would cover the
 * head's own worktree or its `--add-dir` folders: then the head doesn't start.
 */
export function headSettings(input: HeadSettingsInput): ClaudeSettings {
  const api = pathApi(input.platform);
  const deny = [...new Set([
    ...denyPairs(input.storageRead, input.platform, ['Read']),
    ...denyPairs([{ path: input.storage, dir: true }], input.platform, ['Edit']),
    ...denyPairs(input.otherWorktrees.map(item => ({ path: item, dir: true })), input.platform),
    ...denyPairs([{ path: api.join(input.leadFolder, '.hydra'), dir: true }, { path: api.join(input.leadFolder, '.git'), dir: true }], input.platform),
    // HSEC-09: the worktree's own .git file says where git finds its metadata; a head that rewrote it could have
    // Hydra's git calls read a config of its making. It reads it freely (git tools do), but never edits it.
    ...denyPairs([{ path: api.join(input.worktree, '.git'), dir: false }, { path: api.join(input.worktree, '.git'), dir: true }], input.platform, ['Edit']),
    ...denyPairs(secretTargets(input.env, input.platform), input.platform),
  ])];
  const plugins = [...new Set(input.userPlugins ?? [])].filter(id => pluginIdForm.test(id)).sort();
  const settings: ClaudeSettings = { disableAllHooks: true, ...claudeAiSyncOff, permissions: { blockReadsOutsideWorkingDirectories: true, deny } };
  if (plugins.length) settings.enabledPlugins = Object.fromEntries(plugins.map(id => [id, false] as const));
  const problems = settingsProblems(settings, { platform: input.platform, blockReads: true, readable: [input.worktree, ...input.addDirs] });
  if (problems.length) throw new Error(`Hydra couldn't build the head's permission settings: ${problems[0]}`);
  return settings;
}

export interface LaneSettingsInput {
  platform: NodeJS.Platform;
  storage: string;
  /** What in it the lane reads (storageReadDeny's result for its role's pack copy). */
  storageRead: readonly DenyTarget[];
  worktree: string;
  /** Folders the lane's role reads (its pack copy and plugin folder): no Read rule may cover them. */
  readable: readonly string[];
  otherWorktrees: readonly string[];
}

/**
 * A Claude lane's `--settings` file (design 6): only Read and Edit denies for Hydra's data (minus
 * the lane's own pack copy for reads) and the other worktrees. Your own settings, mode and shells
 * are untouched, so this adds no `blockReadsOutsideWorkingDirectories`.
 */
export function laneSettings(input: LaneSettingsInput): ClaudeSettings {
  const deny = [...new Set([
    ...denyPairs(input.storageRead, input.platform, ['Read']),
    ...denyPairs([{ path: input.storage, dir: true }], input.platform, ['Edit']),
    ...denyPairs(input.otherWorktrees.map(item => ({ path: item, dir: true })), input.platform),
  ])];
  const settings: ClaudeSettings = { permissions: { deny } };
  const problems = settingsProblems(settings, { platform: input.platform, blockReads: false, readable: [input.worktree, ...input.readable] });
  if (problems.length) throw new Error(`Hydra couldn't build the lane's permission settings: ${problems[0]}`);
  return settings;
}

/**
 * Everything wrong with a settings file Hydra is about to write, in words; empty when it's good.
 * Only the keys Hydra means to write are allowed, with exactly the right types, and every rule
 * must be a Read or Edit rule on an absolute `//…` path in the form R1 showed works. `readable`
 * lists folders no Read rule may cover (the worktree, a role's pack copy). A head's
 * `enabledPlugins` may only turn plugins off, and its hooks must be off (`disableAllHooks`); a lane
 * keeps your plugins and hooks.
 */
export function settingsProblems(value: unknown, options: { platform: NodeJS.Platform; blockReads: boolean; readable?: readonly string[] }): string[] {
  const problems: string[] = [];
  const plain = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) === Object.prototype;
  if (!plain(value)) return ['the settings must be an object'];
  const syncKeys = Object.keys(claudeAiSyncOff) as (keyof typeof claudeAiSyncOff)[];
  for (const key of Object.keys(value)) if (key !== 'permissions' && key !== 'enabledPlugins' && key !== 'disableAllHooks' && !(syncKeys as string[]).includes(key)) problems.push(`unknown setting "${key}"`);
  // A head's claude.ai skills, plugins and connectors are off; a lane keeps your own.
  for (const key of syncKeys) {
    if (!options.blockReads) { if (key in value) problems.push('a lane keeps your own claude.ai skills, plugins and connectors'); }
    else if (value[key] !== claudeAiSyncOff[key]) problems.push(`a head's ${key} must be ${claudeAiSyncOff[key]}`);
  }
  if (options.blockReads ? value.disableAllHooks !== true : 'disableAllHooks' in value) problems.push(options.blockReads ? 'a head\'s hooks must be off' : 'a lane keeps your own hooks');
  if ('enabledPlugins' in value) {
    const plugins = value.enabledPlugins;
    if (!options.blockReads) problems.push('a lane keeps your own plugins');
    else if (!plain(plugins) || !Object.keys(plugins).length) problems.push('enabledPlugins must be a non-empty object');
    else for (const [id, on] of Object.entries(plugins)) if (!pluginIdForm.test(id) || on !== false) problems.push(`the plugin setting ${JSON.stringify(id)} doesn't turn a plugin off`);
  }
  const permissions = value.permissions;
  if (!plain(permissions)) return [...problems, 'permissions must be an object'];
  for (const key of Object.keys(permissions)) if (key !== 'deny' && key !== 'blockReadsOutsideWorkingDirectories') problems.push(`unknown permission setting "${key}"`);
  if (options.blockReads ? permissions.blockReadsOutsideWorkingDirectories !== true : 'blockReadsOutsideWorkingDirectories' in permissions) problems.push(options.blockReads ? 'reads outside the worktree must be blocked' : 'a lane keeps your own read settings');
  const deny = permissions.deny;
  if (!Array.isArray(deny) || !deny.length) return [...problems, 'deny must be a non-empty list'];
  // `//c/Users/me/.ssh/**` on Windows (a lower-case drive, then at least two segments), `//home/me/.ssh/**` elsewhere;
  // `?` may stand for a character rulePath replaced, and `/**` may only end the rule.
  const segment = options.platform === 'win32' ? String.raw`[^/\\[\]*:"<>|\u0000-\u001f\u007f]+` : String.raw`[^/\\[\]*\u0000-\u001f\u007f]+`;
  const form = new RegExp(`^(Read|Edit)\\(//${options.platform === 'win32' ? '[a-z]/' : ''}${segment}(/${segment})+(/\\*\\*)?\\)$`);
  const seen = new Set<string>();
  for (const rule of deny) {
    if (typeof rule !== 'string' || !form.test(rule)) { problems.push(`the rule ${JSON.stringify(rule)} isn't a Read or Edit rule on an absolute path`); continue; }
    if (seen.has(rule)) problems.push(`the rule ${rule} is listed twice`);
    seen.add(rule);
  }
  for (const folder of options.readable ?? []) {
    const spelled = rulePath(folder, options.platform);
    if (!spelled) { problems.push(`${folder} can't be spelled as a rule path`); continue; }
    const covering = deny.find(rule => typeof rule === 'string' && rule.startsWith('Read(') && ruleCovers(rule, spelled, options.platform));
    if (covering) problems.push(`${covering} would stop it reading ${folder}`);
  }
  return problems;
}

/** Whether a `Read(//…)` or `Read(//…/**)` rule covers this rule path or anything inside it, reading `?` as any one character. */
export function ruleCovers(rule: string, target: string, platform: NodeJS.Platform): boolean {
  const body = /^\w+\((.*)\)$/.exec(rule)?.[1];
  if (!body) return false;
  const base = body.replace(/\/\*\*$/, '');
  const pattern = new RegExp(`^${base.split('').map(char => char === '?' ? '[^/]' : char.replace(/[.*+^${}()|[\]\\]/g, '\\$&')).join('')}(/.*)?$`, platform === 'win32' ? 'i' : '');
  // A rule on a parent covers the target; so does a rule on a folder inside it, which would hide part of what it must read.
  return pattern.test(target) || new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, platform === 'win32' ? 'i' : '').test(base);
}

// ---- Tools ----

/** A Claude head's built-in tools (design 1). MultiEdit, LS and TodoWrite no longer exist (R5). */
export const claudeHeadBuiltins = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'] as const;
/** Hydra's own tools for a head. */
export const hydraHeadTools = ['mcp__hydra__hydra_done', 'mcp__hydra__hydra_stuck', 'mcp__hydra__hydra_progress'] as const;
/** Built-in tools a pack role may add (roleLaunch's allowedTools): its skills and the web. */
const roleBuiltins = new Set(['Skill', 'WebFetch', 'WebSearch']);
const roleTool = /^(Skill|WebFetch|WebSearch|mcp__[A-Za-z0-9_-]+)$/;

/**
 * `--tools` (what exists at all: `--allowedTools` alone left 32 tools, R5) and `--allowedTools`
 * (what runs without asking under dontAsk). Writes are allowed only inside the worktree:
 * `Edit(/**)`, `Write(/**)` and `NotebookEdit(/**)`, with no bare Edit or Write (R1). Reads inside
 * the working folders need no rule. PowerShell is never given: nothing confines it (R5). Bash only
 * when it runs through Codex's sandbox (or on a platform with no such sandbox, as before).
 */
export function claudeHeadTools(shell: boolean, roleAllowed: readonly string[] = []): { tools: string[]; allowed: string[] } {
  const role = roleAllowed.filter(tool => roleTool.test(tool));
  const tools = [...new Set([...claudeHeadBuiltins, ...(shell ? ['Bash'] : []), ...role.filter(tool => roleBuiltins.has(tool))])];
  const allowed = [...new Set(['Glob', 'Grep', 'Edit(/**)', 'Write(/**)', 'NotebookEdit(/**)', ...(shell ? ['Bash'] : []), ...hydraHeadTools, ...role])];
  if ([...tools, ...allowed].some(tool => /powershell/i.test(tool))) throw new Error('A head is never given PowerShell.');
  return { tools, allowed };
}

// ---- The environment (R3, design 4) ----

const systemVariables = ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'COMPUTERNAME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'PSModulePath'];
const localeVariables = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const toolchainVariables = ['JAVA_HOME', 'GOROOT', 'GOPATH', 'CARGO_HOME', 'RUSTUP_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'PNPM_HOME', 'VOLTA_HOME', 'BUN_INSTALL', 'DOTNET_ROOT', 'ANDROID_HOME', 'CLAUDE_CODE_GIT_BASH_PATH'];
/** The allowlist every head and gate command starts from, when each is set. */
export const allowedVariables: readonly string[] = [...systemVariables, ...localeVariables, ...proxyVariables, ...toolchainVariables];
/** Each provider's sign-in variables, passed only to its own heads. */
export const signInVariables: Readonly<Record<Provider, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
};
const secretName = /TOKEN|SECRET|PASSW|API_?KEY|CREDENTIAL|PRIVATE|SESSION|COOKIE/i;
/**
 * Never passed, even when listed: an agent or ssh socket, the editor's and a parent Claude Code
 * session's markers, and CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which forces permission mode "default"
 * so a head would hang (R3). HYDRA_SHELL_DIRECT is how Hydra's own MCP servers skip the sandbox,
 * so only Hydra sets it, in those servers' own environment.
 */
const neverPassed = /^(SSH_AUTH_SOCK|GIT_ASKPASS|CLAUDECODE|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB|HYDRA_SHELL_DIRECT)$|^(ELECTRON_|VSCODE_|CURSOR_|CLAUDE_CODE_)/i;

/** A variable by name; on Windows, whatever the case of its name. */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
/** Set a variable, replacing any other spelling of its name on Windows, where names ignore case. */
function setVariable(target: Record<string, string>, name: string, value: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') for (const key of Object.keys(target)) if (key.toUpperCase() === name.toUpperCase()) delete target[key];
  target[name] = value;
}

export interface ConfinedEnvironmentInput {
  /** Hydra's own environment. */
  base: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** A head's provider: its sign-in variables pass. None for a gate command. */
  provider?: Provider;
  /** Variables a pack role's servers read by name (`${NAME}`): passed from Hydra's environment even when they look like secrets, since you allowed the pack. */
  roleNames?: readonly string[];
  /** What Hydra sets last: a role's values for its Codex servers, TEMP, TMP and the rest. Never filtered. */
  set?: Readonly<Record<string, string>>;
}

/**
 * The environment of a head or a gate command (design 4): each allowlisted variable Hydra itself
 * has, the provider's sign-in variables, the role's variables, then what Hydra sets. Secret-looking
 * names are removed unless they're sign-in or role variables; the never-passed names always are.
 * Node adds back a few Windows variables (SystemRoot, TEMP and the like) when they're missing,
 * which is fine: none is a secret.
 */
export function confinedEnvironment(input: ConfinedEnvironmentInput): Record<string, string> {
  const upper = (name: string) => input.platform === 'win32' ? name.toUpperCase() : name;
  const signIn = new Set((input.provider ? signInVariables[input.provider] : []).map(upper));
  const role = new Set((input.roleNames ?? []).map(upper));
  const wanted = new Set([...allowedVariables, ...signIn, ...role].map(upper));
  const exempt = new Set([...signIn, upper('CLAUDE_CODE_GIT_BASH_PATH')]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (typeof value !== 'string' || !wanted.has(upper(key))) continue;
    if (neverPassed.test(key) && !exempt.has(upper(key))) continue;
    if (secretName.test(key) && !signIn.has(upper(key)) && !role.has(upper(key))) continue;
    setVariable(env, key, value, input.platform);
  }
  for (const [key, value] of Object.entries(input.set ?? {})) setVariable(env, key, value, input.platform);
  return env;
}

export interface HeadEnvironmentInput {
  base: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  provider: Provider;
  /** The head's own TEMP and TMP, under Hydra's storage: Codex's sandbox makes TEMP writable, so it must not be the shared one (R4). */
  temp: string;
  worktree: string;
  /** How a Claude head's shell runs. */
  shell?: HeadShell;
  /** A role's variables (RoleLaunch.variables) and its values for Codex servers (RoleLaunch.env). */
  roleNames?: readonly string[];
  roleValues?: Readonly<Record<string, string>>;
  /** A Codex head's own CODEX_HOME (agentHome.ts), when Hydra could make one (HSEC-71). */
  codexHome?: string;
}

/**
 * A head's whole environment. Background tasks stay off: a head that started a long command in the
 * background and ended its turn to wait for it stopped without calling hydra_done, since a `-p`
 * session ends with its turn (Step 1 live checks). With a sandboxed shell, Claude Code runs each
 * Bash command through the wrapper (CLAUDE_CODE_SHELL_PREFIX) with the worktree as the sandbox's
 * root (HYDRA_WT), and Git's `bin` comes first on PATH, since the `bash` that starts Hydra's own
 * servers through the wrapper is looked up there.
 */
export function headEnvironment(input: HeadEnvironmentInput): Record<string, string> {
  const set: Record<string, string> = { ...input.roleValues, TEMP: input.temp, TMP: input.temp, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
  if (input.provider === 'claude') Object.assign(set, claudeIsolationVariables);
  if (input.provider === 'codex' && input.codexHome) set.CODEX_HOME = input.codexHome;
  if (input.provider === 'claude' && input.shell?.kind === 'sandboxed') {
    Object.assign(set, { CLAUDE_CODE_SHELL_PREFIX: input.shell.wrapper, HYDRA_WT: input.worktree, PATH: [input.shell.gitBin, envValue(input.base, 'PATH', input.platform)].filter(Boolean).join(';') });
  }
  return confinedEnvironment({ base: input.base, platform: input.platform, provider: input.provider, roleNames: input.roleNames ?? [], set });
}

// ---- Your own agent configuration stays out of heads and reviewers (HSEC-71) ----

/**
 * What a Claude head or reviewer gets so none of your own instructions reach it: no CLAUDE.md
 * (your `~/.claude/CLAUDE.md` and rules; a head never loaded the project's, since only user
 * settings load) and no auto memory. Claude Code reads both variables itself (2.1.282); your
 * sign-in, model and permission settings still load.
 */
export const claudeIsolationVariables: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

/**
 * Codex features that are on by default and reach past the task: your connected apps, plugins
 * (the bundled ones too), hooks, memories, the browser and computer use, and suggestions to install
 * more tools. Each is turned off for heads and reviewers. Names from `codex features list` (0.157.1).
 */
export const codexDisabledFeatures = ['apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'tool_suggest', 'skill_mcp_dependency_install'] as const;

/** The few settings of your Codex config.toml a head or reviewer keeps: which model, how hard it thinks, and the Windows sandbox mode. */
export interface CodexCarry { model?: string; model_reasoning_effort?: string; service_tier?: string; windowsSandbox?: string }

/**
 * Your model, effort, service tier and Windows sandbox mode, read from your Codex config.toml's
 * text. Only a plain `key = "value"` line counts (top level, or `sandbox` under `[windows]`), and
 * only a value of letters, digits, `.`, `_` and `-`: anything else is left out rather than
 * passed on. Nothing else of the file (servers, plugins, hooks, instructions, profiles) is read.
 */
export function codexCarry(configText: string | undefined): CodexCarry {
  const carry: CodexCarry = {};
  let table = '';
  for (const raw of (configText ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]*?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) { table = header[1]!; continue; }
    if (line.startsWith('[[')) { table = '(array)'; continue; }
    const pair = /^([A-Za-z_]+)\s*=\s*(?:"([A-Za-z0-9._-]+)"|'([A-Za-z0-9._-]+)')\s*(#.*)?$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!, value = (pair[2] ?? pair[3])!;
    if (table === '' && (key === 'model' || key === 'model_reasoning_effort' || key === 'service_tier')) carry[key] = value;
    if (table === 'windows' && key === 'sandbox') carry.windowsSandbox = value;
  }
  return carry;
}

/**
 * The flags that keep a Codex head or reviewer to your sign-in: `--ignore-user-config` (no
 * config.toml, so none of your MCP servers, Hydra's own lead entry included, plugins, hooks,
 * memories, notify command or profiles), each default-on feature above off, no skills listing,
 * then what codexCarry kept. With Hydra's own CODEX_HOME (agentHome.ts) your AGENTS.md and skills
 * aren't there either. Every value passes through a Windows `.cmd` shim unchanged.
 */
export function codexIsolationArguments(carry: CodexCarry): string[] {
  const safe = (value: string | undefined) => value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  const kept = ([['model', carry.model], ['model_reasoning_effort', carry.model_reasoning_effort], ['service_tier', carry.service_tier], ['windows.sandbox', carry.windowsSandbox]] as const)
    .filter(([, value]) => safe(value)).flatMap(([key, value]) => ['-c', `${key}='${value}'`]);
  return ['--ignore-user-config', ...codexDisabledFeatures.flatMap(feature => ['-c', `features.${feature}=false`]), '-c', 'skills.include_instructions=false', ...kept];
}

// ---- The shell: Codex's Windows sandbox around each Bash command (R5, design 1, 5 and 7) ----

/**
 * How a Claude head's Bash runs:
 * - `sandboxed`: through Hydra's wrapper, in Codex's Windows sandbox (the self-test passed);
 * - `off`: no shell at all, and why;
 * - `unconfined`: as before Step 2, on a platform where Hydra has no sandbox to put it in.
 */
export type HeadShell =
  | { kind: 'sandboxed'; wrapper: string; gitBin: string }
  | { kind: 'off'; reason: string }
  | { kind: 'unconfined' };

/** The Settings → Heads line. */
export function headShellSentence(shell: HeadShell | undefined): string {
  if (!shell) return 'Head shells are checked when the first head starts.';
  if (shell.kind === 'sandboxed') return 'Head shells run in Codex\'s Windows sandbox.';
  if (shell.kind === 'unconfined') return 'Head shells run without a sandbox: Codex\'s sandbox is only used on Windows.';
  return `Head shells are off: ${shell.reason}.`;
}

/** The window's one warning when a Claude head starts without a shell: what it can't do, and why. */
export function headShellOffNotice(reason: string): string {
  return `A Claude Code head started without a shell, so it can't run tests or builds itself (Hydra's gates still run them): ${reason}.`;
}

/** A word for bash, in single quotes. */
export const bashQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The name of the Codex permission profile the wrapper passes with `-c`, unlikely to meet one of yours. */
export const sandboxProfile = 'hydra-confine';
/**
 * The profile (R4, R5): Codex's `:workspace` (the worktree and TEMP/TMP writable, everything else
 * read-only), the network on, and the worktree's `.claude` and `.hydra` read-only. No deny entries:
 * each becomes a lasting access-list entry for every Codex sandbox on the machine (R4).
 */
export const sandboxProfileToml = `{ extends = ':workspace', network = { enabled = true }, filesystem = { ':workspace_roots' = { '.claude' = 'read', '.hydra' = 'read' } } }`;
/**
 * `codex sandbox` builds the command's environment from Codex's `shell_environment_policy`, your
 * config.toml's included (seen live: its `set` values arrived, and PORT and JAVA_HOME didn't). The
 * environment Hydra built (allowlisted) passes whole instead, still without the names Codex always
 * leaves out (`*KEY*`, `*SECRET*`, `*TOKEN*`), so a head's shell never sees a sign-in key.
 */
export const sandboxEnvironmentPolicy = ["shell_environment_policy.inherit='all'", 'shell_environment_policy.ignore_default_excludes=false', 'shell_environment_policy.exclude=[]', 'shell_environment_policy.include_only=[]', 'shell_environment_policy.set={}'] as const;

export interface WrapperScriptInput {
  /** Codex's own executable (not its npm `.cmd` shim). */
  codex: string;
  /** Git's `usr\bin\bash.exe`, which runs the command inside the sandbox. */
  bash: string;
  /** The inside, guard and process-tree scripts, written beside the wrapper. */
  inside: string;
  guard: string;
  tree: string;
  powershell: string;
}

/**
 * The wrapper (`CLAUDE_CODE_SHELL_PREFIX`). Claude Code runs each Bash command of a head, each hook,
 * and each stdio MCP server as `<wrapper> '<command line>'`, the MCP servers through cross-spawn,
 * which starts `bash` from the head's PATH (so Hydra puts Git's `bin` first).
 *
 * - Hydra's own MCP servers (its bridge, a role's servers) carry HYDRA_SHELL_DIRECT=1 in their own
 *   environment and run as they would without a prefix. Only Hydra sets it: a Bash command controls
 *   its command line, never the wrapper's environment. Everything else, whatever its command line
 *   says, runs in the sandbox. (The research's prototype told them apart by `eval '` on the command
 *   line, which a command containing a single quote avoids: Claude Code quotes it with double quotes.)
 * - It fails closed: without Codex, or without a worktree, nothing runs.
 * - Git Bash's path conversion is off for Codex's own arguments; the command itself gets it back.
 */
export function wrapperScript(input: WrapperScriptInput): string {
  return [
    '#!/bin/bash',
    '# Hydra\'s shell for Claude heads (Step 2). Hydra writes this file; edits are replaced.',
    '# Claude Code runs each Bash command, hook and stdio MCP server of a head as: <this file> \'<command line>\'.',
    'if [ "${HYDRA_SHELL_DIRECT:-}" = 1 ]; then',
    '  # One of Hydra\'s own MCP servers: only Hydra sets this variable, in those servers\' own environment.',
    '  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL=\'*\'',
    '  exec "$BASH" -c "$1"',
    'fi',
    `codex=${bashQuote(input.codex)}`,
    `inside_bash=${bashQuote(input.bash)}`,
    `inside=${bashQuote(input.inside)}`,
    `guard=${bashQuote(input.guard)}`,
    `tree=${bashQuote(input.tree)}`,
    `powershell=${bashQuote(input.powershell)}`,
    '# Fail closed: without Codex\'s sandbox or a worktree, nothing runs.',
    'if [ ! -f "$codex" ]; then echo "Hydra: this head\'s shell runs in Codex\'s Windows sandbox, and Codex is missing ($codex), so the command didn\'t run." >&2; exit 126; fi',
    'if [ -z "${HYDRA_WT:-}" ] || [ ! -d "$HYDRA_WT" ]; then echo "Hydra: this shell has no worktree, so the command didn\'t run." >&2; exit 126; fi',
    '# The guard inside the sandbox watches this process: when Hydra or Claude Code stops it, the guard ends the command,',
    '# which runs as Codex\'s sandbox user and can\'t be stopped from outside. So this process stays, as Codex\'s parent:',
    '# once it `exec`s a Windows program, its process id no longer shows reliably to the guard.',
    'self=$(cat "/proc/$$/winpid") || exit 126',
    'here=$(pwd -W 2>/dev/null || pwd)',
    'export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL=\'*\'',
    `"$codex" sandbox -c "windows.sandbox='elevated'" -c ${bashQuote(`permissions.${sandboxProfile}=${sandboxProfileToml}`)} ${sandboxEnvironmentPolicy.map(setting => `-c ${bashQuote(setting)}`).join(' ')} -P ${sandboxProfile} -C "$HYDRA_WT" -- "$inside_bash" "$inside" "$1" "$self" "$here" "$guard" "$tree" "$powershell"`,
    'exit $?',
    '',
  ].join('\n');
}

/**
 * Inside the sandbox: back to Git Bash's usual path handling, into the folder Claude Code's shell
 * was in (the sandbox, not the folder, decides what may be written), then the command in its own
 * process group, beside the guard. The guard is started as a program of its own, so it outlives
 * Codex's cleanup of this script's process tree when the wrapper is stopped.
 */
export function insideScript(): string {
  return [
    '# Hydra: runs one command inside Codex\'s sandbox. $1 the command line, $2 the wrapper\'s Windows process id,',
    '# $3 the folder to start in, $4 the guard script, $5 the process-tree script, $6 PowerShell.',
    'unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL',
    '# Git Bash\'s /tmp belongs to whichever sandboxed command started first, maybe another head\'s: TMPDIR keeps this one\'s own.',
    'export TMPDIR="$TEMP"',
    'cd "$3" 2>/dev/null || true',
    'set -m',
    '"$BASH" -c "$1" &',
    'job=$!',
    '"$BASH" "$4" "$job" "$2" "$5" "$6" </dev/null >/dev/null 2>&1 &',
    'guard=$!',
    'wait "$job"',
    'status=$?',
    '# The guard and its sleep, so nothing of this command outlives it.',
    'disown "$guard" 2>/dev/null',
    'kill -9 -- "-$guard" 2>/dev/null',
    'exit "$status"',
    '',
  ].join('\n');
}

/**
 * The guard: every 2 seconds, while the command runs, it checks the wrapper outside the sandbox
 * still exists. When it's gone (a timeout, a cancelled head, a stopped gate), it ends the command's
 * process group and every Windows process under it, found with the process-tree script, since the
 * sandbox's own processes can't be stopped by Hydra or by taskkill from inside.
 */
export function guardScript(): string {
  return [
    '# Hydra: stops a sandboxed command whose wrapper was stopped. $1 its process group, $2 the wrapper\'s Windows process id,',
    '# $3 the process-tree script, $4 PowerShell.',
    'while sleep 2; do',
    '  kill -0 "$1" 2>/dev/null || exit 0',
    '  ps -W | awk -v w="$2" \'$4 == w { found = 1 } END { exit !found }\' && continue',
    '  roots=$(ps -al | awk -v g="$1" \'$3 == g { print $4 }\')',
    '  pids=$(MSYS_NO_PATHCONV=1 "$4" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$3" $roots 2>/dev/null | tr -d \'\\r\')',
    '  kill -9 -- "-$1" 2>/dev/null',
    '  for pid in $pids; do /usr/bin/kill -f -W "$pid" 2>/dev/null; done',
    '  exit 0',
    'done',
    '',
  ].join('\n');
}

/** PowerShell: the given Windows processes and every process under them, from one snapshot of the process list. */
export function treeScript(): string {
  return [
    '# Hydra: prints the given process ids and all their descendants, for the guard.',
    '$source = @\'',
    'using System; using System.Collections.Generic; using System.Runtime.InteropServices;',
    'public static class HydraProcessTree {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  struct Entry { public uint Size, Usage, Id; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe; }',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);',
    '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
    '  public static List<uint> Under(uint[] roots) {',
    '    var parents = new Dictionary<uint, uint>();',
    '    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);',
    '    var entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(typeof(Entry));',
    '    if (Process32FirstW(snapshot, ref entry)) do { parents[entry.Id] = entry.Parent; } while (Process32NextW(snapshot, ref entry));',
    '    CloseHandle(snapshot);',
    '    var found = new List<uint>(roots); bool grew = true;',
    '    while (grew) { grew = false; foreach (var pair in parents) if (pair.Key != 0 && !found.Contains(pair.Key) && found.Contains(pair.Value)) { found.Add(pair.Key); grew = true; } }',
    '    return found;',
    '  }',
    '}',
    '\'@',
    'Add-Type -TypeDefinition $source',
    '$roots = @($args | ForEach-Object { [uint32]$_ })',
    'if ($roots.Count) { [HydraProcessTree]::Under($roots) -join " " }',
    '',
  ].join('\r\n');
}

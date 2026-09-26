import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Integrity checks for npx (and bunx/pnpx) pack servers (docs/Hydra_Improvements.md, 5.4).
 *
 * A pack server run this way can fetch whatever the registry hands it at launch
 * time, so a pack must name an exact version, never a range or a dist-tag, and
 * may pin the npm integrity hash npm itself would check the download against.
 * This module is pure except for `fetchRegistryIntegrity` (network) and
 * `fileCache` (disk); everything else is easy to test with a fake of each.
 */

// ---- Naming the package (pack load time: sync, no network) ----

/** `npx`, `bunx` or `pnpx`, or undefined for any other command. Matches serverDownloads' own detection (format.ts). */
export function npxRunner(command: string): 'npx' | 'bunx' | 'pnpx' | undefined {
  const runner = command.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  return runner === 'npx' || runner === 'bunx' || runner === 'pnpx' ? runner : undefined;
}

/**
 * The package argument npx/bunx/pnpx runs: the first argument that isn't one of
 * the runner's own bootstrap flags. `-y`/`--yes` are skipped; `-p <name>` or
 * `--package=<name>` names the package explicitly (its value, not the command
 * that follows). Any other flag before a package name means none can be read,
 * the same as writing no package at all.
 */
export function npxPackageArg(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '-y' || arg === '--yes') continue;
    if (arg === '-p' || arg === '--package') return args[index + 1];
    const equals = /^--package=(.+)$/.exec(arg);
    if (equals) return equals[1];
    if (arg.startsWith('-')) return undefined;
    return arg;
  }
  return undefined;
}

export interface PackageSpec { name: string; version: string }

/** Strict `MAJOR.MINOR.PATCH`, with an optional prerelease and/or build (semver 2.0's own grammar). */
export const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * `name@version` from an npx-style package argument, scoped names included
 * ("@scope/name@1.2.3"). Undefined for a git/URL/file spec, or anything with
 * no "@" splitting a name from a version (a bare name, or a lone "@scope").
 */
export function parsePackageSpec(text: string): PackageSpec | undefined {
  if (!text || /^(git\+|git:|https?:|file:|\.\.?\/|\/)/.test(text)) return undefined;
  const at = text.lastIndexOf('@');
  if (at <= 0) return undefined;
  const name = text.slice(0, at), version = text.slice(at + 1);
  if (!name || !version) return undefined;
  return { name, version };
}

/**
 * The exact-version rule: a pack server run by npx, bunx or pnpx must name
 * `name@1.2.3`, not a range, a dist-tag, a bare name or a git/URL/file spec.
 * Returns the parsed spec, or undefined when `command` isn't one of those
 * runners (the rule doesn't apply). Throws, naming `label` (the server),
 * otherwise.
 */
export function requireExactVersion(command: string, args: readonly string[], label: string): PackageSpec | undefined {
  if (!npxRunner(command)) return undefined;
  const target = npxPackageArg(args);
  if (!target) throw new Error(`${label} runs with npx/bunx/pnpx but names no package to pin, like "name@1.2.3".`);
  const spec = parsePackageSpec(target);
  if (!spec || !exactVersionPattern.test(spec.version)) throw new Error(`${label}: "${target}" must name an exact version (like "name@1.2.3"), not a range, a tag or a bare name.`);
  return spec;
}

/** An npm integrity hash, as `dist.integrity` in the registry: `sha512-<base64>`. */
export const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/** "sha512-abcdef123456…", for the review panel: the algorithm and the first 12 base64 characters. */
export function shortIntegrity(integrity: string): string {
  const body = integrity.slice('sha512-'.length);
  return `sha512-${body.slice(0, 12)}…`;
}

/** The review panel's line for one server (5.4: "shows the pin"). */
export function pinLabel(pin: PackageSpec | undefined, integrity: string | undefined): string | undefined {
  if (!pin) return undefined;
  return integrity ? `Pinned: ${pin.name}@${pin.version}, integrity ${shortIntegrity(integrity)}` : 'Not pinned to an integrity hash';
}

// ---- Checking a pin against the registry (launch time: async) ----

export type RegistryFetcher = (name: string, version: string) => Promise<string>;

const registryTimeoutMs = 15_000;
/** A response over this many bytes is refused rather than read in full. */
const registryMaxBytes = 1024 * 1024;

/** `@scope/name` → `@scope%2fname` for the registry's URL (a literal "/" after the scope would be a path segment). */
function registryPath(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const slash = name.indexOf('/');
  if (slash < 0) return encodeURIComponent(name);
  return `${encodeURIComponent(name.slice(0, slash))}%2f${encodeURIComponent(name.slice(slash + 1))}`;
}

/**
 * `dist.integrity` for one exact version, from registry.npmjs.org (5.4:
 * "always registry.npmjs.org", no override). A short timeout and a size cap
 * keep a slow or oversized answer from hanging a launch.
 */
export async function fetchRegistryIntegrity(name: string, version: string): Promise<string> {
  const url = `https://registry.npmjs.org/${registryPath(name)}/${encodeURIComponent(version)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), registryTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}@${version}`);
    const length = response.headers.get('content-length');
    if (length && Number(length) > registryMaxBytes) throw new Error(`the registry's answer for ${name}@${version} was too large`);
    const text = await response.text();
    if (text.length > registryMaxBytes) throw new Error(`the registry's answer for ${name}@${version} was too large`);
    const body = JSON.parse(text) as { dist?: { integrity?: unknown } };
    const integrity = body.dist?.integrity;
    if (typeof integrity !== 'string' || !integrity) throw new Error(`the registry has no integrity hash for ${name}@${version}`);
    return integrity;
  } finally {
    clearTimeout(timer);
  }
}

/** name@version → the integrity Hydra last saw match, cached only for matches. */
export interface PinCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, integrity: string): Promise<void>;
}

export const pinCacheKey = (spec: PackageSpec): string => `${spec.name}@${spec.version}`;

/** A JSON file at `<storage>/npx-pin-cache.json`: name@version → integrity, written only for matches. */
export function fileCache(file: string): PinCache {
  let loaded: Record<string, string> | undefined;
  const load = async (): Promise<Record<string, string>> => {
    if (!loaded) { try { loaded = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>; } catch { loaded = {}; } }
    return loaded;
  };
  return {
    async get(key) { return (await load())[key]; },
    async set(key, integrity) {
      const map = await load();
      map[key] = integrity;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(map, null, 2)}\n`);
    },
  };
}

export type NpxPinResult = { ok: true } | { ok: false; reason: string };

/**
 * Before a pinned server first starts: the cache is checked first (so a
 * repeated launch never asks the registry again for the same match), then
 * the registry, comparing its `dist.integrity` against the pin. A mismatch or
 * a fetch failure refuses the server, naming both values (or the error) so
 * the reason is plain in the head's or lane's notes.
 */
export async function checkNpxPin(spec: PackageSpec, integrity: string, fetcher: RegistryFetcher, cache: PinCache): Promise<NpxPinResult> {
  const key = pinCacheKey(spec);
  if (await cache.get(key) === integrity) return { ok: true };
  let actual: string;
  try { actual = await fetcher(spec.name, spec.version); }
  catch (error) { return { ok: false, reason: `Hydra couldn't check ${key} against the npm registry: ${error instanceof Error ? error.message : String(error)}` }; }
  if (actual !== integrity) return { ok: false, reason: `${key} is pinned to ${integrity}, but the npm registry has ${actual}.` };
  await cache.set(key, actual);
  return { ok: true };
}

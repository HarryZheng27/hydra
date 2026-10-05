import { existsSync } from 'node:fs';
import path from 'node:path';

type CliProvider = 'claude' | 'codex';

/**
 * Where the CLIs' own installers put them on Windows: Claude Code's native installer in %USERPROFILE%\.local\bin, and
 * npm's global folder for Codex (and an npm-installed Claude Code). The same places the benchmark looks
 * (scripts/benchmark-lib.mjs).
 */
export function usualCliLocations(provider: CliProvider, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return env.HOME && provider === 'claude' ? [path.posix.join(env.HOME, '.local', 'bin', 'claude')] : [];
  const out: string[] = [];
  if (provider === 'claude' && env.USERPROFILE) out.push(path.win32.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  if (env.APPDATA) out.push(path.win32.join(env.APPDATA, 'npm', `${provider}.cmd`), path.win32.join(env.APPDATA, 'npm', `${provider}.exe`));
  return out;
}

/**
 * The app's PATH with the CLIs' usual install folders added at its end, when a CLI is there and the folder isn't
 * already on PATH. Chats, onboarding, and Hydra's heads, lanes and review gates all look a CLI up on PATH (after the
 * path set in Settings), so an app started with a PATH that lacks the installer's folder (an older shell, a launcher
 * that trims it) still finds the CLI, and the user's own PATH keeps its order and priority.
 */
export function pathWithUsualCliFolders(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): string | undefined {
  const delimiter = platform === 'win32' ? ';' : ':';
  const current = env.PATH ?? env.Path ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  const normalise = (folder: string) => (platform === 'win32' ? folder.replace(/[\\/]+$/, '').toLowerCase() : folder.replace(/\/+$/, ''));
  const seen = new Set(parts.map(normalise));
  const added: string[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    for (const file of usualCliLocations(provider, env, platform)) {
      const folder = platform === 'win32' ? path.win32.dirname(file) : path.posix.dirname(file);
      if (seen.has(normalise(folder)) || !exists(file)) continue;
      seen.add(normalise(folder));
      added.push(folder);
    }
  }
  return added.length ? [...parts, ...added].join(delimiter) : undefined;
}

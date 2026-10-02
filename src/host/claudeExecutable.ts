import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { findProvider } from '../core/providers';

/**
 * The claude CLI Hydra registers with: the configured (`hydra.claudePath`) or PATH claude, else the one bundled in the
 * Claude Code extension at `extensionPath`, when it is installed.
 */
export async function claudeForRegistration(configured: string | undefined, extensionPath: string | undefined): Promise<string | undefined> {
  const info = await findProvider('claude', configured).catch(() => undefined);
  if (info?.executable) return info.executable;
  if (!extensionPath) return undefined;
  const bundled = path.join(extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return await realpath(bundled).catch(() => undefined);
}

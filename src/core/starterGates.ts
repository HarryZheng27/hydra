import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Starter gates (Step A): a project with no `.hydra/gates.json`
 * gets offered a deliberate choice once — "Add a test gate", "No gates for this project", or "Not
 * now" — from the first head acceptance or lane merge in it, and again any time from Settings →
 * Gates. Pure file logic lives here so it's unit tested without vscode; the prompt itself (asking,
 * remembering "asked" per project, and the Settings row) is extension-side.
 */

/** Whether package.json in `root` has a non-empty `scripts.test`, for "Add a test gate"'s label. */
export async function detectTestScript(root: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return typeof parsed.scripts?.test === 'string' && parsed.scripts.test.trim().length > 0;
  } catch { return false; }
}

/**
 * `.hydra/gates.json` for "Add a test gate": one required command gate running `npm test`. `["npm",
 * "test"]` is the same command format every other gate in Hydra uses (docs/Heads.md); Hydra's own
 * command-gate runner finds npm.cmd on Windows through processLaunch, so no platform branch is needed here.
 */
export function starterTestGatesFile(): string {
  return `${JSON.stringify({ gates: [{ id: 'test', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 600 }] }, null, 2)}\n`;
}
/** `.hydra/gates.json` for "No gates for this project": a deliberate empty list (Step A's `none-chosen`, not `none`). */
export function noGatesFile(): string {
  return `${JSON.stringify({ gates: [] }, null, 2)}\n`;
}

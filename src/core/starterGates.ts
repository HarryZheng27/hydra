import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Starter gates (Step A): a project with no `.hydra/gates.json`
 * gets offered a deliberate choice once — "Add a test gate", "No gates for this project", or "Not
 * now" — from the first head acceptance or lane merge in it, and again any time from Settings →
 * Gates. Pure file logic lives here so it's unit tested without vscode; the prompt itself (asking,
 * remembering "asked" per project, and the Settings row) is extension-side.
 */

/**
 * Whether package.json in `root` has a real `scripts.test`, for "Add a test gate"'s label: non-empty, and not npm init's
 * placeholder (`echo "Error: no test specified" && exit 1`), which fails every run and so every head.
 */
export async function detectTestScript(root: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const test = parsed.scripts?.test;
    return typeof test === 'string' && test.trim().length > 0 && !/no test specified/i.test(test);
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
/**
 * The starter-gates offer's buttons. "Add a test gate (npm test)" only when package.json has a test
 * script: without one an `npm test` gate would fail every head, so the offer opens Settings → Gates instead.
 */
export const starterGateChoices = { test: 'Add a test gate (npm test)', settings: 'Set up gates in Settings', none: 'No gates for this project', later: 'Not now' } as const;
export function starterGateActions(hasTestScript: boolean): string[] {
  return [hasTestScript ? starterGateChoices.test : starterGateChoices.settings, starterGateChoices.none, starterGateChoices.later];
}
/** `.hydra/gates.json` for "No gates for this project": a deliberate empty list (Step A's `none-chosen`, not `none`). */
export function noGatesFile(): string {
  return `${JSON.stringify({ gates: [] }, null, 2)}\n`;
}

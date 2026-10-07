import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callHelperEndpoint } from '../../../src/core/helperEndpoint';
import type { HelperRun, HelperRunSpec, StartHelperRun } from '../../../src/core/helperRunner';

/**
 * Stand-in heads for the app's smoke (G5 milestone 3): in place of a provider's CLI, each head writes one file, the
 * `smoke/<name>.txt` its brief names (else `smoke/<its worktree's name>.txt`), and calls hydra_done through its own endpoint, as a head's bridge would. Hydra
 * then runs the project's gates, commits and lands it exactly as for a real head. It never starts a model.
 *
 * Only an unpackaged app started with HYDRA_APP_STANDIN_HEADS=1 uses it (startup.ts); a packaged app never does.
 */
export const startStandinHead: StartHelperRun = (spec: HelperRunSpec): HelperRun => {
  let exit!: (code: number) => void, stopped = false;
  const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
  const turnEnds: (() => void)[] = [];
  const port = Number(spec.bridge.env.HYDRA_HELPER_PORT), token = spec.bridge.env.HYDRA_HELPER_TOKEN ?? '';
  setTimeout(() => void (async () => {
    try {
      const name = /\bsmoke\/([a-z0-9-]+)\.txt\b/.exec(spec.prompt)?.[1] ?? path.basename(spec.worktree);
      await mkdir(path.join(spec.worktree, 'smoke'), { recursive: true });
      await writeFile(path.join(spec.worktree, 'smoke', `${name}.txt`), `Written by a stand-in head in ${path.basename(spec.worktree)}.\n`);
      await callHelperEndpoint(port, token, 'hydra_done', { headline: `Wrote smoke/${name}.txt.`, summary: `Wrote smoke/${name}.txt.` });
      for (const listener of turnEnds) listener();
      exit(0);
    } catch { exit(1); }
  })(), 50);
  return {
    onTurnEnd: listener => { turnEnds.push(listener); },
    exited,
    send: async () => !stopped,
    stop: async () => exit(137),
  };
};

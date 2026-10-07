import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isLaneId } from './core/lanes';
import { applyLaneId, normaliseStopFailure } from './core/limitDetection';
import { attentionDirectory, inWorktreeRoot, normaliseClaudeAttention, normaliseCodexNotify, withLaneId } from './core/attentionEvents';

/**
 * Hydra's one Claude Code hook script, run as
 * `<Hydra executable> dist/hydra-limit-hook.cjs <events folder> [<worktree root>] [--codex <payload>]` with
 * ELECTRON_RUN_AS_NODE=1 (see core/claudeLimitHook.ts). It never blocks or fails
 * the agent: any problem, or 5 seconds passing, ends it quietly with exit code 0.
 * - StopFailure (matcher "rate_limit"): reads the hook's JSON on stdin and drops one usage-limit event file.
 * - Stop and Notification (docs/internal/Needs_You_Plan.md, Phase 4): the same JSON, but they run for every Claude Code
 *   session on the machine, so the script drops an attention event only when the session's cwd is inside Hydra's worktree
 *   root, and exits at once for any other.
 * - `--codex`: Codex's `notify` program, which gets its JSON as the last argument and has no stdin to wait on.
 *
 * Inside a Hydra lane, the lane's own process (laneService.ts) sets HYDRA_LANE_ID
 * in its environment; the hook, a child of that process, inherits it and tags the
 * event with the lane (docs/internal/Gates_Plan.md, section 2).
 */
const maxInput = 256 * 1024;
const quit = () => process.exit(0);
setTimeout(quit, 5000);
process.on('uncaughtException', quit);

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) quit();
const worktreeRoot = process.argv[3] && process.argv[3] !== '--codex' ? process.argv[3] : undefined;
const codexAt = process.argv.indexOf('--codex');
/** Only a lane's own process has a valid HYDRA_LANE_ID (laneService.ts sets it): a lane under a root reached through a link or a short name still counts. */
const inLane = isLaneId(process.env.HYDRA_LANE_ID);

/** Write one event file aside, then rename it into place: a window never reads half a file. */
function drop(folder: string, event: unknown): void {
  mkdirSync(folder, { recursive: true });
  const name = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const temporary = path.join(folder, `${name}.tmp`);
  writeFileSync(temporary, JSON.stringify(event), { encoding: 'utf8', mode: 0o600 });
  try { renameSync(temporary, path.join(folder, `${name}.json`)); } catch { rmSync(temporary, { force: true }); }
}

if (codexAt >= 0) {
  try {
    // Codex appends the payload; the notifier may have been wrapped, so take whatever follows --codex that parses.
    let payload: unknown;
    for (const part of process.argv.slice(codexAt + 1)) { try { payload = JSON.parse(part); break; } catch { /* not the payload */ } }
    const event = normaliseCodexNotify(payload, process.cwd());
    if (event?.cwd && (inWorktreeRoot(event.cwd, worktreeRoot) || inLane)) drop(attentionDirectory(directory!), withLaneId(event, process.env));
  } catch { /* never fail Codex */ }
  quit();
} else {
  const chunks: Buffer[] = [];
  let size = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxInput) quit();
    chunks.push(chunk);
  });
  process.stdin.on('error', quit);
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      const raw = normaliseStopFailure(payload);
      if (raw) drop(directory!, applyLaneId(raw, process.env));
      else {
        const event = normaliseClaudeAttention(payload);
        if (event?.cwd && (inWorktreeRoot(event.cwd, worktreeRoot) || inLane)) drop(attentionDirectory(directory!), withLaneId(event, process.env));
      }
    } catch { /* never fail Claude */ }
    quit();
  });
}

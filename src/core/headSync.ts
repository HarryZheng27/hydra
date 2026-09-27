import { mergeTreeConflicts, snapshotLane } from './laneSync';

/**
 * O2: conflict prediction between running heads (docs/Heads.md, "Coordination"),
 * the same `git merge-tree` approach lanes already use (laneSync.ts): each
 * head's current work (committed, staged, unstaged and untracked) becomes a
 * snapshot commit without touching its real files, and a merge-tree dry run
 * says which pairs would conflict. Heads have no integration branch yet (O3),
 * so this checks running heads against each other only, not against a target.
 * `snapshotLane` and `mergeTreeConflicts` are worktree-generic despite their
 * name: nothing in either is specific to a lane.
 */
export const headSyncIntervalMs = 30_000;
export interface HeadConflict { jobId: string; files: string[] }
interface SyncHead { id: string; worktree: string }

export class HeadSync {
  private pairs = new Map<string, string[]>();

  /** One pass over the given heads' worktrees; `repository` is the lead folder, whose object database every head's worktree shares. */
  async run(repository: string, heads: readonly SyncHead[]): Promise<Map<string, HeadConflict[]>> {
    const results = new Map<string, HeadConflict[]>();
    for (const head of heads) results.set(head.id, []);
    const snapshots = new Map<string, string>();
    for (const head of heads) {
      try { snapshots.set(head.id, (await snapshotLane(head.worktree)).snapshot); }
      catch { /* a worktree mid-removal, or a transient git error: skip it this pass, try again next time */ }
    }
    const usedPairs = new Map<string, string[]>();
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        const a = heads[i]!, b = heads[j]!;
        const snapA = snapshots.get(a.id), snapB = snapshots.get(b.id);
        if (!snapA || !snapB) continue;
        const key = [snapA, snapB].sort().join('|');
        try {
          const files = this.pairs.get(key) ?? await mergeTreeConflicts(repository, snapA, snapB);
          usedPairs.set(key, files);
          if (!files.length) continue;
          results.get(a.id)!.push({ jobId: b.id, files });
          results.get(b.id)!.push({ jobId: a.id, files });
        } catch { /* couldn't check this pair this pass; try again next time */ }
      }
    }
    // Keep only what this pass used, so the cache never outgrows the heads currently running.
    this.pairs = usedPairs;
    return results;
  }
}

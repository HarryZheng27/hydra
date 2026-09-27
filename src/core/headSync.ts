import { mergeTreeConflicts, snapshotLane } from './laneSync';

/**
 * O2: conflict prediction between running heads (docs/Heads.md, "Coordination"),
 * the same `git merge-tree` approach lanes already use (laneSync.ts): each
 * head's current work (committed, staged, unstaged and untracked) becomes a
 * snapshot commit without touching its real files, and a merge-tree dry run
 * says which pairs would conflict. A plan's head is also checked against its
 * plan's integration branch (O3), the tip it has to land on: work that has
 * landed since it started can conflict with it before it's done.
 * `snapshotLane` and `mergeTreeConflicts` are worktree-generic despite their
 * name: nothing in either is specific to a lane.
 */
export const headSyncIntervalMs = 30_000;
export interface HeadConflict { jobId: string; files: string[] }
/** O3: a plan head's predicted conflict with its plan's integration branch. */
export interface IntegrationConflict { branch: string; tip: string; files: string[] }
interface SyncHead { id: string; worktree: string; integration?: { branch: string; tip: string } }
export interface HeadSyncResult { pairs: Map<string, HeadConflict[]>; integration: Map<string, IntegrationConflict> }

export class HeadSync {
  private pairs = new Map<string, string[]>();

  /** One pass over the given heads' worktrees; `repository` is the lead folder, whose object database every head's worktree shares. */
  async run(repository: string, heads: readonly SyncHead[]): Promise<Map<string, HeadConflict[]>> {
    return (await this.runAll(repository, heads)).pairs;
  }

  /** Like run, and also each plan head against its integration branch's tip. */
  async runAll(repository: string, heads: readonly SyncHead[]): Promise<HeadSyncResult> {
    const results = new Map<string, HeadConflict[]>();
    const integration = new Map<string, IntegrationConflict>();
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
    for (const head of heads) {
      const snapshot = snapshots.get(head.id), target = head.integration;
      if (!snapshot || !target) continue;
      const key = `${snapshot}|${target.tip}`;
      try {
        const files = this.pairs.get(key) ?? await mergeTreeConflicts(repository, snapshot, target.tip);
        usedPairs.set(key, files);
        if (files.length) integration.set(head.id, { branch: target.branch, tip: target.tip, files });
      } catch { /* try again next pass */ }
    }
    // Keep only what this pass used, so the cache never outgrows the heads currently running.
    this.pairs = usedPairs;
    return { pairs: results, integration };
  }
}

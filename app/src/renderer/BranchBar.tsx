import { useEffect, useState } from 'react';
import type { BranchSummary } from '../shared/ipc';
import { Icon } from './Icon';

/** The prompt a click on Create PR sends: the chat's own Claude or Codex pushes and opens it, as it would on request. */
export const createPrPrompt = (summary: BranchSummary) =>
  `Create a pull request for the branch ${summary.branch}${summary.base ? ` against ${summary.base.replace(/^origin\//, '')}` : ''}: commit anything uncommitted, push the branch, and open it with gh pr create. Reply with the pull request's link.`;

/**
 * Claude desktop's branch bar above the prompt: the folder's repository and branch, the lines the branch changed
 * against the default branch (+/−), and Create PR. Read again when the chat's turn ends, when it opens, when the window
 * regains focus, and every minute; gone outside git, and once the chat has a pull request (its own bar takes over).
 */
export function BranchBar({ chatId, running, onCreatePr }: { chatId: string; running: boolean; onCreatePr(summary: BranchSummary): void }) {
  const [summary, setSummary] = useState<BranchSummary | null>();
  useEffect(() => {
    let stop = false;
    setSummary(undefined);
    const read = () => { if (document.visibilityState === 'visible') void window.hydra.branchSummary(chatId).then(next => { if (!stop) setSummary(next); }, () => { if (!stop) setSummary(null); }); };
    read();
    const timer = setInterval(read, 60_000);
    // Back from a terminal or an editor where the branch may have moved.
    window.addEventListener('focus', read);
    return () => { stop = true; clearInterval(timer); window.removeEventListener('focus', read); };
  }, [chatId, running]);
  if (!summary) return null;
  const changed = summary.additions + summary.deletions > 0;
  return (
    <div className="pr-bars branch-bars" aria-label="Branch">
      <div className="pr-bar branch-bar">
        <span className="pr-main branch-main" title={`${summary.repo} on ${summary.branch}${summary.base ? `, against ${summary.base}` : ''}`}>
          <span className="pr-icon branch-icon"><Icon name="branch" /></span>
          <span className="pr-repo">{summary.repo}</span>
          <span className="pr-branch">{summary.branch}</span>
        </span>
        {changed && <span className="pr-pill pr-lines" aria-label={`${summary.additions} lines added, ${summary.deletions} removed${summary.base ? ` against ${summary.base}` : ''}`}><span className="add">+{summary.additions}</span> <span className="del">−{summary.deletions}</span></span>}
        {summary.canCreatePr && <button className="pr-pill branch-create" disabled={running} onClick={() => onCreatePr(summary)} title={running ? 'Wait for this turn to finish' : 'Ask the agent to commit, push and open a pull request'}>Create PR</button>}
      </div>
    </div>
  );
}

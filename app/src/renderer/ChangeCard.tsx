import { useState } from 'react';
import type { TurnFile } from '../shared/ipc';
import { Icon } from './Icon';

/**
 * The card after a turn that edited files (Claude desktop's "Edited N files"): the turn's total, Undo, and one row per
 * file that opens that file's diff for the turn. The lists come from the chat's own `turn-changes` event.
 */
export interface ChangeCardData { changeId: string; files: TurnFile[]; undone?: { files: string[]; skipped: Array<{ path: string; reason: string }> } }

export const changeTitle = (count: number): string => `Edited ${count} file${count === 1 ? '' : 's'}`;
export function changeTotals(files: readonly TurnFile[]): { added: number; removed: number } {
  return files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { added: 0, removed: 0 });
}
const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);
const Counts = ({ added, removed }: { added?: number; removed?: number }) => (added === undefined && removed === undefined ? null : <span className="pr-lines change-counts"><span className="add">+{added ?? 0}</span> <span className="del">-{removed ?? 0}</span></span>);

interface Props {
  card: ChangeCardData;
  /** Opens one file's diff for this turn. */
  onOpen(path: string): void;
  /** Undoes the turn; rejects with what went wrong. Unset when the chat can't undo right now. */
  onUndo?(): Promise<unknown>;
}

export function ChangeCard({ card, onOpen, onUndo }: Props) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { added, removed } = changeTotals(card.files);
  const undo = () => {
    if (!onUndo || busy) return;
    setBusy(true);
    setProblem(undefined);
    onUndo().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  return (
    <div className={`change-card${card.undone ? ' undone' : ''}`} role="group" aria-label={changeTitle(card.files.length)}>
      <div className="change-head">
        <button className="change-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}><Icon name="file" /><span className="change-title">{changeTitle(card.files.length)}</span></button>
        {card.undone
          ? <span className="change-undone">Undone</span>
          : <button className="change-undo" onClick={undo} disabled={!onUndo || busy} title={onUndo ? 'Put these files back as they were before this turn' : 'Undo is available when the chat is idle'}>{busy ? 'Undoing…' : 'Undo'}</button>}
        <Counts added={added} removed={removed} />
        <button className={`change-chevron${open ? ' open' : ''}`} onClick={() => setOpen(value => !value)} aria-label={open ? 'Hide files' : 'Show files'} tabIndex={-1}><Icon name="chevron" /></button>
      </div>
      {open && card.files.map(file => (
        <button key={file.path} className="change-row" onClick={() => onOpen(file.path)} title={file.path}>
          <Icon name="code" /><span className="change-name">{baseName(file.path)}</span><Counts added={file.added} removed={file.removed} /><span className="change-chevron"><Icon name="chevron" /></span>
        </button>
      ))}
      {open && card.undone && card.undone.skipped.length > 0 && (
        <p className="change-note" role="status">Left alone, because {card.undone.skipped.length === 1 ? 'it changed' : 'they changed'} since: {card.undone.skipped.map(skip => `${skip.path} (${skip.reason})`).join('; ')}.</p>
      )}
      {problem && <p className="change-note change-problem" role="alert">{problem}</p>}
    </div>
  );
}

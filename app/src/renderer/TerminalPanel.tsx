import { Icon } from './Icon';
import { TerminalPane } from './TerminalPane';

export interface ShellTab { id: string; n: number; ended?: boolean }

interface Props {
  /** The chat this panel belongs to: selected text attaches to its composer. */
  chatId: string;
  tabs: ShellTab[];
  active?: string;
  maximized: boolean;
  onSelect(id: string): void;
  onAdd(): void;
  onCloseTab(id: string): void;
  onMaximize(): void;
  onClose(): void;
}

/**
 * Claude desktop's terminal panel beside a chat: tabs ("Terminal 1", the shell's name on the open one), + for another,
 * and on the right maximize and close. Each tab is a PowerShell in the chat's folder, inside the window; closing the
 * panel keeps them running, closing a tab ends its shell.
 */
export function TerminalPanel({ chatId, tabs, active, maximized, onSelect, onAdd, onCloseTab, onMaximize, onClose }: Props) {
  const current = tabs.find(tab => tab.id === active) ?? tabs[tabs.length - 1];
  return (
    <aside className="shell-panel" aria-label="Terminal">
      <div className="shell-bar">
        <div className="shell-tabs" role="tablist">
          {tabs.map(tab => (
            <div key={tab.id} className={`shell-tab ${tab.id === current?.id ? 'active' : ''}`} role="tab" aria-selected={tab.id === current?.id}>
              <button className="shell-tab-name" onClick={() => onSelect(tab.id)}>Terminal {tab.n}{tab.id === current?.id && <span className="shell-kind">{tab.ended ? 'ended' : 'powershell'}</span>}</button>
              <button className="shell-tab-close" onClick={() => onCloseTab(tab.id)} aria-label={`Close Terminal ${tab.n}`} title="Close"><Icon name="close" /></button>
            </div>
          ))}
          <button className="icon-button small shell-add" onClick={onAdd} aria-label="New terminal" title="New terminal"><Icon name="plus" /></button>
        </div>
        <button className="icon-button small" onClick={onMaximize} aria-pressed={maximized} aria-label={maximized ? 'Restore the terminal' : 'Maximize the terminal'} title={maximized ? 'Restore' : 'Maximize'}><Icon name={maximized ? 'restore' : 'maximize'} /></button>
        <button className="icon-button small" onClick={onClose} aria-label="Hide the terminal" title="Hide (the shells keep running)"><Icon name="close" /></button>
      </div>
      <div className="shell-body">{current ? <TerminalPane key={current.id} id={current.id} ended="The shell" attach={{ chatId, tab: tabs.indexOf(current), n: current.n }} /> : <p className="hint">Starting a terminal…</p>}</div>
    </aside>
  );
}

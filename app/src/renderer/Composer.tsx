import { useState, type KeyboardEvent } from 'react';
import type { ChatRecord, ClaudePermissionMode } from '../shared/ipc';

/** Claude's model aliases; the CLI resolves each to the current model. "Default" passes none. */
const claudeModels = [
  { value: '', label: 'Default model' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' },
];
const efforts = [{ value: '', label: 'Default effort' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))];
/** Bypass permissions isn't offered: a chat always asks before tools the CLI would ask about (HSEC-82). */
const modes: Array<{ value: ClaudePermissionMode; label: string }> = [
  { value: 'default', label: 'Ask before edits' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'plan', label: 'Plan first' },
];

interface Props {
  record: ChatRecord;
  running: boolean;
  onSend(text: string): void;
  onStop(): void;
  onConfigure(change: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode }): void;
}

export function Composer({ record, running, onSend, onStop, onConfigure }: Props) {
  const [text, setText] = useState('');
  const send = () => { if (!text.trim()) return; onSend(text); setText(''); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } };
  return (
    <div className="composer">
      <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={keyDown} placeholder={running ? 'Hydra sends this when the current turn ends' : 'Message Claude Code'} aria-label="Message" rows={3} />
      <div className="composer-bar">
        <select aria-label="Model" value={record.model ?? ''} onChange={e => onConfigure({ model: e.target.value || undefined })}>
          {claudeModels.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="Effort" value={record.effort ?? ''} onChange={e => onConfigure({ effort: e.target.value || undefined })}>
          {efforts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="Permission mode" value={record.permissionMode ?? 'default'} onChange={e => onConfigure({ permissionMode: e.target.value as ClaudePermissionMode })}>
          {modes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="composer-spacer" />
        {running && <button className="stop" onClick={onStop}>Stop</button>}
        <button className="primary small send" onClick={send} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  );
}

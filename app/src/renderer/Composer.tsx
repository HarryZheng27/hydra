import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { ChatImage, ChatModel, ChatRecord, ClaudePermissionMode, CodexSandbox } from '../shared/ipc';

const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const MAX_IMAGES = 4, MAX_BYTES = 5 * 1024 * 1024;
type Attached = ChatImage & { name: string; size: number };

/** Reads an image file as base64. Main checks its bytes again before anything reaches a CLI. */
function readImage(file: File): Promise<Attached> {
  return new Promise((resolve, reject) => {
    if (!imageTypes.includes(file.type as ChatImage['mediaType'])) { reject(new Error(`${file.name || 'That file'} isn't a PNG, JPEG, GIF or WebP image.`)); return; }
    if (file.size > MAX_BYTES) { reject(new Error(`${file.name || 'That image'} is over 5 MB.`)); return; }
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result); resolve({ mediaType: file.type as ChatImage['mediaType'], data: url.slice(url.indexOf(',') + 1), name: file.name || 'pasted image', size: file.size }); };
    reader.onerror = () => reject(new Error('Hydra couldn\'t read that image.'));
    reader.readAsDataURL(file);
  });
}

/** Claude's model aliases; the CLI resolves each to the current model. "Default" passes none. */
const claudeModels = [
  { value: '', label: 'Default model' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' },
];
const efforts = [{ value: '', label: 'Default effort' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))];
/** Full access isn't offered: a Codex chat is read-only, or may write in its own folder after you approve. */
const sandboxes: Array<{ value: CodexSandbox; label: string }> = [
  { value: 'read-only', label: 'Read-only' }, { value: 'workspace-write', label: 'Can edit this folder' },
];
/** Bypass permissions isn't offered: a chat always asks before tools the CLI would ask about (HSEC-82). */
const modes: Array<{ value: ClaudePermissionMode; label: string }> = [
  { value: 'default', label: 'Ask before edits' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'plan', label: 'Plan first' },
];

interface Props {
  record: ChatRecord;
  running: boolean;
  onSend(text: string, images?: ChatImage[]): void;
  onStop(): void;
  onConfigure(change: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox }): void;
  /** Codex's own model list, from the chat's latest model/list. */
  models?: ChatModel[];
}

export function Composer({ record, running, onSend, onStop, onConfigure, models = [] }: Props) {
  const codex = record.provider === 'codex';
  const codexModel = models.find(model => model.id === record.model) ?? models.find(model => model.isDefault);
  const modelOptions = codex ? [{ value: '', label: 'Default model' }, ...models.map(model => ({ value: model.id, label: model.label }))] : claudeModels;
  const effortOptions = codex && codexModel ? [{ value: '', label: 'Default effort' }, ...codexModel.efforts.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))] : efforts;
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attached[]>([]);
  const [problem, setProblem] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const attach = async (files: File[]) => {
    setProblem(undefined);
    for (const file of files) {
      try {
        const image = await readImage(file);
        setImages(current => (current.length >= MAX_IMAGES ? (setProblem(`At most ${MAX_IMAGES} images per message.`), current) : [...current, image]));
      } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    }
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); void attach(files); }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); void attach(files); } };
  const send = () => {
    if (!text.trim() && !images.length) return;
    onSend(text, images.map(({ mediaType, data }) => ({ mediaType, data })));
    setText('');
    setImages([]);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } };
  return (
    <div className="composer" onDragOver={event => event.preventDefault()} onDrop={drop}>
      {(images.length > 0 || problem) && (
        <div className="attachments">
          {images.map((image, index) => (
            <span key={index} className="chip attachment" title={image.name}>{image.name} · {Math.max(1, Math.round(image.size / 1024))} KB
              <button aria-label={`Remove ${image.name}`} onClick={() => setImages(current => current.filter((_, i) => i !== index))}>×</button></span>
          ))}
          {problem && <span className="error">{problem}</span>}
        </div>
      )}
      <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={keyDown} onPaste={paste} placeholder={running ? 'Hydra sends this when the current turn ends' : codex ? 'Message Codex' : 'Message Claude Code'} aria-label="Message" rows={3} />
      <div className="composer-bar">
        <select aria-label="Model" value={record.model ?? ''} onChange={e => onConfigure({ model: e.target.value || undefined })}>
          {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="Effort" value={record.effort ?? ''} onChange={e => onConfigure({ effort: e.target.value || undefined })}>
          {effortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {codex
          ? <select aria-label="Sandbox" value={record.sandbox ?? 'read-only'} onChange={e => onConfigure({ sandbox: e.target.value as CodexSandbox })}>
              {sandboxes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          : <select aria-label="Permission mode" value={record.permissionMode ?? 'default'} onChange={e => onConfigure({ permissionMode: e.target.value as ClaudePermissionMode })}>
              {modes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>}
        <button className="attach" onClick={() => picker.current?.click()} aria-label="Attach images" title="Attach images (or paste or drop them)">Image…</button>
        <input ref={picker} type="file" accept={imageTypes.join(',')} multiple hidden onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <span className="composer-spacer" />
        {running && <button className="stop" onClick={onStop}>Stop</button>}
        <button className="primary small send" onClick={send} disabled={!text.trim() && !images.length}>Send</button>
      </div>
    </div>
  );
}

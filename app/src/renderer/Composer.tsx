import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { Picker } from './Picker';
import type { ChatDefaults, ChatImage, ChatModel, ChatRecord, ClaudePermissionMode, CodexApprovals, CodexSandbox } from '../shared/ipc';

const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
// Claude's API takes an image of at most 5 MB of base64, about 3.75 MB of file.
const MAX_IMAGES = 4, MAX_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);
type Attached = ChatImage & { name: string; size: number };

/** Reads an image file as base64. Main checks its bytes again before anything reaches a CLI. */
function readImage(file: File): Promise<Attached> {
  return new Promise((resolve, reject) => {
    if (!imageTypes.includes(file.type as ChatImage['mediaType'])) { reject(new Error(`${file.name || 'That file'} isn't a PNG, JPEG, GIF or WebP image.`)); return; }
    if (file.size > MAX_BYTES) { reject(new Error(`${file.name || 'That image'} is over 3.7 MB.`)); return; }
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result); resolve({ mediaType: file.type as ChatImage['mediaType'], data: url.slice(url.indexOf(',') + 1), name: file.name || 'pasted image', size: file.size }); };
    reader.onerror = () => reject(new Error('Hydra couldn\'t read that image.'));
    reader.readAsDataURL(file);
  });
}

/** Claude's model aliases; the CLI resolves each to the current model. */
const claudeModels = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }];
const titleCase = (value: string) => value[0]!.toUpperCase() + value.slice(1);
const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A model id the CLI reported (claude-opus-5-5) as the alias the menu offers (opus). */
const claudeAlias = (id: string | undefined) => (id ? claudeModels.find(model => id.toLowerCase().includes(model.value))?.value ?? id : undefined);
/** The options, with the current value added if the list doesn't have it, so the menu always shows what's in use. */
const withValue = (options: Array<{ value: string; label: string }>, value: string | undefined) =>
  value && !options.some(option => option.value === value) ? [{ value, label: value }, ...options] : options;
/**
 * Who answers a Codex chat's approvals. A Codex chat is read-only for now either way: letting it edit the folder waits
 * for its live check, and full access is never offered. Approved file changes still apply.
 */
const approvalModes = (defaults?: ChatDefaults): Array<{ value: CodexApprovals; label: string; description: string }> => [
  { value: 'settings', label: defaults?.approvals === 'auto_review' ? 'Auto-review' : 'Codex decides', description: defaults?.approvals === 'auto_review' ? 'Codex\'s reviewer approves what it can' : 'Your Codex config decides what to ask' },
  { value: 'ask', label: 'Ask me', description: 'Every approval comes to you' },
];
/**
 * "Your settings" passes no mode, so Claude Code follows the user's own (their defaultMode, such as auto). Bypass
 * permissions isn't offered (HSEC-82).
 */
const modes: Array<{ value: ClaudePermissionMode; label: string; description: string }> = [
  { value: 'auto', label: 'Auto', description: 'Claude Code decides what needs your OK' },
  { value: 'default', label: 'Ask before edits', description: 'Asks before editing files or running commands' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Edits files without asking; asks before commands' },
  { value: 'plan', label: 'Plan first', description: 'Plans, and changes nothing until you approve' },
];

interface Props {
  record: ChatRecord;
  running: boolean;
  onSend(text: string, images?: ChatImage[]): void;
  onStop(): void;
  onConfigure(change: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; approvals?: CodexApprovals }): void;
  /** Codex's own model list, from the chat's latest model/list. */
  models?: ChatModel[];
  /** The user's own CLI defaults: what the chat uses when it doesn't choose. */
  defaults?: ChatDefaults;
  /** The model the CLI said it is using. */
  sessionModel?: string;
}

export function Composer({ record, running, onSend, onStop, onConfigure, models = [], defaults, sessionModel }: Props) {
  const codex = record.provider === 'codex';
  // What the chat really uses: its own choice, else the user's CLI settings, else what the CLI reported.
  const model = record.model ?? (codex ? sessionModel ?? defaults?.model ?? models.find(m => m.isDefault)?.id : defaults?.model ?? claudeAlias(sessionModel) ?? 'opus');
  const codexModel = models.find(m => m.id === model) ?? models.find(m => m.isDefault);
  const effort = record.effort ?? defaults?.effort ?? (codex ? codexModel?.defaultEffort : undefined);
  const version = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(sessionModel ?? '');
  const named = claudeModels.map(option => (version && version[1]!.toLowerCase() === option.value ? { ...option, label: `${option.label} ${version[2]}.${version[3]}` } : option));
  const modelOptions = withValue(codex ? models.map(m => ({ value: m.id, label: m.label })) : named, model);
  const effortOptions = withValue((codex ? codexModel?.efforts ?? [] : claudeEfforts).map(value => ({ value, label: titleCase(value) })), effort);
  const mode = !record.permissionMode || record.permissionMode === 'settings' ? (defaults?.mode as ClaudePermissionMode | undefined) ?? 'default' : record.permissionMode;
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attached[]>([]);
  const [problem, setProblem] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
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
    if (box.current) box.current.style.height = ''; // back to one line
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } };
  // Like Claude desktop's prompt: the message in a rounded box with one button in its corner (send, or stop while a
  // turn runs and nothing is typed), and the chat's settings in a quiet row under it.
  const stopping = running && !text.trim() && !images.length;
  return (
    <div className="composer" onDragOver={event => event.preventDefault()} onDrop={drop}>
      <div className="prompt-box">
        {(images.length > 0 || problem) && (
          <div className="attachments">
            {images.map((image, index) => (
              <span key={index} className="chip attachment" title={image.name}>{image.name} · {Math.max(1, Math.round(image.size / 1024))} KB
                <button aria-label={`Remove ${image.name}`} onClick={() => setImages(current => current.filter((_, i) => i !== index))}>×</button></span>
            ))}
            {problem && <span className="error">{problem}</span>}
          </div>
        )}
        <textarea ref={box} value={text} onChange={e => setText(e.target.value)} onKeyDown={keyDown} onPaste={paste} placeholder={running ? 'Hydra sends this when the current turn ends' : 'How can I help you today?'} aria-label="Message" rows={1} onInput={event => { const box = event.currentTarget; box.style.height = 'auto'; box.style.height = `${box.scrollHeight}px`; }} />
        <button className={`round ${stopping ? 'stop' : 'send'}`} onClick={stopping ? onStop : send} disabled={!stopping && !text.trim() && !images.length} aria-label={stopping ? 'Stop' : 'Send'} title={stopping ? 'Stop' : 'Send (Enter)'}><Icon name={stopping ? 'stop' : 'arrowUp'} /></button>
      </div>
      <div className="composer-bar">
        <button className="icon-button attach" onClick={() => picker.current?.click()} aria-label="Attach images" title="Attach images (or paste or drop them)"><Icon name="plus" /></button>
        <input ref={picker} type="file" accept={imageTypes.join(',')} multiple hidden onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        {codex
          ? <Picker label="Approvals" value={record.approvals ?? 'ask'} options={approvalModes(defaults)} onChange={value => onConfigure({ approvals: value as CodexApprovals })} title="Who answers Codex's approvals. Hydra starts Codex read-only." />
          : <Picker label="Permission mode" value={mode} options={modes} onChange={value => onConfigure({ permissionMode: value as ClaudePermissionMode })} title="What Claude Code asks you about; anything it asks comes here as a card." />}
        <span className="composer-spacer" />
        <Picker label="Model" value={model} options={modelOptions} onChange={value => onConfigure({ model: value })} placeholder="Model" />
        <Picker label="Effort" value={effort} options={effortOptions} onChange={value => onConfigure({ effort: value })} placeholder="Effort" />
      </div>
    </div>
  );
}

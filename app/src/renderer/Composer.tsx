import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { Picker } from './Picker';
import { PlusMenu } from './PlusMenu';
import { ContextWheel } from './ContextWheel';
import { markSeen, seen } from './onceNotes';
import { claudeContextWindow, claudeDefaultModel, claudeLatest, claudeModelId, claudeModelOptions, claudeMore } from './claudeModels';
import { AgentLogo } from './AgentLogo';
import type { ChatDefaults, ChatImage, ChatModel, ChatRecord, ClaudePermissionMode, CodexApprovals, CodexSandbox } from '../shared/ipc';

const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
// Claude's API takes an image of at most 5 MB of base64, about 3.75 MB of file.
export const MAX_IMAGES = 4, MAX_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);
export type Attached = ChatImage & { name: string; size: number };

/** Reads an image file as base64. Main checks its bytes again before anything reaches a CLI. */
export function readImage(file: File): Promise<Attached> {
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
export const claudeModels = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }];
export const titleCase = (value: string) => value[0]!.toUpperCase() + value.slice(1);
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A model id the CLI reported (claude-opus-5-5) as the alias the menu offers (opus). */
const claudeAlias = (id: string | undefined) => (id ? claudeModels.find(model => id.toLowerCase().includes(model.value))?.value ?? id : undefined);
/** The options, with the current value added if the list doesn't have it, so the menu always shows what's in use. */
const withValue = (options: Array<{ value: string; label: string }>, value: string | undefined) =>
  value && !options.some(option => option.value === value) ? [{ value, label: value }, ...options] : options;
/**
 * Who answers a Codex chat's approvals. A Codex chat is read-only for now either way: letting it edit the folder waits
 * for its live check, and full access is never offered. Approved file changes still apply.
 */
export const approvalModes = (defaults?: ChatDefaults): Array<{ value: CodexApprovals; label: string; description: string }> => [
  { value: 'settings', label: defaults?.approvals === 'auto_review' ? 'Auto-review' : 'Codex decides', description: defaults?.approvals === 'auto_review' ? 'Codex\'s reviewer approves what it can' : 'Your Codex config decides what to ask' },
  { value: 'ask', label: 'Ask me', description: 'Every approval comes to you' },
];
/**
 * "Your settings" passes no mode, so Claude Code follows the user's own (their defaultMode, such as auto). Bypass
 * permissions isn't offered (HSEC-82).
 */
export const modes: Array<{ value: ClaudePermissionMode; label: string; description: string }> = [
  { value: 'auto', label: 'Auto', description: 'Claude handles permission decisions' },
  { value: 'default', label: 'Manual', description: 'Always ask before making changes' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Automatically accept all file edits' },
  { value: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
];
/** Claude desktop's Mode menu: a heading, then the modes, the user's own default badged. Bypass permissions isn't offered (HSEC-82). */
export const modeMenu = (defaultMode: string | undefined) => [
  { value: 'heading', label: 'Mode', heading: true },
  ...modes.map(option => (option.value === (defaultMode ?? 'default') ? { ...option, badge: 'Default' } : option)),
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
  /** G7: Local or Cloud, offered for a Claude chat until its first message. */
  onWhere?(where: 'local' | 'cloud'): void;
  /** How full the chat's context is: its latest turn's prompt, and the window when the CLI said it. */
  context?: { used: number; window?: number };
}

const whereOptions = [
  { value: 'local', label: 'Local', description: 'Claude Code runs here, on your computer.' },
  { value: 'cloud', label: 'Cloud', description: 'Claude Code runs on claude.ai; the first message starts it.' },
];

export function Composer({ record, running, onSend, onStop, onConfigure, models = [], defaults, sessionModel, onWhere, context }: Props) {
  const codex = record.provider === 'codex';
  const cloud = record.where === 'cloud';
  // What the chat really uses: its own choice, else the user's CLI settings, else what the CLI reported.
  const model = codex ? record.model ?? sessionModel ?? defaults?.model ?? models.find(m => m.isDefault)?.id : claudeModelId(record.model ?? defaults?.model ?? sessionModel) ?? claudeDefaultModel;
  const codexModel = models.find(m => m.id === model) ?? models.find(m => m.isDefault);
  const effort = record.effort ?? defaults?.effort ?? (codex ? codexModel?.defaultEffort : undefined);
  // Claude: Claude desktop's menu (claudeModels.ts); a model it doesn't list is added at the top, as for Codex.
  const claudeKnown = [...claudeLatest, ...claudeMore].some(option => option.value === model);
  const modelOptions = codex ? withValue(models.map(m => ({ value: m.id, label: m.label })), model) : claudeKnown ? claudeModelOptions() : withValue(claudeModelOptions(), model);
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
    if (record.where === 'cloud') markSeen('cloud');
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
      {record.where === 'cloud' && !seen('cloud') && <p className="hint cloud-hint">Cloud: your first message starts a Claude Code session on claude.ai. It gets this folder's tracked files as they are, uncommitted edits included; untracked and ignored files stay here. Its changes stay in the cloud.</p>}
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
        <button className={`round ${stopping ? 'stop' : 'send'}`} onClick={stopping ? onStop : send} disabled={!stopping && !text.trim() && !images.length} aria-label={stopping ? 'Stop' : 'Send'} title={stopping ? 'Stop' : 'Send (Enter)'}><Icon name={stopping ? 'stop' : 'enter'} /></button>
      </div>
      <div className="composer-bar">
        {/* A cloud chat's `--cloud` takes only the message: no images, mode, model or effort. */}
        {!cloud && <PlusMenu onFiles={files => void attach(files)} onSlash={() => { setText(current => (current.startsWith('/') ? current : `/${current}`)); box.current?.focus(); }} />}
        <input ref={picker} type="file" accept={imageTypes.join(',')} multiple hidden onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        {cloud ? null : codex
          ? <Picker label="Approvals" value={record.approvals ?? 'ask'} options={approvalModes(defaults)} onChange={value => onConfigure({ approvals: value as CodexApprovals })} title="Who answers Codex's approvals. Hydra starts Codex read-only." />
          : <Picker label="Permission mode" value={mode} options={modeMenu(defaults?.mode)} onChange={value => onConfigure({ permissionMode: value as ClaudePermissionMode })} title="What Claude Code asks you about; anything it asks comes here as a card." />}
        {onWhere && <Picker label="Where" value={record.where ?? 'local'} options={whereOptions} onChange={value => onWhere(value === 'cloud' ? 'cloud' : 'local')} title="Run this chat here or on claude.ai. Chosen before the first message." />}
        <span className="composer-spacer" />
        {!cloud && <Picker label="Model" value={model} options={modelOptions} onChange={value => onConfigure({ model: value })} placeholder="Model" />}
        {!cloud && <Picker label="Effort" value={effort} options={effortOptions} onChange={value => onConfigure({ effort: value })} placeholder="Effort" />}
        <span className="composer-agent" title={`This chat runs ${codex ? 'Codex' : 'Claude Code'}; a new chat can use the other.`}><AgentLogo provider={codex ? 'codex' : 'claude'} /></span>
        {/* The context wheel: a Claude chat compacts with Claude Code's own /compact; Codex compacts by itself. */}
        {!cloud && <ContextWheel used={context?.used} window={context?.window ?? (codex ? undefined : claudeContextWindow(model))}
          {...(!codex && !running && context ? { onCompact: () => onSend('/compact') } : {})} />}
      </div>
    </div>
  );
}

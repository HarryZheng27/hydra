import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * The prompt's + as Claude desktop's: Add files or photos (Ctrl+U while the prompt is shown), Add folder where there
 * is one to choose, and Slash commands, which starts the message with "/".
 */
export function PlusMenu({ onFiles, onFolder, onSlash }: { onFiles(files: File[]): void; onFolder?(): void; onSlash(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'u') { event.preventDefault(); input.current?.click(); } };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  const pick = (action: () => void) => { setOpen(false); action(); };
  return (
    <div className="plus-root" ref={root}>
      <button type="button" className="icon-button attach plus" aria-label="Add" aria-haspopup="menu" aria-expanded={open} title="Add files, a folder or a command" onClick={() => setOpen(value => !value)}><Icon name="plus" /></button>
      <input ref={input} type="file" accept={imageTypes.join(',')} multiple hidden onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      {open && (
        <ul className="picker-menu plus-menu" role="menu">
          <li role="menuitem" onMouseDown={event => event.preventDefault()} onClick={() => pick(() => input.current?.click())}><Icon name="paperclip" /><span className="picker-label">Add files or photos</span><span className="picker-key">Ctrl+U</span></li>
          {onFolder && <li role="menuitem" onMouseDown={event => event.preventDefault()} onClick={() => pick(onFolder)}><Icon name="folder" /><span className="picker-label">Add folder</span></li>}
          <li role="menuitem" onMouseDown={event => event.preventDefault()} onClick={() => pick(onSlash)}><Icon name="slash" /><span className="picker-label">Slash commands</span></li>
        </ul>
      )}
    </div>
  );
}

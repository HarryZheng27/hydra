import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';

export interface PickerOption { value: string; label: string; description?: string }

/**
 * A quiet menu like Claude desktop's: the current choice as text with a small chevron, opening a rounded panel above
 * it with a check on the current one. Escape or a click outside closes it; arrow keys move, Enter picks.
 */
export function Picker({ label, value, options, onChange, title, placeholder, icon, chip, bare }: { label: string; value: string | undefined; options: PickerOption[]; onChange(value: string): void; title?: string; placeholder?: string; icon?: IconName; chip?: boolean; bare?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (option: PickerOption) => { setOpen(false); if (option.value !== value) onChange(option.value); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setOpen(true); setActive(Math.max(0, options.indexOf(current!))); return; }
    if (!open) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active]!); }
  };
  return (
    <div className="picker-root" ref={root} onKeyDown={key}>
      <button type="button" className={`picker ${chip ? 'chip' : ''}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} data-value={value ?? ''} title={title}
        onClick={() => { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(current => !current); }}>
        {icon && <Icon name={icon} />}<span>{current?.label ?? placeholder ?? label}</span>{!bare && <Icon name="chevronDown" />}
      </button>
      {open && (
        <ul className="picker-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li key={option.value} role="option" aria-selected={option.value === value} data-value={option.value}
              className={`${index === active ? 'active' : ''}`} onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
              <span className="picker-text"><span className="picker-label">{option.label}</span>{option.description && <span className="picker-description">{option.description}</span>}</span>
              {option.value === value && <Icon name="check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

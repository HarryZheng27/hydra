import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** A menu choice: its label, an optional badge ("Default"), a line drawn above it, and a description shown on hover. */
export interface PickerOption { value: string; label: string; description?: string; badge?: string; separator?: boolean; art?: ReactNode; submenu?: PickerOption[] }

/**
 * A quiet menu like Claude desktop's: the current choice as text, opening a compact panel above it, one line per
 * choice, with a blue check on the current one and a number key on the others (pressing it picks that choice).
 * Escape or a click outside closes it; arrow keys move, Enter picks.
 */
export function Picker({ label, value, options, onChange, title, placeholder, icon, chip, bare, artOnly }: { label: string; value: string | undefined; options: PickerOption[]; onChange(value: string): void; title?: string; placeholder?: string; icon?: IconName; chip?: boolean; bare?: boolean; artOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // The open side menu (More models), by its row: it opens on hover or click, beside its row.
  const [sub, setSub] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const current = options.find(option => option.value === value && !option.submenu) ?? options.flatMap(option => option.submenu ?? []).find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setSub(undefined); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (option: PickerOption, index?: number) => {
    if (option.submenu) { setSub(current => (current === index ? undefined : index)); return; }
    setOpen(false); setSub(undefined);
    if (option.value !== value) onChange(option.value);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setOpen(true); setActive(Math.max(0, options.indexOf(current!))); return; }
    if (!open) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active]!, active); }
    if (/^[1-9]$/.test(event.key) && options[Number(event.key) - 1] && !options[Number(event.key) - 1]!.submenu) { event.preventDefault(); choose(options[Number(event.key) - 1]!); }
  };
  return (
    <div className="picker-root" ref={root} onKeyDown={key}>
      <button type="button" className={`picker ${chip ? 'chip' : ''}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} data-value={value ?? ''} title={title}
        onClick={() => { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(current => !current); }}>
        {icon && <Icon name={icon} />}{artOnly && current?.art ? current.art : <span>{current?.label ?? placeholder ?? label}</span>}{!bare && <Icon name="chevronDown" />}
      </button>
      {open && (
        <ul className="picker-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li key={option.value} role="option" aria-selected={option.value === value} data-value={option.value} title={option.description}
              className={`${index === active ? 'active' : ''} ${option.separator ? 'separated' : ''} ${option.submenu ? 'has-submenu' : ''}`}
              onMouseEnter={() => { setActive(index); setSub(option.submenu ? index : undefined); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option, index)}>
              {option.art}<span className="picker-label">{option.label}</span>
              {option.badge && <span className="picker-badge">{option.badge}</span>}
              <span className="picker-key">{option.submenu ? <Icon name="chevron" /> : option.value === value ? <Icon name="check" /> : index < 9 ? index + 1 : null}</span>
              {option.submenu && sub === index && (
                <ul className="picker-menu picker-submenu" role="listbox" aria-label={option.label}>
                  {option.submenu.map(choice => (
                    <li key={choice.value} role="option" aria-selected={choice.value === value} data-value={choice.value} title={choice.description}
                      onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); choose(choice); }}>
                      <span className="picker-label">{choice.label}</span>
                      {choice.badge && <span className="picker-badge">{choice.badge}</span>}
                      <span className="picker-key">{choice.value === value ? <Icon name="check" /> : null}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

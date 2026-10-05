import { useEffect, useState, type KeyboardEvent } from 'react';

/** A slash command the CLI listed, and whether it's one of the user's skills. */
export interface SlashCommand { name: string; skill: boolean }

const shown = 8;

/** The commands that fit what's typed so far: names starting with it first, then names containing it. */
export function matchCommands(text: string, commands: SlashCommand[]): SlashCommand[] {
  const typed = /^\/([\w:.-]*)$/.exec(text)?.[1];
  if (typed === undefined) return [];
  const needle = typed.toLowerCase();
  const starts = commands.filter(command => command.name.toLowerCase().startsWith(needle));
  const contains = commands.filter(command => !command.name.toLowerCase().startsWith(needle) && command.name.toLowerCase().includes(needle));
  return [...starts, ...contains].slice(0, shown);
}

/**
 * Claude Code's / menu in the prompt: typing "/" lists the CLI's own commands and the user's skills (what its init
 * reported); ↑ ↓ move, Tab or Enter put the command in the box, Escape closes. `keyDown` returns true when it used the
 * key, so the prompt doesn't also send.
 */
export function useSlashMenu(text: string, commands: SlashCommand[], setText: (text: string) => void) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const items = dismissed === text ? [] : matchCommands(text, commands);
  useEffect(() => { setActive(0); }, [text]);
  const choose = (command: SlashCommand) => setText(`/${command.name} `);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!items.length) return false;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % items.length); return true; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index - 1 + items.length) % items.length); return true; }
    if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) { event.preventDefault(); choose(items[Math.min(active, items.length - 1)]!); return true; }
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(text); return true; }
    return false;
  };
  const menu = items.length ? (
    <ul className="picker-menu slash-menu" role="listbox" aria-label="Slash commands">
      {items.map((command, index) => (
        <li key={command.name} role="option" aria-selected={index === active} className={index === active ? 'active' : ''}
          onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(command)}>
          <span className="picker-label">/{command.name}</span>
          {command.skill && <span className="picker-badge">skill</span>}
        </li>
      ))}
    </ul>
  ) : null;
  return { keyDown, menu };
}

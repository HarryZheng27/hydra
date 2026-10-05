import { useEffect, useState, type KeyboardEvent } from 'react';

/** A slash command the CLI listed, and whether it's one of the user's skills. */
export interface SlashCommand { name: string; skill: boolean; description?: string; argumentHint?: string }

const shown = 8;
const rememberedKey = 'hydra.claudeCommands';

/** The latest Claude command list, kept so the home's / menu works before any chat opens (after a restart, say). */
export function rememberCommands(commands: SlashCommand[]): void {
  try { window.localStorage.setItem(rememberedKey, JSON.stringify(commands.slice(0, 400))); } catch { /* the home waits for a chat */ }
}
export function rememberedCommands(): SlashCommand[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(rememberedKey) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((command): command is SlashCommand => !!command && typeof command === 'object' && typeof (command as SlashCommand).name === 'string' && /^[a-z0-9][\w:.-]{0,63}$/i.test((command as SlashCommand).name))
      .map(command => ({ name: command.name, skill: !!command.skill, ...(typeof command.description === 'string' ? { description: command.description.slice(0, 300) } : {}), ...(typeof command.argumentHint === 'string' ? { argumentHint: command.argumentHint.slice(0, 100) } : {}) }));
  } catch { return []; }
}

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
          <span className="picker-text">
            <span className="picker-line"><span className="picker-label">/{command.name}</span>{command.argumentHint && <span className="slash-hint">{command.argumentHint}</span>}{command.skill && <span className="picker-badge">skill</span>}</span>
            {command.description && <span className="picker-description">{command.description}</span>}
          </span>
        </li>
      ))}
    </ul>
  ) : null;
  return { keyDown, menu };
}

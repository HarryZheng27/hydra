import React, { useEffect, useRef, useState } from 'react';
import type { NeedsYouItem } from '../src/core/needsYou';
import { clampCursor, emptyNeedsYou, keyStep, kindLabel, openAction, optionAction, primaryAction, primaryLabel, putOffChoices, putOffKey, replyAction, timeLeft, type ListState, type NeedsYouAction } from '../src/core/needsYouList';
import './needs-you.css';

/**
 * The Needs you tab (docs/internal/Needs_You_Plan.md, Phase 5): everything waiting on the user in this project, in the
 * order src/core/needsYou.ts gives, with the keys the plan sets (src/core/needsYouList.ts keyStep). Pure of the host:
 * the parent hands over the items and carries out each action by sending the message the canvas sends for the same thing.
 *
 *   J/K or the arrows move · Enter opens · 1-4 picks an option · R replies · E runs the primary action
 *   L puts the item off until a time you choose · Z undoes the last put-off
 *
 * A single key never merges: Merge plan asks here first, and only its button (a click, or Enter on the focused button) goes ahead.
 */

const clockText = (item: NeedsYouItem, now: number): string | undefined => {
  if (item.deadline === undefined) return undefined;
  return item.kind === 'head-question' ? `Hydra answers in ${timeLeft(item.deadline, now)}` : `Resets in ${timeLeft(item.deadline, now)}`;
};

/** A key that belongs to a button or field, not the list: Enter on the Merge button is its click. */
const inField = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || !!element?.isContentEditable;
};

export interface NeedsYouViewProps {
  items: readonly NeedsYouItem[];
  /** Carries out what a key chose: send the message, open the head or lane, or open the chat. */
  onAction: (action: NeedsYouAction, item: NeedsYouItem) => void;
  /** L: put the item off until this time (ms). */
  onPutOff: (item: NeedsYouItem, until: number) => void;
  /** Z: bring back an item that was put off. */
  onUndo: (item: NeedsYouItem) => void;
  /** Wall clock, for tests. */
  clock?: () => number;
}

export function NeedsYouView({ items, onAction, onPutOff, onUndo, clock = Date.now }: NeedsYouViewProps) {
  const [list, setList] = useState<ListState>({ cursor: 0 });
  const [now, setNow] = useState(clock);
  const [putOffs, setPutOffs] = useState<NeedsYouItem[]>([]);
  const [note, setNote] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  // Items come and go; the cursor stays on the same one when it can, else near where it was.
  const selectedId = useRef<string | undefined>(undefined);
  const index = clampCursor(items, list.cursor, selectedId.current);
  const current = items[index];
  selectedId.current = current?.id;
  const { menu, confirming } = list;
  useEffect(() => {
    setList(state => {
      const keep = (id?: string) => (id && items.some(item => item.id === id) ? id : undefined);
      return { cursor: clampCursor(items, state.cursor, selectedId.current), ...(keep(state.menu) ? { menu: state.menu } : {}), ...(keep(state.confirming) ? { confirming: state.confirming } : {}) };
    });
  }, [items]);
  // The clocks tick while something is on one.
  const hasClock = items.some(item => item.deadline !== undefined);
  useEffect(() => {
    if (!hasClock) return undefined;
    const timer = setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(timer);
  }, [hasClock, clock]);

  const putOff = (item: NeedsYouItem, ms: number) => {
    onPutOff(item, clock() + ms);
    setPutOffs(stack => [...stack.filter(entry => putOffKey(entry) !== putOffKey(item)), item].slice(-20));
    setNote(`Put off "${item.title}". Z undoes it.`);
  };
  const undo = () => {
    const last = putOffs[putOffs.length - 1];
    if (!last) { setNote('Nothing to undo.'); return; }
    setPutOffs(stack => stack.slice(0, -1));
    onUndo(last);
    setNote(`"${last.title}" is back.`);
  };
  const act = (action: NeedsYouAction | undefined, item: NeedsYouItem) => {
    if (!action) return;
    // Merging never happens on one key: ask in the list first.
    if (action.kind === 'confirm') setList(state => ({ cursor: state.cursor, confirming: item.id })); else onAction(action, item);
  };
  const reset = () => setList({ cursor: index });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (inField(event.target)) { if (event.key === 'Escape') reset(); return; }
    const result = keyStep({ cursor: index, ...(menu ? { menu } : {}), ...(confirming ? { confirming } : {}) }, items, event.key);
    if (result.handled) event.preventDefault();
    setList(result.state);
    const effect = result.effect;
    if (effect?.kind === 'undo') undo();
    else if (effect?.kind === 'putOff') putOff(effect.item, effect.ms);
    else if (effect?.kind === 'action') act(effect.action, effect.item);
  };

  const multipleProjects = new Set(items.map(item => item.projectId)).size > 1;
  return <section className="needs-you" aria-label="Needs you">
    <div ref={box} className="needs-you-list" role="listbox" aria-label="Things that need you" tabIndex={0} aria-activedescendant={current ? `needs-${current.id}` : undefined} onKeyDown={onKeyDown}>
      {!items.length && <p className="needs-you-empty">{emptyNeedsYou}</p>}
      {items.map((item, at) => {
        const selected = at === index;
        const clockLine = clockText(item, now);
        const primary = primaryAction(item);
        const reply = replyAction(item);
        return <div key={item.id} id={`needs-${item.id}`} role="option" aria-selected={selected} className={`needs-you-item tier-${item.tier}${selected ? ' selected' : ''}`}
          onClick={() => { setList({ cursor: at }); box.current?.focus({ preventScroll: true }); }}>
          <div className="needs-you-head">
            <span className="needs-you-kind">{kindLabel[item.kind]}</span>
            <strong className="needs-you-title">{item.title}</strong>
            {multipleProjects && <span className="needs-you-project">{item.projectName}</span>}
            {clockLine && <span className="needs-you-clock">{clockLine}</span>}
          </div>
          {item.detail && <p className="needs-you-detail">{item.detail}</p>}
          {!!item.options?.length && <ol className="needs-you-options">
            {item.options.map(option => <li key={option.option}>
              <button className="needs-you-option" onClick={() => act(optionAction(item, option.option), item)} title={`Answer with option ${option.option}`}>
                <kbd>{option.option}</kbd><span>{option.text}</span>{option.recommended && <em>recommended</em>}
              </button>
            </li>)}
          </ol>}
          {selected && <div className="needs-you-actions">
            <button className="primary" onClick={() => act(primary, item)}>{primaryLabel[item.kind]} <kbd>E</kbd></button>
            <button onClick={() => onAction(openAction(item), item)}>Open <kbd>Enter</kbd></button>
            {reply && <button onClick={() => act(reply, item)}>Reply <kbd>R</kbd></button>}
            <button onClick={() => setList({ cursor: index, ...(menu === item.id ? {} : { menu: item.id }) })} aria-expanded={menu === item.id}>Put off <kbd>L</kbd></button>
          </div>}
          {selected && menu === item.id && <div className="needs-you-confirm" role="menu" aria-label="Put off until">
            {putOffChoices.map((choice, number) => <button key={choice.label} role="menuitem" onClick={() => { putOff(item, choice.ms); reset(); }}><kbd>{number + 1}</kbd> {choice.label}</button>)}
            <button onClick={reset}>Cancel</button>
          </div>}
          {confirming === item.id && primary.kind === 'confirm' && <div className="needs-you-confirm" role="alertdialog" aria-label="Confirm">
            <span>{primary.question}</span>
            <button className="primary" autoFocus onClick={() => { reset(); onAction({ kind: 'send', message: primary.message }, item); }}>{primary.button}</button>
            <button onClick={reset}>Cancel</button>
          </div>}
        </div>;
      })}
    </div>
    <footer className="needs-you-keys" aria-live="polite">{note ?? 'J/K move · Enter open · 1–4 pick · R reply · E do it · L put off · Z undo'}</footer>
  </section>;
}

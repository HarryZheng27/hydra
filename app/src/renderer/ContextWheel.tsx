import { useEffect, useRef, useState } from 'react';

/** The plan's weekly limit, as Claude Code last reported it: the share used (0 to 1) and when it resets. */
export interface WeeklyLimit { used: number; resetsAt: string }

const amount = (value: number) => (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(value));

/** "Resets Sat 8:00 AM", in the user's own clock. */
export function resetsLabel(iso: string): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return `Resets ${at.toLocaleDateString(undefined, { weekday: 'short' })} ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** What the tooltip says, as Claude desktop's: "Context 361.3k / 1M (36%)", then the weekly limit when known. */
export function contextLines(used: number | undefined, size: number | undefined, weekly?: WeeklyLimit): [string, string | undefined] {
  const share = used !== undefined && size ? Math.min(1, used / size) : 0;
  const first = size ? `Context ${amount(used ?? 0)} / ${amount(size)} (${Math.round(share * 100)}%)` : `Context ${Math.round(share * 100)}%`;
  const resets = weekly && resetsLabel(weekly.resetsAt);
  const second = weekly ? `Weekly · all models: ${Math.round(weekly.used * 100)}%${resets ? ` · ${resets}` : ''}` : undefined;
  return [first, second];
}

/**
 * Claude desktop's context wheel: a small ring that fills as the chat's context does. Clicking it compacts the chat
 * (Claude Code's /compact); where compacting isn't Hydra's to ask for, it only shows the fill. Resting the pointer on
 * it a moment shows Claude's dark tooltip: the context used, and the plan's weekly limit.
 */
export function ContextWheel({ used, window: size, onCompact, weekly }: { used?: number; window?: number; onCompact?(): void; weekly?: WeeklyLimit }) {
  const share = used !== undefined && size ? Math.min(1, used / size) : 0;
  const radius = 6, around = 2 * Math.PI * radius;
  const [first, second] = contextLines(used, size, weekly);
  const spoken = `${first}${second ? `. ${second}` : ''}${onCompact ? '. Click to compact the conversation.' : ''}`;
  const [tip, setTip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setTip(true), 500); };
  const hide = () => { clearTimeout(timer.current); setTip(false); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span className="context-wheel-wrap" onMouseEnter={show} onMouseLeave={hide}>
      <button type="button" className={`context-wheel ${share >= 0.8 ? 'full' : ''}`} onClick={() => { hide(); onCompact?.(); }} disabled={!onCompact} aria-label={spoken} onFocus={show} onBlur={hide}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border)" strokeWidth="2" />
          {share > 0 && <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeDasharray={`${Math.max(0.6, share * around)} ${around}`} transform="rotate(-90 8 8)" />}
        </svg>
      </button>
      {tip && <span className="hover-tip" role="tooltip"><span className="hover-tip-title">{first}</span>{second && <span className="hover-tip-line">{second}</span>}</span>}
    </span>
  );
}

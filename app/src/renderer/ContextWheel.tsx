/**
 * Claude desktop's context wheel: a small ring that fills as the chat's context does. Clicking it compacts the chat
 * (Claude Code's /compact); where compacting isn't Hydra's to ask for, it only shows the fill.
 */
export function ContextWheel({ used, window: size, onCompact }: { used?: number; window?: number; onCompact?(): void }) {
  const share = used !== undefined && size ? Math.min(1, used / size) : 0;
  const radius = 6, around = 2 * Math.PI * radius;
  const amount = (value: number) => (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
  const label = used !== undefined && size ? `Context: ${amount(used)} of ${amount(size)} (${Math.round(share * 100)}%)` : 'Context: nothing used yet';
  const title = onCompact ? `${label}. Click to compact the conversation.` : label;
  return (
    <button type="button" className={`context-wheel ${share >= 0.8 ? 'full' : ''}`} onClick={onCompact} disabled={!onCompact} aria-label={title} title={title}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border)" strokeWidth="2" />
        {share > 0 && <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={`${Math.max(0.6, share * around)} ${around}`} transform="rotate(-90 8 8)" />}
      </svg>
    </button>
  );
}

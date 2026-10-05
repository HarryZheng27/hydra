/**
 * The agents' marks, in place of their names: Claude Code's orange spark and Codex's knot. Drawn here (the CSP allows no
 * images from elsewhere); each carries its name for screen readers and on hover.
 */
export function AgentLogo({ provider, size = 16 }: { provider: 'claude' | 'codex'; size?: number }) {
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  if (provider === 'claude') {
    // Twelve rounded rays of two lengths around a small centre.
    const rays = Array.from({ length: 12 }, (_, index) => {
      const angle = (index * Math.PI) / 6 + Math.PI / 12;
      const outer = index % 2 ? 8.6 : 10.4;
      return <line key={index} x1={12 + 2.2 * Math.cos(angle)} y1={12 + 2.2 * Math.sin(angle)} x2={12 + outer * Math.cos(angle)} y2={12 + outer * Math.sin(angle)} />;
    });
    return (
      <svg className="agent-logo claude" viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={name}>
        <title>{name}</title>
        <g stroke="#D97757" strokeWidth="2.3" strokeLinecap="round">{rays}</g>
      </svg>
    );
  }
  // Six interlaced petals: OpenAI's knot, which Codex wears.
  return (
    <svg className="agent-logo codex" viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={name}>
      <title>{name}</title>
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        {Array.from({ length: 6 }, (_, index) => <rect key={index} x="9.2" y="3.2" width="5.6" height="11" rx="2.8" transform={`rotate(${index * 60} 12 12)`} />)}
      </g>
    </svg>
  );
}

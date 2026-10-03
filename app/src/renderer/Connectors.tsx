import { useEffect, useState } from 'react';
import type { CliProvider, HydraConnection } from '../shared/ipc';

/** What each connection state means for the user, in one line. */
function describe(row: HydraConnection): { text: string; tone: 'ok' | 'warning' | 'muted'; action?: 'connect' | 'repair' } {
  if (row.error) return { text: `Couldn't read ${row.name}'s settings: ${row.error}`, tone: 'warning' };
  if (row.current) return { text: 'Connected to this app: chats can start heads and plans.', tone: 'ok' };
  if (row.connected && row.targetExists) return { text: 'Connected through Hydra IDE, which reaches this app too.', tone: 'ok', action: 'connect' };
  if (row.connected) return { text: 'Connected to a Hydra that is no longer installed.', tone: 'warning', action: 'repair' };
  return { text: 'Not connected: chats can\'t start heads or plans.', tone: 'muted', action: 'connect' };
}

/**
 * Settings → Connectors (G5 milestone 2): Hydra's own `hydra` entry in Claude Code's and Codex's user settings. Connect
 * points it at this app; an entry that points at Hydra IDE (still installed) already works here, and nothing rewrites
 * it unless you ask.
 */
export function Connectors() {
  const [rows, setRows] = useState<HydraConnection[]>();
  const [busy, setBusy] = useState<CliProvider>();
  const [problem, setProblem] = useState<string>();
  const run = async (provider: CliProvider | undefined, task: () => Promise<HydraConnection[]>) => {
    setBusy(provider); setProblem(undefined);
    try { setRows(await task()); } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); } finally { setBusy(undefined); }
  };
  useEffect(() => { void run(undefined, () => window.hydra.hydraConnections()); }, []);
  return (
    <div className="connectors">
      <h2>Connectors</h2>
      <p className="hint">Hydra adds one tool server, <code>hydra</code>, to Claude Code and Codex, so a chat can start heads and plans. It changes nothing else in their settings.</p>
      {!rows && !problem && <p className="hint">Checking…</p>}
      {rows?.map(row => {
        const line = describe(row);
        return (
          <div className="setting connector" key={row.provider} data-provider={row.provider}>
            <div className="setting-label">{row.name}<div className={`connector-status ${line.tone}`}>{line.text}</div></div>
            <div className="setting-value">
              {line.action && <button disabled={!!busy} onClick={() => void run(row.provider, () => window.hydra.connectHydra(row.provider))}>{busy === row.provider ? 'Working…' : line.action === 'repair' ? 'Repair' : row.connected ? 'Use this app' : 'Connect'}</button>}
              {row.connected && <button disabled={!!busy} onClick={() => void run(row.provider, () => window.hydra.disconnectHydra(row.provider))}>Disconnect</button>}
            </div>
          </div>
        );
      })}
      {problem && <p className="error">{problem}</p>}
    </div>
  );
}

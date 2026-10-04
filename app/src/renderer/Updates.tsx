import { useEffect, useState } from 'react';
import type { UpdateStatusView } from '../shared/ipc';

/**
 * Settings → Updates (G6): an installed stable release checks GitHub once a day and offers each new release; Check now
 * asks at once. Main shows the offer, the download and the confirm in its own dialogs. A preview or a development copy
 * says why it doesn't update itself.
 */
export function Updates() {
  const [status, setStatus] = useState<UpdateStatusView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void window.hydra.updateStatus().then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, []);
  // Each control waits for its own call, disabled meanwhile, so answers can't land out of order.
  const run = (call: () => Promise<UpdateStatusView>, pending: (on: boolean) => void) => {
    setError(undefined);
    pending(true);
    void call().then(setStatus, (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); void window.hydra.updateStatus().then(setStatus, () => undefined); }).finally(() => pending(false));
  };
  if (!status) return null;
  return (
    <>
      <h2>Updates</h2>
      {status.available ? (
        <>
          <div className="setting">
            <div className="setting-label" id="updates-daily-label">Check for updates every day</div>
            <div className="setting-value">
              <input type="checkbox" aria-labelledby="updates-daily-label" checked={status.automatic} disabled={saving} onChange={event => { const on = event.target.checked; run(() => window.hydra.setAutomaticUpdates(on), setSaving); }} />
            </div>
          </div>
          <div className="setting">
            <div className="setting-label">Hydra {status.version}</div>
            <div className="setting-value">
              <button disabled={checking || status.busy} onClick={() => run(() => window.hydra.checkForUpdates(), setChecking)}>{checking || status.busy ? 'Checking…' : 'Check for updates'}</button>
            </div>
          </div>
        </>
      ) : <p className="hint">{status.reason}</p>}
      {error && <p className="hint" role="alert">{error}</p>}
    </>
  );
}

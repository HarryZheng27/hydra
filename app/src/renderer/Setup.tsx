import { useState } from 'react';
import type { CliProvider, OnboardingReport, ProviderStatus } from '../shared/ipc';

interface Props {
  report?: OnboardingReport;
  checking: boolean;
  onCheck(): void;
  onSignIn(provider: CliProvider): Promise<{ started: boolean; error?: string }>;
}

function statusLine(status: ProviderStatus): { text: string; tone: 'ok' | 'warning' | 'error' } {
  if (!status.found) return { text: status.error ?? 'Not found', tone: 'error' };
  if (!status.version) return { text: status.error ?? 'The version check failed', tone: 'error' };
  if (!status.supported) return { text: `${status.version} isn't supported: Hydra needs ${status.minimum} or newer`, tone: 'warning' };
  return { text: `${status.version} · supported`, tone: 'ok' };
}

/**
 * Onboarding: which CLIs are installed, their versions and whether Hydra supports them, a Sign in button that opens
 * the CLI's own login in a console window, and whether Hydra's tools are registered with each CLI (read-only).
 */
export function Setup({ report, checking, onCheck, onSignIn }: Props) {
  const [notes, setNotes] = useState<Partial<Record<CliProvider, string>>>({});
  const signIn = async (provider: CliProvider) => {
    const result = await onSignIn(provider).catch(error => ({ started: false, error: String(error?.message ?? error) }));
    setNotes(current => ({ ...current, [provider]: result.started ? 'A sign-in window opened. Finish there; Hydra reads nothing from it.' : result.error ?? 'The sign-in window didn\'t open.' }));
  };

  return (
    <section className="setup" aria-label="Set up Claude Code and Codex" aria-busy={checking} data-checked-at={report?.checkedAt}>
      <div className="setup-head">
        <h2>Your agents</h2>
        <button onClick={onCheck} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
      </div>
      {!report && <p className="hint">{checking ? 'Looking for Claude Code and Codex…' : 'Not checked yet.'}</p>}
      {report?.providers.map(status => {
        const line = statusLine(status);
        const registration = report.registration[status.provider];
        return (
          <div className="provider" key={status.provider} data-provider={status.provider}>
            <div className="provider-main">
              <div className="provider-name">{status.name}</div>
              <div className={`provider-status ${line.tone}`} role="status">{line.text}</div>
              {status.executable && <div className="path" title={status.executable}>{status.executable}</div>}
              <div className="provider-registration">
                Hydra tools: {registration.error ? <span className="warning">couldn't read {registration.where}</span> : registration.registered ? 'registered' : 'not registered'}
              </div>
              {notes[status.provider] && <div className="hint">{notes[status.provider]}</div>}
            </div>
            <button className="primary small" disabled={!status.found} onClick={() => void signIn(status.provider)} title={status.found ? `Opens ${status.name}'s own sign-in in a terminal window` : `Install ${status.name} first`}>Sign in</button>
          </div>
        );
      })}
      {report && <p className="hint">Hydra runs your own installed Claude Code and Codex, on your own subscriptions. Signing in happens in each tool's own window; Hydra never sees your account. Hydra IDE registers Hydra's tools with them; this app only checks.</p>}
    </section>
  );
}

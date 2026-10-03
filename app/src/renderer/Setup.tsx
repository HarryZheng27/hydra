import { useState } from 'react';
import type { CliProvider, OnboardingReport, ProviderStatus } from '../shared/ipc';

interface Props {
  report?: OnboardingReport;
  checking: boolean;
  onCheck(): void;
  onSignIn(provider: CliProvider): Promise<{ signedIn: boolean; error?: string }>;
}

function statusLine(status: ProviderStatus): { text: string; tone: 'ok' | 'warning' | 'error' } {
  if (!status.found) return { text: status.error ?? 'Not found', tone: 'error' };
  if (!status.version) return { text: status.error ?? 'The version check failed', tone: 'error' };
  if (!status.supported) return { text: `${status.version} isn't supported: Hydra needs ${status.minimum} or newer`, tone: 'warning' };
  return { text: `${status.version} · supported`, tone: 'ok' };
}

const accountLine: Record<NonNullable<ProviderStatus['account']>, string> = {
  'signed-in': 'Signed in', 'signed-out': 'Not signed in', other: 'Signed in another way (not a subscription)', unknown: 'Couldn\'t check sign-in',
};

/**
 * Onboarding: which CLIs are installed, their versions and whether Hydra supports them, whether each says you're signed
 * in, a Sign in button that runs the CLI's own login in your browser (no terminal), and whether Hydra's tools are
 * registered with each CLI (read-only).
 */
export function Setup({ report, checking, onCheck, onSignIn }: Props) {
  const [notes, setNotes] = useState<Partial<Record<CliProvider, string>>>({});
  const [signing, setSigning] = useState<Partial<Record<CliProvider, boolean>>>({});
  const signIn = async (provider: CliProvider) => {
    setSigning(current => ({ ...current, [provider]: true }));
    setNotes(current => ({ ...current, [provider]: `Finish signing in in your browser. No tab opened? Run ${provider === 'claude' ? 'claude auth login' : 'codex login'} in a terminal.` }));
    const result = await onSignIn(provider).catch(error => ({ signedIn: false, error: String(error?.message ?? error) }));
    setSigning(current => ({ ...current, [provider]: false }));
    setNotes(current => ({ ...current, [provider]: result.signedIn ? undefined : result.error ?? 'Sign-in didn\'t finish. Try again.' }));
    onCheck();
  };

  return (
    <section className="setup" aria-label="Set up Claude Code and Codex" aria-busy={checking} data-checked-at={report?.checkedAt}>
      <div className="setup-head">
        <h2>Your agents</h2>
        <button onClick={onCheck} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
      </div>
      {!report && <p className="hint">{checking ? 'Looking for Claude Code and Codex…' : 'Not checked yet.'}</p>}
      <div className="providers">
      {report?.providers.map(status => {
        const line = statusLine(status);
        const registration = report.registration[status.provider];
        return (
          <div className="provider" key={status.provider} data-provider={status.provider}>
            <div className="provider-main">
              <div className="provider-name">{status.name}</div>
              <div className={`provider-status ${line.tone}`} role="status">{line.text}</div>
              <div className="provider-registration">
                Hydra tools: {registration.error ? <span className="warning">couldn't read {registration.where}</span> : registration.registered ? 'registered' : 'not registered'}
              </div>
              {status.account && <div className={`provider-account ${status.account}`}>{accountLine[status.account]}</div>}
              {notes[status.provider] && <div className="hint">{notes[status.provider]}</div>}
            </div>
            {status.account !== 'signed-in' && (
              <button className="primary small" disabled={!status.found || signing[status.provider]} onClick={() => void signIn(status.provider)} title={status.found ? `Signs in with ${status.name}'s own login, in your browser` : `Install ${status.name} first`}>{signing[status.provider] ? 'Signing in…' : 'Sign in'}</button>
            )}
          </div>
        );
      })}
      </div>
    </section>
  );
}

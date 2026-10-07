import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Connectors } from './Connectors';
import { Updates } from './Updates';
import { whenAwayOn, type AppInfo, type AppSettings, type CliProvider } from '../shared/ipc';
import type { ThemeSetting } from '../shared/theme';

const themes: Array<{ value: ThemeSetting; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];
const providers: Array<{ id: CliProvider; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

interface Props {
  settings: AppSettings;
  info?: AppInfo;
  onTheme(theme: ThemeSetting): void;
  onDisplayName(name: string): void;
  onWhenAway(on: boolean): void;
  onPickCli(provider: CliProvider): void;
  onClearCli(provider: CliProvider): void;
  setup: ReactNode;
}

export function SettingsView({ settings, info, onTheme, onDisplayName, onWhenAway, onPickCli, onClearCli, setup }: Props) {
  const [name, setName] = useState(settings.displayName ?? '');
  useEffect(() => { setName(settings.displayName ?? ''); }, [settings.displayName]);
  const saveName = () => { if (name.trim() !== (settings.displayName ?? '')) onDisplayName(name); };
  return (
    <section className="settings">
      <h1>Settings</h1>
      <h2>You</h2>
      <div className="setting">
        <label className="setting-label" htmlFor="display-name">Display name</label>
        <input id="display-name" className="setting-input" value={name} maxLength={60} spellCheck={false} placeholder={info?.user ?? 'Your name'}
          onChange={event => setName(event.target.value)} onBlur={saveName} onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur(); } if (event.key === 'Escape') { setName(settings.displayName ?? ''); event.currentTarget.blur(); } }} />
      </div>
      <p className="hint">Shown at the bottom of the sidebar, on this computer only. Leave it empty to use your Windows account's name{info?.user ? ` (${info.user})` : ''}.</p>
      <h2>Appearance</h2>
      <div className="setting">
        <div className="setting-label" id="theme-label">Theme</div>
        <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
          {themes.map(theme => (
            <button key={theme.value} role="radio" aria-checked={settings.theme === theme.value} className={settings.theme === theme.value ? 'active' : ''} onClick={() => onTheme(theme.value)}>{theme.label}</button>
          ))}
        </div>
      </div>
      <h2>Notifications</h2>
      <div className="setting">
        <div className="setting-label" id="when-away-label">Tell me when I'm away</div>
        <div className="setting-value">
          <input type="checkbox" aria-labelledby="when-away-label" checked={whenAwayOn(settings)} onChange={event => onWhenAway(event.target.checked)} />
        </div>
      </div>
      <p className="hint">When something needs you and Hydra isn't the window you're looking at, or you've been away from the computer for 5 minutes, Windows shows one banner naming the project and the chat or plan. It never shows a question or a summary, and it never says how many things are waiting.</p>
      <h2>Command-line tools</h2>
      <p className="hint">Hydra finds <code>claude</code> and <code>codex</code> on your PATH. Choose a program here only to use a different one. This setting belongs to this computer; a project can never change it.</p>
      {providers.map(provider => {
        const chosen = settings.cliPaths[provider.id];
        return (
          <div className="setting" key={provider.id}>
            <div className="setting-label">{provider.label}</div>
            <div className="setting-value">
              <span className="path" title={chosen}>{chosen ?? 'From PATH'}</span>
              <button onClick={() => onPickCli(provider.id)}>Choose…</button>
              {chosen && <button onClick={() => onClearCli(provider.id)}>Use PATH</button>}
            </div>
          </div>
        );
      })}
      <Connectors />
      {setup}
      <Updates />
      {info && <p className="about">Hydra {info.version} · Electron {info.electron}</p>}
    </section>
  );
}

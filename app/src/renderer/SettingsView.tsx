import type { AppInfo, AppSettings, CliProvider } from '../shared/ipc';
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
  onPickCli(provider: CliProvider): void;
  onClearCli(provider: CliProvider): void;
}

export function SettingsView({ settings, info, onTheme, onPickCli, onClearCli }: Props) {
  return (
    <section className="settings">
      <h1>Settings</h1>
      <h2>Appearance</h2>
      <div className="setting">
        <div className="setting-label" id="theme-label">Theme</div>
        <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
          {themes.map(theme => (
            <button key={theme.value} role="radio" aria-checked={settings.theme === theme.value} className={settings.theme === theme.value ? 'active' : ''} onClick={() => onTheme(theme.value)}>{theme.label}</button>
          ))}
        </div>
      </div>
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
      {info && <p className="about">Hydra {info.version} · Electron {info.electron}</p>}
    </section>
  );
}

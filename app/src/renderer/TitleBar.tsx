import { Icon } from './Icon';

/** The window's title bar: drag area, sidebar toggle, and the Chat / Agents switch. Windows draws its own buttons on the right. */
export function TitleBar({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
  return (
    <header className="titlebar">
      <button className="icon-button no-drag" onClick={onToggleSidebar} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
        <Icon name="sidebar" />
      </button>
      <div className="mode-switch no-drag" role="group" aria-label="Mode">
        <button aria-pressed="true" className="mode active">Chat</button>
        <button aria-pressed="false" className="mode" disabled title="Agents arrive in a later version">Agents</button>
      </div>
      <div className="titlebar-title">Hydra</div>
    </header>
  );
}

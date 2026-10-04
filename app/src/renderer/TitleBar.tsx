import { Icon } from './Icon';

/** The window's title bar: drag area, sidebar toggle, and the Chat / Agents switch. Windows draws its own buttons on the right. */
export function TitleBar({ sidebarOpen, onToggleSidebar, mode, onMode }: { sidebarOpen: boolean; onToggleSidebar: () => void; mode: 'chat' | 'agents'; onMode: (mode: 'chat' | 'agents') => void }) {
  return (
    <header className="titlebar">
      <button className="icon-button no-drag" onClick={onToggleSidebar} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
        <Icon name="sidebar" />
      </button>
      <div className="mode-switch no-drag" role="group" aria-label="Mode">
        <button aria-pressed={mode === 'chat'} className={`mode ${mode === 'chat' ? 'active' : ''}`} onClick={() => onMode('chat')}>Chat</button>
        <button aria-pressed={mode === 'agents'} className={`mode ${mode === 'agents' ? 'active' : ''}`} onClick={() => onMode('agents')} title="Heads, plans and lanes for the open project">Agents</button>
      </div>
      <div className="titlebar-title">Hydra</div>
    </header>
  );
}

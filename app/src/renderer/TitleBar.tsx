import { Icon } from './Icon';

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  mode: 'chat' | 'agents';
  onMode(mode: 'chat' | 'agents'): void;
  /** Claude desktop's ← →: through the chats and screens visited. */
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
}

/**
 * The window's title bar, as Claude desktop's: sidebar toggle, back and forward, and Chat / Agents as two icons; then
 * the open chat's header. Windows draws its own buttons on the right.
 */
export function TitleBar({ sidebarOpen, onToggleSidebar, mode, onMode, canBack, canForward, onBack, onForward }: Props) {
  return (
    <header className={`titlebar ${sidebarOpen ? 'with-sidebar' : ''}`}>
      <div className="titlebar-side">
        <button className="icon-button no-drag" onClick={onToggleSidebar} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
          <Icon name="sidebar" />
        </button>
        <button className="icon-button no-drag nav-button" onClick={onBack} disabled={!canBack} aria-label="Back" title="Back"><Icon name="arrowLeft" /></button>
        <button className="icon-button no-drag nav-button" onClick={onForward} disabled={!canForward} aria-label="Forward" title="Forward"><Icon name="arrowRight" /></button>
        <div className="mode-switch no-drag" role="group" aria-label="Mode">
          {/* The words stay for screen readers (and the smoke test); the pill shows only the icons. */}
          <button aria-pressed={mode === 'chat'} className={`mode ${mode === 'chat' ? 'active' : ''}`} onClick={() => onMode('chat')} title="Chat"><Icon name="chat" /><span className="sr-only">Chat</span></button>
          <button aria-pressed={mode === 'agents'} className={`mode ${mode === 'agents' ? 'active' : ''}`} onClick={() => onMode('agents')} title="Agents: heads, plans and lanes for the open project"><Icon name="agents" /><span className="sr-only">Agents</span></button>
        </div>
      </div>
      {/* The open chat's header lands here (ChatPane), as in Claude desktop's title bar; otherwise the app's name. */}
      <div id="titlebar-slot" className="titlebar-main"><div className="titlebar-title">Hydra</div></div>
    </header>
  );
}

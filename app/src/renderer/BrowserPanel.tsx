import { useEffect, useRef, useState } from 'react';
import type { BrowserState } from '../shared/ipc';
import { Icon } from './Icon';

/**
 * The browser beside a chat, as Claude desktop's globe opens: back, forward, reload, an address bar and close, over
 * the page main lays into this panel's space (browserPanel.ts). `covered` hides the page while a dialog is over it.
 */
export function BrowserPanel({ state, covered, onClose }: { state: BrowserState; covered: boolean; onClose(): void }) {
  const surface = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(state.url);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string>();
  useEffect(() => { if (!editing) setAddress(state.url); }, [state.url, editing]);
  // Tell main where the page goes whenever the panel moves or resizes; nothing while something covers it.
  useEffect(() => {
    const place = () => {
      const box = surface.current?.getBoundingClientRect();
      const bounds = !box || covered ? { x: 0, y: 0, width: 0, height: 0 } : { x: box.left, y: box.top, width: box.width, height: box.height };
      void window.hydra.browserBounds(bounds).catch(() => undefined);
    };
    place();
    const observer = new ResizeObserver(place);
    if (surface.current) observer.observe(surface.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [covered]);
  const go = () => {
    setProblem(undefined);
    void window.hydra.browserNavigate(address).then(() => setEditing(false), (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  return (
    <aside className="browser-panel" aria-label="Browser">
      <div className="browser-bar">
        <button className="browser-button" onClick={() => void window.hydra.browserBack()} disabled={!state.canGoBack} aria-label="Back" title="Back"><Icon name="arrowLeft" /></button>
        <button className="browser-button" onClick={() => void window.hydra.browserForward()} disabled={!state.canGoForward} aria-label="Forward" title="Forward"><Icon name="arrowRight" /></button>
        <button className="browser-button" onClick={() => void window.hydra.browserReload()} disabled={!state.url} aria-label="Reload" title="Reload"><Icon name="reload" /></button>
        <input className="browser-address" value={address} placeholder="Enter a URL, or localhost:3000" aria-label="Address" spellCheck={false}
          onFocus={event => { setEditing(true); event.currentTarget.select(); }} onBlur={() => setEditing(false)}
          onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') go(); if (event.key === 'Escape') { setAddress(state.url); event.currentTarget.blur(); } }} />
        <button className="browser-button" onClick={onClose} aria-label="Close the browser" title="Close"><Icon name="close" /></button>
      </div>
      {problem && <div className="browser-problem" role="alert">{problem}</div>}
      <div className="browser-surface" ref={surface}>{!state.url && <p className="hint">Type an address above. Pages open here, apart from Hydra: they can't reach your chats or files.</p>}</div>
    </aside>
  );
}

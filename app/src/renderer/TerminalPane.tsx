import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { subscribe } from './terminalBus';
import { AttachButton } from './AttachButton';

/** The theme's colours for xterm, read from the app's CSS variables, so the terminal matches light and dark. */
function terminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { background: v('--bg', '#141414'), foreground: v('--fg', '#ECECEC'), cursor: v('--fg', '#ECECEC'), selectionBackground: v('--selected-bg', '#292929') };
}

/**
 * A terminal inside the chat (xterm.js, as the IDE's lanes use): the CLI main started, its output and the user's keys.
 * It fits its box and tells main the new size.
 */
export function TerminalPane({ id, ended = 'Claude Code', attach }: { id: string; ended?: string; /** Selected text can be attached to this chat's next message, as "Terminal n" (tab index `tab`). */ attach?: { chatId: string; tab: number; n: number } }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ clearSelection(): void } | undefined>(undefined);
  const [selection, setSelection] = useState('');
  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined as void;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !host.current) return;
      const term = new Terminal({ fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, cursorBlink: true, theme: terminalTheme(), scrollback: 5000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      const resize = () => {
        try { fit.fit(); } catch { return; }
        void window.hydra.terminalResize(id, term.cols, term.rows).catch(() => undefined);
      };
      termRef.current = term;
      const selecting = term.onSelectionChange(() => setSelection(term.hasSelection() ? term.getSelection() : ''));
      resize();
      const feed = subscribe(id, message => {
        if (message.data !== undefined) term.write(message.data);
        if (message.exit !== undefined) term.write(`\r\n\x1b[2m[${ended} ended (${message.exit}).]\x1b[0m\r\n`);
      });
      if (feed.replay) term.write(feed.replay);
      if (feed.exit !== undefined) term.write(`\r\n\x1b[2m[${ended} ended (${feed.exit}).]\x1b[0m\r\n`);
      const input = term.onData(data => { void window.hydra.terminalWrite(id, data).catch(() => undefined); });
      const observer = new ResizeObserver(() => resize());
      observer.observe(host.current);
      term.focus();
      cleanup = () => { termRef.current = undefined; selecting.dispose(); observer.disconnect(); input.dispose(); feed.stop(); term.dispose(); };
    })();
    return () => { disposed = true; cleanup(); };
  }, [id, ended]);
  return (
    <div className="terminal-pane" ref={host}>
      {attach && selection.trim() && <AttachButton chatId={attach.chatId} item={{ source: 'Terminal', label: `Terminal ${attach.n}`, tab: attach.tab, text: selection }} onDone={() => { termRef.current?.clearSelection(); setSelection(''); }} />}
    </div>
  );
}

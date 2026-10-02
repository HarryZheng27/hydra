import { useEffect, useState } from 'react';
import type { AppInfo } from '../shared/ipc';

export function App() {
  const [info, setInfo] = useState<AppInfo>();
  useEffect(() => { void window.hydra.appInfo().then(setInfo, () => undefined); }, []);
  return (
    <main className="empty">
      <h1>Hydra</h1>
      <p>{info ? `Version ${info.version}` : ' '}</p>
    </main>
  );
}

import type { ClientMessage } from '../src/core/model';

/**
 * How the Agents view talks to the program it runs in (docs/internal/hydra-app/G2-host-split.md). The Hydra app
 * injects `window.hydraBridge` before this script runs; the IDE's webview has none, so the view uses VS Code's own
 * webview API. Messages back from the host arrive as `message` events on `window` in both.
 */
export interface HydraBridge {
  postMessage(message: ClientMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global { interface Window { hydraBridge?: HydraBridge } }
declare function acquireVsCodeApi(): HydraBridge;

export function hostBridge(): HydraBridge {
  return window.hydraBridge ?? acquireVsCodeApi();
}

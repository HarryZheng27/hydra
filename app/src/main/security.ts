import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebPreferences } from 'electron';

/**
 * The renderer's security baseline (docs/THREAT_MODEL.md, "The Hydra app (unreleased)"). Everything here takes plain
 * interfaces rather than Electron objects, so tests/security.test.ts can run it in Node.
 */

/** The app's pages come from app://hydra/, never file:// or the network. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'hydra';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/index.html`;

/**
 * G1's CSP (docs/internal/hydra-app/G1-spikes.md, S4 item 4): no remote anything, scripts and workers only from the
 * app, Trusted Types for script sinks. Inline styles are allowed because Monaco and xterm insert <style> elements.
 * It rides on every app:// response, since a worker takes its CSP from its own response.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types hydraWorker defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer editorViewLayer richScreenReaderContent standaloneColorizer tokenizeToString stickyScrollViewLayer editorGhostText dompurify',
].join('; ');

/** The web preferences every app window uses. */
export const hardenedWebPreferences = (preload: string): WebPreferences => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  spellcheck: false,
});

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};
const baseHeaders = { 'content-security-policy': CONTENT_SECURITY_POLICY, 'x-content-type-options': 'nosniff' };

/** Resolves an app:// URL to a file inside `root`, or undefined for another host or a path that escapes it. */
export function resolveAppFile(root: string, requestUrl: string): string | undefined {
  let url: URL;
  try { url = new URL(requestUrl); } catch { return undefined; }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined;
  let rel: string;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return undefined; }
  const base = path.resolve(root);
  const file = path.resolve(base, rel || 'index.html');
  return file.startsWith(base + path.sep) ? file : undefined;
}

/** Serves one app:// request from the built renderer folder, with the CSP on every response. */
export async function serveAppRequest(root: string, requestUrl: string): Promise<Response> {
  const file = resolveAppFile(root, requestUrl);
  if (!file) return new Response('Forbidden', { status: 403, headers: baseHeaders });
  let body: Buffer;
  try { body = await fs.readFile(file); } catch { return new Response('Not found', { status: 404, headers: baseHeaders }); }
  return new Response(new Uint8Array(body), { status: 200, headers: { ...baseHeaders, 'content-type': contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
}

/** An http(s) link the user may open in their browser, normalized, or undefined for anything else. */
export function externalLink(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  return url.href;
}

/** Network requests the app's sessions may make: only the app's own scheme, and in-memory data. */
export function requestAllowed(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST;
  return url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'devtools:';
}

/** The parts of a webContents the guards use. */
export interface GuardedContents {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

/**
 * Guards every webContents the app creates: no navigation away from the page, no redirects, no <webview>, and no
 * new windows. An http(s) link a page tries to open goes to `confirmExternal`, which asks before the browser opens it.
 */
export function guardContents(contents: GuardedContents, confirmExternal: (url: string) => void): void {
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const link = externalLink(url);
    if (link) confirmExternal(link);
    return { action: 'deny' };
  });
}

/** The parts of a session the guards use. */
export interface GuardedSession {
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  webRequest: { onBeforeRequest(listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void): void };
}

/** Refuses every permission prompt (camera, notifications, clipboard, ...) and every request off the app's scheme. */
export function guardSession(session: GuardedSession): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !requestAllowed(details.url) }));
}

export interface ConfirmDeps {
  ask(url: string): Promise<boolean>;
  open(url: string): Promise<void>;
}

/** Opens an http(s) link in the user's browser only after they confirm it. Returns whether it was opened. */
export async function confirmAndOpen(raw: string, deps: ConfirmDeps): Promise<boolean> {
  const link = externalLink(raw);
  if (!link || !(await deps.ask(link))) return false;
  await deps.open(link);
  return true;
}

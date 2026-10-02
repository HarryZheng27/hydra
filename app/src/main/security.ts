import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebPreferences } from 'electron';

/** The app's pages come from app://hydra/, never file:// or the network. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'hydra';
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

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

/** Serves one app:// request from the built renderer folder. */
export async function serveAppRequest(root: string, requestUrl: string): Promise<Response> {
  const file = resolveAppFile(root, requestUrl);
  if (!file) return new Response('Forbidden', { status: 403 });
  let body: Buffer;
  try { body = await fs.readFile(file); } catch { return new Response('Not found', { status: 404 }); }
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
}

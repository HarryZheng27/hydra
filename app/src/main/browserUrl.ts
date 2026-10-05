/** What the browser panel may load (browserPanel.ts), kept free of Electron so it can be tested on its own. */
const MAX_URL = 2048;
/**
 * What the address bar may load: http and https only, without credentials. A bare host gets https://, except
 * localhost and 127.0.0.1, which get http:// (a dev server). Anything else is refused.
 */
export function browserUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text || text.length > MAX_URL || /\s/.test(text)) return undefined;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text);
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^(localhost|127\.0\.0\.1)(:\d+)/i.test(text) ? text : `${local ? 'http' : 'https'}://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return undefined; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return undefined;
  return url.href.length <= MAX_URL ? url.href : undefined;
}

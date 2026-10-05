/**
 * Notes the app shows until the user has done the thing once (the Cloud note before a first cloud chat). Kept in the
 * window's local storage; without it, the note shows again, which is the safe side.
 */
const prefix = 'hydra.seen.';

export function seen(note: string): boolean {
  try { return window.localStorage.getItem(prefix + note) === '1'; } catch { return false; }
}

export function markSeen(note: string): void {
  try { window.localStorage.setItem(prefix + note, '1'); } catch { /* shown again next time */ }
}

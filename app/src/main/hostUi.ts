import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InputOptions, NoticeLevel, PickItem } from '../../../src/host/host';
import type { HydraHostMessage, HydraViewImage } from '../shared/ipc';

/**
 * Hydra's own questions, notices and read-only documents in the app's window (G5 milestone 3), where the IDE uses its
 * quick picks, input boxes, notifications and editor tabs. Main sends each over HYDRA_HOST and the window answers a
 * question through `hydra.reply`. Only text and images main read itself reach the page: never a path to load, a URL
 * or HTML. A question the window never answers stays pending until the project stops (`cancelAll`), as an unanswered
 * quick pick would.
 */
export const VIEW_TEXT_LIMIT = 2_000_000;
export const VIEW_IMAGE_LIMIT = 5_000_000;
export const VIEW_IMAGES_MAX = 20;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

interface Pending { resolve: (value: unknown) => void; projectId: string; check?: (value: unknown) => string | undefined; message: HydraHostMessage }

export class HostUi {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly send: (message: HydraHostMessage) => void) {}

  /** One of the IDE's quick picks: resolves with the chosen item, or undefined when dismissed. */
  pick<T extends PickItem>(projectId: string, items: T[], options: { title?: string; placeHolder?: string }): Promise<T | undefined> {
    return this.ask(projectId, { kind: 'pick', title: options.title ?? '', placeHolder: options.placeHolder ?? '', items: items.map(itemView), many: false }, value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < items.length ? undefined : 'Pick one of the items.')
      .then(value => (value === undefined ? undefined : items[value as number]));
  }
  pickMany<T extends PickItem>(projectId: string, items: T[], options: { title?: string; placeHolder?: string }): Promise<T[] | undefined> {
    return this.ask(projectId, { kind: 'pick', title: options.title ?? '', placeHolder: options.placeHolder ?? '', items: items.map(itemView), many: true }, value => Array.isArray(value) && value.length <= items.length && value.every(index => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < items.length) ? undefined : 'Pick from the items.')
      .then(value => (value === undefined ? undefined : [...new Set(value as number[])].sort((a, b) => a - b).map(index => items[index]!)));
  }
  /** An input box. Its validation runs here, in main: a value it refuses is asked again with the reason. */
  input(projectId: string, options: InputOptions): Promise<string | undefined> {
    return this.ask(projectId, { kind: 'input', title: options.title ?? '', prompt: options.prompt ?? '', placeHolder: options.placeHolder ?? '', value: options.value ?? '' },
      value => (typeof value !== 'string' || value.length > 20_000 ? 'Type an answer.' : options.validateInput?.(value)))
      .then(value => value as string | undefined);
  }
  /** A notice; with actions, resolves with the one the user clicked (undefined when dismissed). */
  notice(projectId: string, level: NoticeLevel, message: string, actions: string[]): Promise<string | undefined> {
    if (!actions.length) { this.send({ kind: 'notice', projectId, level, message: message.slice(0, 2000), actions: [] }); return Promise.resolve(undefined); }
    return this.ask(projectId, { kind: 'notice', level, message: message.slice(0, 2000), actions }, value => (typeof value === 'string' && actions.includes(value) ? undefined : 'Pick an action.'))
      .then(value => value as string | undefined);
  }
  /** A read-only document in the window's viewer. */
  view(projectId: string, view: { title: string; format: 'text' | 'markdown' | 'diff'; content: string; images?: HydraViewImage[] }): void {
    this.send({ kind: 'view', projectId, title: view.title.slice(0, 300), format: view.format, content: view.content.slice(0, VIEW_TEXT_LIMIT), images: view.images ?? [] });
  }

  /** The window's answer to a question; anything that isn't a pending question's id, or a valid answer, is dropped. */
  reply(requestId: string, value: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (value === null || value === undefined) { this.pending.delete(requestId); pending.resolve(undefined); return; }
    const problem = pending.check?.(value);
    if (problem) { this.send({ ...pending.message, error: problem } as HydraHostMessage); return; }
    this.pending.delete(requestId);
    pending.resolve(value);
  }
  /** A project stopped: its open questions are dismissed, and the window drops them. */
  cancelAll(projectId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.projectId !== projectId) continue;
      this.pending.delete(id);
      this.send({ kind: 'dismiss', requestId: id });
      pending.resolve(undefined);
    }
  }

  private ask(projectId: string, question: DistributiveOmit<Extract<HydraHostMessage, { kind: 'pick' | 'input' | 'notice' }>, 'requestId' | 'projectId'>, check: (value: unknown) => string | undefined): Promise<unknown> {
    const requestId = randomUUID();
    const message = { ...question, requestId, projectId } as HydraHostMessage;
    return new Promise(resolve => {
      this.pending.set(requestId, { resolve, projectId, check, message });
      this.send(message);
    });
  }
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const itemView = (item: PickItem) => ({ label: item.label.slice(0, 500), description: item.description?.slice(0, 500) ?? '', detail: item.detail?.slice(0, 1000) ?? '', picked: !!item.picked });

/** A file Hydra wrote or keeps (a log, a report, evidence) as the viewer shows it: its text, or its last part when large. */
export async function readViewFile(file: string): Promise<{ content: string; truncated: boolean }> {
  const size = (await stat(file)).size;
  if (size <= VIEW_TEXT_LIMIT) return { content: await readFile(file, 'utf8'), truncated: false };
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(VIEW_TEXT_LIMIT);
    await handle.read(buffer, 0, VIEW_TEXT_LIMIT, size - VIEW_TEXT_LIMIT);
    const text = buffer.toString('utf8');
    return { content: text.slice(text.indexOf('\n') + 1), truncated: true };
  } finally { await handle.close(); }
}

const inside = (root: string, file: string): boolean => { const relative = path.relative(root, file); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

/**
 * Evidence Markdown's images (gate screenshots), read by main as data: URLs, and the Markdown without them. Only
 * images inside the document's own folder, of an image type, under the size limit, are read; any other image line
 * stays as text. Links stay text too.
 */
export async function markdownWithImages(markdown: string, base: string): Promise<{ content: string; images: HydraViewImage[] }> {
  const images: HydraViewImage[] = [];
  const root = await realpath(base).catch(() => path.resolve(base));
  const lines: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\s*!\[([^\]\n]{0,300})\]\(<?([^)>\n]{1,1000})>?\)\s*$/.exec(line);
    if (!match || images.length >= VIEW_IMAGES_MAX) { lines.push(line); continue; }
    // evidence.ts writes each segment with encodeURIComponent.
    let target: string;
    try { target = match[2]!.split('/').map(decodeURIComponent).join('/'); } catch { lines.push(line); continue; }
    const type = IMAGE_TYPES[path.extname(target).toLowerCase()];
    const file = await realpath(path.resolve(root, target)).catch(() => undefined);
    if (!type || !file || !inside(root, file)) { lines.push(line); continue; }
    const size = await stat(file).then(info => (info.isFile() ? info.size : Infinity), () => Infinity);
    if (size > VIEW_IMAGE_LIMIT) { lines.push(line); continue; }
    images.push({ alt: match[1] || path.basename(file), src: `data:${type};base64,${(await readFile(file)).toString('base64')}` });
    lines.push(`*Screenshot ${images.length}: ${match[1] || path.basename(file)}*`);
  }
  return { content: lines.join('\n'), images };
}

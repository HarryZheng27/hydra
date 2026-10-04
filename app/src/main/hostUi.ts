import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
/** All of one document's images together, so one view stays a modest message. */
export const VIEW_IMAGES_TOTAL = 25_000_000;
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
  /** The window (re)loaded: every open question is shown again, so none waits on a page that lost it. */
  resendAll(): void { for (const pending of this.pending.values()) this.send(pending.message); }
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

/** A lane's preview, opened in the user's browser only when it is a page on this machine (http or https). */
export function localPreviewUrl(url: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return undefined;
  return parsed.href;
}

/**
 * One file's change as a unified diff, by git itself (`git diff --no-index` over two scratch files), labelled with the
 * file's name. Text only: a file is cut at the view's limit first.
 */
export async function unifiedDiff(name: string, before: string, after: string): Promise<string> {
  if (before === after) return '';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hydra-diff-'));
  try {
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    await writeFile(a, before.slice(0, VIEW_TEXT_LIMIT)); await writeFile(b, after.slice(0, VIEW_TEXT_LIMIT));
    const output = await new Promise<string>(resolve => execFile('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', a, b], { cwd: dir, windowsHide: true, maxBuffer: VIEW_TEXT_LIMIT * 4, encoding: 'utf8' },
      (_error, stdout) => resolve(stdout ?? '')));
    // git names the scratch files; the reader wants the project's file.
    const lines = output.split('\n');
    const body = lines.slice(lines.findIndex(line => line.startsWith('@@')));
    return [`diff ${name}`, `--- a/${name}`, `+++ b/${name}`, ...(body[0]?.startsWith('@@') ? body : ['(binary or unreadable)'])].join('\n');
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

const inside = (root: string, file: string): boolean => { const relative = path.relative(root, file); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

/**
 * A relative image path as evidence.ts writes one, checked by its text alone before anything touches the disk: plain
 * segments (letters, digits, space, `.`, `_`, `-`, parentheses), no `.` or `..` segment, nothing absolute, no drive,
 * no share, no backslash, no colon. Anything else (a `//host/share` path, `%5C` escapes, `C:/…`) is never resolved,
 * so the disk, or a network share, is never asked about it.
 */
export function safeRelativeImagePath(target: string): string | undefined {
  const segments = target.split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[\p{L}\p{N} ._()-]{1,200}$/u.test(segment))) return undefined;
  return segments.join(path.sep);
}

/**
 * Evidence Markdown's images (gate screenshots), read by main as data: URLs, and the Markdown without them. Only an
 * image line outside a code fence whose path passes safeRelativeImagePath, inside the document's own folder once
 * resolved (links followed), of an image type and under the size limits, is read; any other stays as text. A gate's
 * output is quoted inside a fence, so a head can't name an image there. Links stay text too.
 */
export async function markdownWithImages(markdown: string, base: string): Promise<{ content: string; images: HydraViewImage[] }> {
  const images: HydraViewImage[] = [];
  const root = await realpath(base).catch(() => path.resolve(base));
  const lines: string[] = [];
  let fence: string | undefined, total = 0;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) { fence = fence ? undefined : marker; lines.push(line); continue; }
    const match = fence ? undefined : /^\s*!\[([^\]\n]{0,300})\]\(<?([^)>\n]{1,1000})>?\)\s*$/.exec(line);
    if (!match || images.length >= VIEW_IMAGES_MAX) { lines.push(line); continue; }
    // evidence.ts writes each segment with encodeURIComponent.
    let target: string | undefined;
    try { target = safeRelativeImagePath(match[2]!.split('/').map(decodeURIComponent).join('/')); } catch { target = undefined; }
    const type = target ? IMAGE_TYPES[path.extname(target).toLowerCase()] : undefined;
    const resolved = target ? path.resolve(root, target) : undefined;
    if (!target || !type || !resolved || !inside(root, resolved)) { lines.push(line); continue; }
    // Only now the disk: the real file (a link or junction followed) must still be inside.
    const file = await realpath(resolved).catch(() => undefined);
    if (!file || !inside(root, file)) { lines.push(line); continue; }
    const size = await stat(file).then(info => (info.isFile() ? info.size : Infinity), () => Infinity);
    if (size > VIEW_IMAGE_LIMIT || total + size > VIEW_IMAGES_TOTAL) { lines.push(line); continue; }
    total += size;
    images.push({ alt: match[1] || path.basename(file), src: `data:${type};base64,${(await readFile(file)).toString('base64')}` });
    lines.push(`*Screenshot ${images.length}: ${match[1] || path.basename(file)}*`);
  }
  return { content: lines.join('\n'), images };
}

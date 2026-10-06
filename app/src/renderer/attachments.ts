/**
 * "Attach as context" (Claude desktop's): text the user selected in a terminal or the transcript rides along with
 * their next message as quoted blocks under a comment header, so the model sees where it came from and the transcript
 * can show each block as a chip. Pure, so the format and its parse are tested without a window.
 */
export interface Attachment {
  id: string;
  source: 'Terminal' | 'Chat';
  /** "Terminal 1" or "Quote": the chip's name. */
  label: string;
  /** The terminal tab's index, for a Terminal attachment. */
  tab?: number;
  text: string;
  /** The selection was longer than the cap and was cut. */
  truncated?: boolean;
}

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACH_CHARS = 20_000;

let counter = 0;
const trimEnd = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** An attachment from a selection: line ends normalised, the tail trimmed, cut at the cap; undefined when nothing is left. */
export function newAttachment(input: { source: Attachment['source']; label: string; tab?: number; text: string }): Attachment | undefined {
  const text = trimEnd(input.text);
  if (!text.trim()) return undefined;
  const truncated = text.length > MAX_ATTACH_CHARS;
  return { id: `a${++counter}`, source: input.source, label: input.label, ...(input.tab !== undefined ? { tab: input.tab } : {}), text: truncated ? text.slice(0, MAX_ATTACH_CHARS) : text, ...(truncated ? { truncated } : {}) };
}

export const lineCount = (text: string) => text.split('\n').length;
/** "Terminal 1 · 12 lines": the chip's text. */
export const chipLabel = (item: { label: string; text: string; truncated?: boolean }) => {
  const lines = lineCount(item.text);
  return `${item.label} · ${lines} line${lines === 1 ? '' : 's'}${item.truncated ? ' · cut at 20,000 characters' : ''}`;
};

const header = (item: Pick<Attachment, 'source' | 'tab'>) => (item.source === 'Terminal' ? `<!-- attach: Terminal | tab:${item.tab ?? 0} -->` : '<!-- attach: Quote -->');
const quote = (text: string) => trimEnd(text).slice(0, MAX_ATTACH_CHARS).split('\n').map(line => `> ${line}`).join('\n');

/** The message to send: each attachment as its header and quoted lines, then the user's text. */
export function formatAttachments(items: readonly Attachment[], text: string): string {
  const blocks = items.slice(0, MAX_ATTACHMENTS).map(item => `${header(item)}\n${quote(item.text)}`);
  return [...blocks, ...(text.trim() || !blocks.length ? [text] : [])].join('\n\n');
}

export interface ParsedAttachment { source: 'Terminal' | 'Chat'; label: string; tab?: number; text: string; truncated?: boolean }

const headerLine = /^<!-- attach: (?:(Terminal) \| tab:(\d{1,4})|(Quote)) -->$/;

/**
 * The attach blocks a message starts with, and the rest. Only the exact header at the very start (or straight after
 * another block) counts, and its quoted lines must end at a blank line or the end; anything else, such as a header
 * pasted mid-message, stays text. The result is plain strings: nothing here is ever rendered as HTML.
 */
export function parseAttachments(message: string): { attachments: ParsedAttachment[]; rest: string } {
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  const attachments: ParsedAttachment[] = [];
  let i = 0;
  while (attachments.length < MAX_ATTACHMENTS) {
    const match = headerLine.exec(lines[i] ?? '');
    if (!match) break;
    let j = i + 1;
    const quoted: string[] = [];
    while (j < lines.length && (lines[j]!.startsWith('> ') || lines[j] === '>')) { quoted.push(lines[j]!.slice(2)); j++; }
    if (!quoted.length || (j < lines.length && lines[j] !== '')) break;
    const text = quoted.join('\n');
    const truncated = text.length > MAX_ATTACH_CHARS;
    const tab = match[2] !== undefined ? Number(match[2]) : undefined;
    attachments.push({ source: match[1] ? 'Terminal' : 'Chat', label: match[1] ? `Terminal ${(tab ?? 0) + 1}` : 'Quote', ...(tab !== undefined ? { tab } : {}), text: truncated ? text.slice(0, MAX_ATTACH_CHARS) : text, ...(truncated ? { truncated } : {}) });
    i = j + 1;
  }
  return { attachments, rest: lines.slice(i).join('\n') };
}

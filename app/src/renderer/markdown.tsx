import type { ReactNode } from 'react';

/**
 * Model and tool output as markdown, built straight into React elements: no HTML string is ever parsed or set, so
 * raw HTML, scripts and event handlers in a reply show as text. Links work only for http(s); a click goes through
 * window.open, which main denies and turns into its own confirm (HSEC-77). Everything else is plain text.
 * Supported: headings, paragraphs, fenced code, block quotes, lists, rules, and inline code, bold, italic and links.
 */
export function safeHref(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return undefined; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
  return url.href;
}

function openLink(href: string) { window.open(href, '_blank'); }

// Keys restart for each message, so re-rendering the same text (as it streams) keeps its elements.
let keySeed = 0;
const key = () => `md${keySeed++}`;
/** Longer lines show as plain text: inline markdown is never parsed in them, so hostile input can't stall the page. */
const MAX_INLINE = 4000;

/** Inline markdown: code spans first (their content is literal), then links, bold and italic. */
export function inline(text: string): ReactNode[] {
  if (text.length > MAX_INLINE) return [text];
  const out: ReactNode[] = [];
  const pattern = /(`{1,8})([^`]{1,4000}?)\1(?!`)|\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1]) out.push(<code key={key()}>{match[2]}</code>);
    else if (match[3] !== undefined) {
      const href = safeHref(match[4]!);
      out.push(href
        ? <a key={key()} href={href} title={href} onClick={event => { event.preventDefault(); openLink(href); }}>{inline(match[3])}</a>
        : <span key={key()} className="unsafe-link" title="Hydra doesn't open this kind of link">{match[0]}</span>);
    } else if (match[5] ?? match[6]) out.push(<strong key={key()}>{inline((match[5] ?? match[6])!)}</strong>);
    else out.push(<em key={key()}>{inline((match[7] ?? match[8])!)}</em>);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  keySeed = 0;
  return <div className="markdown">{blocks(text)}</div>;
}

export function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A fence: ``` or ~~~ and an optional language word. Checked by trimming, not by a backtracking pattern.
    const trimmed = line.length <= 200 ? line.trim() : '';
    const opener = /^(`{3,}|~{3,})/.exec(trimmed);
    const fence = opener && /^[\w+-]*$/.test(trimmed.slice(opener[1]!.length).trim()) ? [line, opener[1]!, trimmed.slice(opener[1]!.length).trim()] as const : undefined;
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push(<pre key={key()} className="code" data-lang={fence[2] || undefined}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const Tag = `h${level}` as 'h3';
      out.push(<Tag key={key()}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (line.length <= 200 && /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(<hr key={key()} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key()}>{blocks(quote.join('\n'))}</blockquote>);
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[][] = [];
      while (i < lines.length && (bullet.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        if (bullet.test(lines[i]!)) items.push([lines[i]!.replace(bullet, '')]); else items.at(-1)!.push(lines[i]!.trim());
        i++;
      }
      const children = items.map(item => <li key={key()}>{inline(item.join(' '))}</li>);
      out.push(ordered ? <ol key={key()}>{children}</ol> : <ul key={key()}>{children}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s)/.test(lines[i]!)) paragraph.push(lines[i++]!);
    if (!paragraph.length) paragraph.push(lines[i++]!);
    out.push(<p key={key()}>{paragraph.flatMap((part, index) => (index ? [<br key={key()} />, ...inline(part)] : inline(part)))}</p>);
  }
  return out;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_ATTACH_CHARS, MAX_ATTACHMENTS, chipLabel, formatAttachments, newAttachment, parseAttachments } from '../src/renderer/attachments';
import { attach, clear, pendingFor, remove, subscribe } from '../src/renderer/contextBus';
import { UserMessage } from '../src/renderer/ChatPane';

const terminal = (text: string, tab = 0) => newAttachment({ source: 'Terminal', label: `Terminal ${tab + 1}`, tab, text })!;
const quote = (text: string) => newAttachment({ source: 'Chat', label: 'Quote', text })!;

test('attachments are quoted line by line ahead of the message, in Claude desktop\'s format', () => {
  const message = formatAttachments([terminal('line 1\nline 2'), quote('a\n\nb')], 'what happened?');
  assert.equal(message, '<!-- attach: Terminal | tab:0 -->\n> line 1\n> line 2\n\n<!-- attach: Quote -->\n> a\n> \n> b\n\nwhat happened?');
  assert.equal(formatAttachments([], 'plain'), 'plain');
  // Attachments alone are a message.
  assert.equal(formatAttachments([quote('x')], ''), '<!-- attach: Quote -->\n> x');
});

test('a formatted message parses back to its attachments and text', () => {
  const items = [terminal('PS C:\> npm test\n  ok 1\n\n  ok 2', 2), quote('one line')];
  const parsed = parseAttachments(formatAttachments(items, 'why did it fail?\n> not a quote'));
  assert.deepEqual(parsed.attachments.map(a => [a.source, a.label, a.tab, a.text]), [['Terminal', 'Terminal 3', 2, 'PS C:\> npm test\n  ok 1\n\n  ok 2'], ['Chat', 'Quote', undefined, 'one line']]);
  assert.equal(parsed.rest, 'why did it fail?\n> not a quote');
  assert.deepEqual(parseAttachments(formatAttachments([quote('x')], '')).rest, '');
  assert.equal(parseAttachments('hello').attachments.length, 0);
});

test('only the exact header at the start counts: a fake header mid-message, or a malformed block, stays text', () => {
  const mid = 'look at this\n<!-- attach: Quote -->\n> sneaky';
  assert.deepEqual(parseAttachments(mid), { attachments: [], rest: mid });
  for (const bad of ['<!-- attach: Quote --> \n> x', '<!-- attach: Other -->\n> x', '<!--attach: Quote-->\n> x', '<!-- attach: Quote -->\nnot quoted', '<!-- attach: Quote -->\n> x\ntext right after', ' <!-- attach: Quote -->\n> x', '<!-- attach: Terminal | tab:x -->\n> x', '<!-- attach: Quote | tab:1 -->\n> x', '<!-- attach: Quote -->']) {
    assert.deepEqual(parseAttachments(bad), { attachments: [], rest: bad }, bad);
  }
  // A good block followed by a fake one in the text keeps the fake as text.
  const parsed = parseAttachments('<!-- attach: Quote -->\n> a\n\nsee\n<!-- attach: Quote -->\n> b');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.rest, 'see\n<!-- attach: Quote -->\n> b');
});

test('a quoted line that looks like a header is data, and each attachment is capped at 20,000 characters', () => {
  const nested = parseAttachments(formatAttachments([quote('<!-- attach: Quote -->\n> inner')], 'hi'));
  assert.equal(nested.attachments.length, 1);
  assert.equal(nested.attachments[0]!.text, '<!-- attach: Quote -->\n> inner');
  const big = quote('x'.repeat(MAX_ATTACH_CHARS + 500));
  assert.equal(big.text.length, MAX_ATTACH_CHARS);
  assert.equal(big.truncated, true);
  assert.match(chipLabel(big), /cut at 20,000/);
  assert.equal(parseAttachments(`<!-- attach: Quote -->\n> ${'y'.repeat(MAX_ATTACH_CHARS + 50)}`).attachments[0]!.text.length, MAX_ATTACH_CHARS);
  assert.equal(newAttachment({ source: 'Chat', label: 'Quote', text: '  \n ' }), undefined);
  // No more than eight blocks are read, or sent.
  const many = Array.from({ length: 12 }, (_, i) => quote(`q${i}`));
  assert.equal(parseAttachments(formatAttachments(many, 'end')).attachments.length, MAX_ATTACHMENTS);
});

test('the bus keeps attachments per chat, caps them at eight and tells subscribers', () => {
  let calls = 0;
  const stop = subscribe('chat-a', () => { calls++; });
  const first = quote('one');
  assert.equal(attach('chat-a', first), true);
  assert.deepEqual(pendingFor('chat-b'), []);
  for (let i = 1; i < MAX_ATTACHMENTS; i++) assert.equal(attach('chat-a', quote(`n${i}`)), true);
  assert.equal(attach('chat-a', quote('ninth')), false);
  assert.equal(pendingFor('chat-a').length, MAX_ATTACHMENTS);
  remove('chat-a', first.id);
  assert.equal(pendingFor('chat-a').length, MAX_ATTACHMENTS - 1);
  clear('chat-a');
  assert.deepEqual(pendingFor('chat-a'), []);
  stop();
  attach('chat-a', quote('after stop'));
  assert.equal(calls, MAX_ATTACHMENTS + 2);
  clear('chat-a');
});

test('a sent message with attach blocks renders chips above a bubble of just the text, never HTML', () => {
  const out = renderToStaticMarkup(createElement(UserMessage, { text: formatAttachments([terminal('a\nb\nc', 0), quote('<img src=x onerror=alert(1)>')], 'hello <b>there</b>') }));
  assert.match(out, /Terminal 1 · 3 lines/);
  assert.match(out, /Quote · 1 line</);
  assert.match(out, /<details/);
  assert.ok(out.indexOf('attach-chip') < out.indexOf('class="bubble"'));
  assert.match(out, /<div class="bubble">hello &lt;b&gt;there&lt;\/b&gt;<\/div>/);
  assert.ok(!out.includes('<img') && !out.includes('<b>') && !out.includes('<!-- attach'));
  // Attachments alone: chips, no bubble. Plain messages are unchanged.
  const alone = renderToStaticMarkup(createElement(UserMessage, { text: formatAttachments([quote('x')], '') }));
  assert.ok(alone.includes('attach-chip') && !alone.includes('class="bubble"'));
  assert.equal(renderToStaticMarkup(createElement(UserMessage, { text: 'just text' })), '<div class="msg user"><div class="bubble">just text</div></div>');
});

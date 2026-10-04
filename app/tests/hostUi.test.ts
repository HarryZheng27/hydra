import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HostUi, VIEW_IMAGE_LIMIT, VIEW_TEXT_LIMIT, localPreviewUrl, markdownWithImages, readViewFile, safeRelativeImagePath, unifiedDiff } from '../src/main/hostUi';
import type { HydraHostMessage } from '../src/shared/ipc';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-host-ui-'));
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ff0000000049454e44ae426082', 'hex');

test('a list, a pick of several and a text box are answered by request id; anything else is dropped or asked again', async () => {
  const sent: HydraHostMessage[] = [];
  const ui = new HostUi(message => sent.push(message));
  const items = [{ label: 'One' }, { label: 'Two', description: 'second' }, { label: 'Three', picked: true }];

  const one = ui.pick('p1', items, { title: 'Pick' });
  const ask = sent.at(-1) as Extract<HydraHostMessage, { kind: 'pick' }>;
  assert.deepEqual([ask.kind, ask.many, ask.projectId, ask.items.map(item => item.label), ask.items[2]!.picked], ['pick', false, 'p1', ['One', 'Two', 'Three'], true]);
  ui.reply('not-a-pending-request', 0);
  ui.reply(ask.requestId, 7);
  assert.match((sent.at(-1) as { error?: string }).error ?? '', /Pick one/, 'an index out of range is asked again');
  ui.reply(ask.requestId, 1);
  assert.equal(await one, items[1]);
  ui.reply(ask.requestId, 0); // already answered: dropped

  const many = ui.pickMany('p1', items, { title: 'Several' });
  const manyAsk = sent.at(-1) as Extract<HydraHostMessage, { kind: 'pick' }>;
  ui.reply(manyAsk.requestId, [2, 0, 2]);
  assert.deepEqual(await many, [items[0], items[2]]);

  const text = ui.input('p1', { title: 'Answer', validateInput: value => (value.trim() ? undefined : 'Type an answer first.') });
  const inputAsk = sent.at(-1) as Extract<HydraHostMessage, { kind: 'input' }>;
  ui.reply(inputAsk.requestId, '   ');
  assert.equal((sent.at(-1) as { error?: string }).error, 'Type an answer first.', 'validation runs in main');
  ui.reply(inputAsk.requestId, 42);
  ui.reply(inputAsk.requestId, 'yes');
  assert.equal(await text, 'yes');

  // Dismissed: null.
  const dismissed = ui.pick('p1', items, {});
  ui.reply((sent.at(-1) as { requestId: string }).requestId, null);
  assert.equal(await dismissed, undefined);
});

test('a notice with actions resolves with the one clicked; a project that stops dismisses its open questions', async () => {
  const sent: HydraHostMessage[] = [];
  const ui = new HostUi(message => sent.push(message));
  assert.equal(await ui.notice('p1', 'info', 'Plan finished.', []), undefined, 'a notice that asks nothing resolves at once');
  assert.equal((sent.at(-1) as { requestId?: string }).requestId, undefined);
  const report = ui.notice('p1', 'info', 'Its report is ready.', ['Open report']);
  const notice = sent.at(-1) as Extract<HydraHostMessage, { kind: 'notice' }>;
  ui.reply(notice.requestId!, 'Something else');
  ui.reply(notice.requestId!, 'Open report');
  assert.equal(await report, 'Open report');

  const mine = ui.input('p1', { title: 'Mine' }), theirs = ui.input('p2', { title: 'Theirs' });
  const theirsId = (sent.at(-1) as { requestId: string }).requestId;
  ui.cancelAll('p1');
  assert.equal(await mine, undefined);
  assert.equal(sent.at(-1)!.kind, 'dismiss');
  ui.reply(theirsId, 'still asked');
  assert.equal(await theirs, 'still asked', 'another project\'s question stays');
});

test('a document shows as text, a large file as its last part, and only images inside its own folder are read', async () => {
  const dir = scratch();
  try {
    const small = path.join(dir, 'log.jsonl');
    fs.writeFileSync(small, 'line one\nline two\n');
    assert.deepEqual(await readViewFile(small), { content: 'line one\nline two\n', truncated: false });
    const large = path.join(dir, 'large.log');
    fs.writeFileSync(large, `${'x'.repeat(VIEW_TEXT_LIMIT)}\nthe end\n`);
    const tail = await readViewFile(large);
    assert.equal(tail.truncated, true);
    assert.ok(tail.content.endsWith('the end\n') && tail.content.length <= VIEW_TEXT_LIMIT);

    const evidence = path.join(dir, 'evidence');
    fs.mkdirSync(path.join(evidence, 'shots dir'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'shots dir', 'home page.png'), png);
    fs.writeFileSync(path.join(dir, 'outside.png'), png);
    fs.writeFileSync(path.join(evidence, 'notes.txt'), 'not an image');
    fs.writeFileSync(path.join(evidence, 'huge.png'), Buffer.alloc(VIEW_IMAGE_LIMIT + 1));
    const markdown = ['# Evidence', '', '![home page](shots%20dir/home%20page.png)', '![escape](../outside.png)', '![text](notes.txt)', '![huge](huge.png)', '![absolute](C:/Windows/win.ini)', 'Evidence: [log](log.txt)'].join('\n');
    const view = await markdownWithImages(markdown, evidence);
    assert.equal(view.images.length, 1);
    assert.equal(view.images[0]!.alt, 'home page');
    assert.match(view.images[0]!.src, /^data:image\/png;base64,iVBOR/);
    assert.match(view.content, /\*Screenshot 1: home page\*/);
    for (const kept of ['![escape](../outside.png)', '![text](notes.txt)', '![huge](huge.png)', '![absolute](C:/Windows/win.ini)', 'Evidence: [log](log.txt)']) assert.ok(view.content.includes(kept), kept);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an image path is checked by its text before the disk is asked: no share, drive, escape or fenced line is ever resolved', async () => {
  assert.equal(safeRelativeImagePath('shots/home page.png'), path.join('shots', 'home page.png'));
  for (const unsafe of ['//attacker.example/share/a.png', '\\\\attacker.example\\share\\a.png', 'C:/Windows/a.png', '/etc/a.png', '../a.png', 'shots/../../a.png', './a.png', 'a\\b.png', 'host@80/x:a.png', '']) {
    assert.equal(safeRelativeImagePath(unsafe), undefined, unsafe);
  }
  const dir = scratch();
  try {
    const evidence = path.join(dir, 'evidence'), outside = path.join(dir, 'outside');
    fs.mkdirSync(evidence); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'a.png'), png);
    fs.writeFileSync(path.join(evidence, 'inside.png'), png);
    // A junction (a link a head could plant) to a folder outside: followed, then refused.
    fs.symlinkSync(outside, path.join(evidence, 'link'), 'junction');
    const markdown = [
      '![unc](//attacker.example/share/a.png)', '![escaped](%5C%5Cattacker.example%5Cshare%5Ca.png)', '![via link](link/a.png)',
      '```', '![in a gate\'s output](inside.png)', '```', '![inside](inside.png)',
    ].join('\n');
    const view = await markdownWithImages(markdown, evidence);
    assert.deepEqual(view.images.map(image => image.alt), ['inside']);
    assert.ok(view.content.includes('![in a gate\'s output](inside.png)'), 'a fenced image line stays text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lane\'s changes show as a unified diff by git, named by the file; Preview opens only a page on this machine', async () => {
  const diff = await unifiedDiff('src/a.ts', 'one\ntwo\n', 'one\nthree\n');
  assert.match(diff, /^diff src\/a\.ts\n--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@/);
  assert.match(diff, /\n-two\n\+three/);
  assert.doesNotMatch(diff, /hydra-diff-/, 'the scratch files\' names never show');
  assert.equal(await unifiedDiff('same.txt', 'x', 'x'), '');
  assert.equal(localPreviewUrl('http://localhost:5173/'), 'http://localhost:5173/');
  assert.equal(localPreviewUrl('https://127.0.0.1:8443/app'), 'https://127.0.0.1:8443/app');
  for (const refused of ['https://example.com/', 'file:///C:/x.html', 'javascript:alert(1)', 'http://user:pw@localhost/', 'http://localhost.example.com/', 'not a url']) assert.equal(localPreviewUrl(refused), undefined, refused);
});

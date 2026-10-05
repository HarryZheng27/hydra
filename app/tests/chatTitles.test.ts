import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanTitle, titlePrompt } from '../src/main/chatTitles';

test('a chat name from Claude is one short line, without quotes, labels or end punctuation; anything odd is dropped', () => {
  assert.equal(cleanTitle('Minimize Project Chats on Hover\n'), 'Minimize Project Chats on Hover');
  assert.equal(cleanTitle('"Fix flaky onboarding test."'), 'Fix flaky onboarding test');
  assert.equal(cleanTitle('Title: Products & Solutions page'), 'Products & Solutions page');
  assert.equal(cleanTitle('**Sidebar redesign**'), 'Sidebar redesign');
  assert.equal(cleanTitle(''), undefined);
  assert.equal(cleanTitle('x'.repeat(61)), undefined);
  assert.equal(cleanTitle('one two three four five six seven eight nine ten eleven'), undefined);
  assert.equal(cleanTitle('Bell\u0007 name'), 'Bell name');
  assert.ok(titlePrompt('a'.repeat(10_000)).length < 4500, 'only the start of a long message is sent');
  assert.match(titlePrompt('hello'), /hello$/);
});

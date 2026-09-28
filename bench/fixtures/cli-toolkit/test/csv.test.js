'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, isNumeric, formatNumber } = require('../src/csv');

test('parseCsv reads plain records, with \\n or \\r\\n, and skips blank lines and a final line ending', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\r\n\n3,4\n'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
});

test('parseCsv reads quoted fields with delimiters, line breaks and doubled quotes', () => {
  assert.deepEqual(parseCsv('name,note\n"Smith, J","said ""hi""\nthen left"\n'), [['name', 'note'], ['Smith, J', 'said "hi"\nthen left']]);
  assert.deepEqual(parseCsv('"",x'), [['', 'x']]);
});

test('parseCsv takes another delimiter, and refuses an unterminated quote', () => {
  assert.deepEqual(parseCsv('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => parseCsv('"open'), /unterminated/);
});

test('isNumeric and formatNumber follow SPEC.md section 2', () => {
  assert.equal(isNumeric(' 12.50 '), true);
  assert.equal(isNumeric('-3'), true);
  assert.equal(isNumeric('1e3'), false);
  assert.equal(isNumeric('.5'), false);
  assert.equal(isNumeric(''), false);
  assert.equal(formatNumber(16 / 3), '5.3333');
  assert.equal(formatNumber(2.5), '2.5');
  assert.equal(formatNumber(-0.00001), '0');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExpenses, totalsByCategory } = require('../src/expenses');

const csv = [
  ' date , category ,amount,note',
  '2024-03-01,travel,"$1,200.00",Flight',
  '2024-03-02,meals,45.5,"Dinner, with ""clients"""',
  '2024-03-03,travel,(200),Refund',
  '2024-03-04,office,-12,"Two',
  'lines"',
  '',
].join('\r\n');

test('expenses are read from CSV: trimmed headers, quoted fields, and accountants\' negatives', () => {
  assert.deepEqual(parseExpenses(csv), [
    { date: '2024-03-01', category: 'travel', cents: 120000, note: 'Flight' },
    { date: '2024-03-02', category: 'meals', cents: 4550, note: 'Dinner, with "clients"' },
    { date: '2024-03-03', category: 'travel', cents: -20000, note: 'Refund' },
    { date: '2024-03-04', category: 'office', cents: -1200, note: 'Two\r\nlines' },
  ]);
  assert.deepEqual(parseExpenses('note,amount,category,date\nTaxi,12,travel,2024-01-02\n'), [{ date: '2024-01-02', category: 'travel', cents: 1200, note: 'Taxi' }]);
  assert.deepEqual(parseExpenses(''), []);
});

test('bad records name their line', () => {
  const head = 'date,category,amount,note\n';
  assert.throws(() => parseExpenses(head + '2024-03-01,travel,12\n'), { message: 'line 2: expected 4 fields, got 3' });
  assert.throws(() => parseExpenses(head + '2024-03-01,travel,12,a\n2024-03-01,fun,12,b\n'), { message: 'line 3: category must be one of travel, meals, office, other' });
  assert.throws(() => parseExpenses(head + '2024-02-30,travel,12,a\n'), { message: 'line 2: invalid date: 2024-02-30' });
  assert.throws(() => parseExpenses(head + '2024-02-01,travel,(-12),a\n'), { message: 'line 2: invalid amount: (-12)' });
  assert.throws(() => parseExpenses(head + '2024-02-01,travel,12.345,a\n'), { message: 'line 2: invalid amount: 12.345' });
  assert.throws(() => parseExpenses('date,category,amount\n'), { message: 'missing column: note' });
  assert.throws(() => parseExpenses(head + '2024-02-01,travel,"12,a\n'), { message: 'unterminated quoted field' });
});

test('totals per category are formatted with parentheses for negatives', () => {
  assert.deepEqual(totalsByCategory(parseExpenses(csv)), { travel: '$1,000.00', meals: '$45.50', office: '($12.00)' });
  assert.deepEqual(totalsByCategory([{ category: 'other', cents: -123456 }]), { other: '($1,234.56)' });
  assert.deepEqual(totalsByCategory([]), {});
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { monthlyReport, reportCsv, percentChange } = require('../src/reports');

const entries = [
  { date: '2024-03-02', cents: 1000 }, { date: '2024-01-31', cents: 123456789 }, { date: '2024-03-30', cents: -250 }, { date: '2023-12-01', cents: 5 },
];

test('entries are totalled per month, oldest first', () => {
  assert.deepEqual(monthlyReport(entries), [
    { month: '2023-12', count: 1, total: '$0.05' },
    { month: '2024-01', count: 1, total: '$1,234,567.89' },
    { month: '2024-03', count: 2, total: '$7.50' },
  ]);
  assert.deepEqual(monthlyReport([{ date: '2024-02-01', cents: -100000 }]), [{ month: '2024-02', count: 1, total: '-$1,000.00' }]);
  assert.deepEqual(monthlyReport([]), []);
  assert.throws(() => monthlyReport([{ date: '2024-02-30', cents: 1 }]), { message: 'invalid date: 2024-02-30' });
  assert.throws(() => monthlyReport([{ date: '2024-02-03', cents: 0.5 }]), { message: 'invalid cents: 0.5' });
});

test('the report as CSV quotes what needs quoting, with CRLF endings', () => {
  assert.equal(reportCsv(monthlyReport(entries)), 'month,count,total\r\n2023-12,1,$0.05\r\n2024-01,1,"$1,234,567.89"\r\n2024-03,2,$7.50\r\n');
  assert.equal(reportCsv([{ month: 'a"b', count: 0, total: 'x\ny' }]), 'month,count,total\r\n"a""b",0,"x\ny"\r\n');
});

test('percentage changes are signed with one decimal', () => {
  assert.equal(percentChange(200, 225), '+12.5%');
  assert.equal(percentChange(200, 194), '-3.0%');
  assert.equal(percentChange(3, 3), '+0.0%');
  assert.equal(percentChange(-50, -25), '+50.0%');
  assert.equal(percentChange(0, 10), 'n/a');
});

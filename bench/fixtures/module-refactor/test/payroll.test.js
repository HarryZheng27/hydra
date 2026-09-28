'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { payPeriod, grossPay, payslip } = require('../src/payroll');

test('a pay period counts its days and weekdays, both ends included', () => {
  assert.deepEqual(payPeriod('2024-06-01', '2024-06-14'), { start: '2024-06-01', end: '2024-06-14', days: 14, workdays: 10 });
  assert.deepEqual(payPeriod('2024-06-08', '2024-06-09'), { start: '2024-06-08', end: '2024-06-09', days: 2, workdays: 0 });
  assert.deepEqual(payPeriod('2024-02-26', '2024-03-04'), { start: '2024-02-26', end: '2024-03-04', days: 8, workdays: 6 });
  assert.throws(() => payPeriod('2024-06-02', '2024-06-01'), { message: 'end must not be before start' });
  assert.throws(() => payPeriod('2024-06-31', '2024-07-01'), { message: 'invalid date: 2024-06-31' });
});

test('gross pay: overtime past 40 hours at one and a half, rounded half up', () => {
  assert.equal(grossPay({ hourlyRate: '25.50', hours: 40 }), 102000);
  assert.equal(grossPay({ hourlyRate: '25.50', hours: 45 }), 121125);
  assert.equal(grossPay({ hourlyRate: '10.01', hours: 0.5 }), 501);
  assert.equal(grossPay({ hourlyRate: '20', hours: 0 }), 0);
});

test('rates are plain decimals: no symbol, no separators', () => {
  for (const bad of ['$25.00', '1,000.00', '25.555', 'x']) assert.throws(() => grossPay({ hourlyRate: bad, hours: 1 }), { message: `invalid amount: ${bad}` });
  assert.throws(() => grossPay({ hourlyRate: '0', hours: 1 }), { message: 'hourlyRate must be positive' });
  assert.throws(() => grossPay({ hourlyRate: '-5', hours: 1 }), { message: 'hourlyRate must be positive' });
  assert.throws(() => grossPay({ hourlyRate: '5', hours: -1 }), { message: 'hours must be a number of at least 0' });
});

test('a payslip prints plain amounts', () => {
  const period = payPeriod('2024-06-01', '2024-06-14');
  assert.equal(payslip({ name: ' Grace ', hourlyRate: '1234.5' }, period, 41), [
    'Payslip: Grace',
    'Period: 2024-06-01 to 2024-06-14 (10 workdays)',
    'Hours: 41',
    'Rate: 1234.50',
    'Gross: 51231.75',
  ].join('\n'));
  assert.throws(() => payslip({ name: '', hourlyRate: '1' }, period, 1), { message: 'name is required' });
});

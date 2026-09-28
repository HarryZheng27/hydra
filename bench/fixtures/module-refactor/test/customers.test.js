'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importCustomers, customerLabel } = require('../src/customers');

test('customers are imported with tidy emails, phones and birthdays', () => {
  const csv = 'Name,Email,Phone,Birthday\n' +
    '"Lovelace, Ada",ADA@Example.com,555.123.4567,12/10/1815\n' +
    'Grace Hopper,grace@example.com,+1 (555) 987-6543,\n' +
    'Alan,alan@example.com,5551112222, 6/23/1912 \n';
  assert.deepEqual(importCustomers(csv), {
    customers: [
      { name: 'Lovelace, Ada', email: 'ada@example.com', phone: '(555) 123-4567', birthday: '1815-12-10' },
      { name: 'Grace Hopper', email: 'grace@example.com', phone: '(555) 987-6543', birthday: null },
      { name: 'Alan', email: 'alan@example.com', phone: '(555) 111-2222', birthday: '1912-06-23' },
    ],
    errors: [],
  });
  assert.deepEqual(importCustomers(''), { customers: [], errors: [] });
});

test('records that fail are reported by line and left out', () => {
  const csv = 'name,email,phone,birthday\r\n' +
    ',a@example.com,5551234567,\r\n' +
    'B,not-an-email,5551234567,\r\n' +
    'C,c@example.com,12345,\r\n' +
    'D,d@example.com,25551234567,\r\n' +
    'E,e@example.com,5551234567,2/30/2000\r\n' +
    'F,f@example.com\r\n' +
    `${'G'.repeat(101)},g@example.com,5551234567,\r\n` +
    'H,h@example.com,5551234567,2000-01-01\r\n' +
    'I,i@example.com,15551234567,1/1/2000\r\n';
  const { customers, errors } = importCustomers(csv);
  assert.deepEqual(customers, [{ name: 'I', email: 'i@example.com', phone: '(555) 123-4567', birthday: '2000-01-01' }]);
  assert.deepEqual(errors, [
    'line 2: name is required',
    'line 3: invalid email: not-an-email',
    'line 4: invalid phone: 12345',
    'line 5: invalid phone: 25551234567',
    'line 6: invalid date: 2/30/2000',
    'line 7: expected 4 fields, got 2',
    'line 8: name must be at most 100 characters',
    'line 9: invalid date: 2000-01-01',
  ]);
});

test('a customer\'s label', () => {
  assert.equal(customerLabel({ name: 'Ada', email: 'ada@example.com' }), 'Ada <ada@example.com>');
});

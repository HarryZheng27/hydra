'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvoice, invoiceTotal, invoiceSummary } = require('../src/invoices');

const base = { customer: ' Ada Lovelace ', email: 'ada@example.com', issued: '2024-01-15', lines: [{ description: 'Consulting', quantity: 3, unitPrice: '$1,250.00' }, { description: 'Travel', quantity: 1, unitPrice: '89.5' }] };

test('an invoice prices its lines from money strings and is due after its terms', () => {
  const invoice = createInvoice(base);
  assert.equal(invoice.customer, 'Ada Lovelace');
  assert.deepEqual(invoice.lines, [{ description: 'Consulting', quantity: 3, unitCents: 125000, totalCents: 375000 }, { description: 'Travel', quantity: 1, unitCents: 8950, totalCents: 8950 }]);
  assert.equal(invoice.subtotalCents, 383950);
  assert.equal(invoice.due, '2024-02-14');
  assert.equal(createInvoice({ ...base, issued: '2024-02-20', termsDays: 10 }).due, '2024-03-01', 'across a leap day');
  assert.equal(createInvoice({ ...base, termsDays: 0 }).due, '2024-01-15');
});

test('money strings: symbols, thousands, cents and negatives, and what is refused', () => {
  const price = unitPrice => createInvoice({ ...base, lines: [{ description: 'x', quantity: 1, unitPrice }] }).subtotalCents;
  assert.equal(price('$5'), 500);
  assert.equal(price('12,345,678.9'), 1234567890);
  assert.equal(price(' 0.05 '), 5);
  assert.equal(price('-$3.10'), -310);
  for (const bad of ['5.123', '1,23', '$-3', '12,34.00', 'abc', '', '$', '.5']) assert.throws(() => price(bad), { message: `invalid amount: ${bad}` });
  assert.throws(() => price(5), { message: 'invalid amount: 5' });
});

test('the total and the summary are formatted', () => {
  const invoice = createInvoice(base);
  assert.equal(invoiceTotal(invoice), '$3,839.50');
  assert.equal(invoiceTotal({ subtotalCents: -5 }), '-$0.05');
  assert.equal(invoiceTotal({ subtotalCents: 0 }), '$0.00');
  assert.equal(invoiceSummary(invoice), [
    'Invoice for Ada Lovelace <ada@example.com>',
    '  3 x Consulting @ $1,250.00 = $3,750.00',
    '  1 x Travel @ $89.50 = $89.50',
    'Total: $3,839.50',
    'Issued January 15, 2024, due February 14, 2024',
  ].join('\n'));
  assert.throws(() => invoiceTotal({ subtotalCents: 1.5 }), { message: 'invalid cents: 1.5' });
});

test('bad input is refused with a clear message', () => {
  assert.throws(() => createInvoice({ ...base, customer: '  ' }), { message: 'customer is required' });
  assert.throws(() => createInvoice({ ...base, customer: 'x'.repeat(81) }), { message: 'customer must be at most 80 characters' });
  assert.throws(() => createInvoice({ ...base, email: 'ada@example' }), { message: 'invalid email: ada@example' });
  assert.throws(() => createInvoice({ ...base, lines: [] }), { message: 'lines is required' });
  assert.throws(() => createInvoice({ ...base, lines: [{ description: 'x', quantity: 0, unitPrice: '1' }] }), { message: 'quantity must be at least 1' });
  assert.throws(() => createInvoice({ ...base, lines: [{ description: 'x', quantity: 1.5, unitPrice: '1' }] }), { message: 'quantity must be a whole number' });
  assert.throws(() => createInvoice({ ...base, termsDays: 121 }), { message: 'termsDays must be at most 120' });
  assert.throws(() => createInvoice({ ...base, issued: '2023-02-29' }), { message: 'invalid date: 2023-02-29' });
  assert.throws(() => createInvoice({ ...base, issued: '2024-1-5' }), { message: 'invalid date: 2024-1-5' });
});

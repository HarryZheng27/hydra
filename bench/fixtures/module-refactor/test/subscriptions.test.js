'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubscription, renewalDates, invoiceLine } = require('../src/subscriptions');

test('renewals are a month apart, clamped at month ends from the start\'s day', () => {
  assert.deepEqual(renewalDates('2024-01-31', 4), ['2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31']);
  assert.deepEqual(renewalDates('2023-11-30', 3), ['2023-12-30', '2024-01-30', '2024-02-29']);
  assert.deepEqual(renewalDates('2023-01-29', 1), ['2023-02-28']);
  assert.deepEqual(renewalDates('2024-05-05', 0), []);
  assert.throws(() => renewalDates('2024-05-05', 1.5), { message: 'count must be a whole number' });
  assert.throws(() => renewalDates('2024-05-05', 121), { message: 'count must be at most 120' });
  assert.throws(() => renewalDates('2024-04-31', 1), { message: 'invalid date: 2024-04-31' });
});

test('a subscription is priced per seat and lists its next three renewals', () => {
  assert.deepEqual(createSubscription({ plan: 'pro', start: '2024-03-05', seats: 3 }), { plan: 'pro', start: '2024-03-05', seats: 3, monthlyCents: 4500, renewals: ['2024-04-05', '2024-05-05', '2024-06-05'] });
  assert.equal(createSubscription({ plan: 'basic', start: '2024-03-05' }).monthlyCents, 900);
  assert.throws(() => createSubscription({ plan: 'gold', start: '2024-03-05' }), { message: 'plan must be one of basic, pro, team' });
  assert.throws(() => createSubscription({ plan: 'team', start: '2024-03-05', seats: 2 }), { message: 'seats must be at least 3' });
  assert.throws(() => createSubscription({ plan: 'pro', start: '2024-03-05', seats: 501 }), { message: 'seats must be at most 500' });
});

test('the invoice line spells the date and formats the price', () => {
  assert.equal(invoiceLine(createSubscription({ plan: 'pro', start: '2024-03-05', seats: 3 })), 'Pro plan, 3 seats: $45.00/month from March 5, 2024');
  assert.equal(invoiceLine(createSubscription({ plan: 'basic', start: '2024-12-31' })), 'Basic plan, 1 seat: $9.00/month from December 31, 2024');
  assert.equal(invoiceLine({ plan: 'team', seats: 100, monthlyCents: 120000, start: '2025-01-01' }), 'Team plan, 100 seats: $1,200.00/month from January 1, 2025');
});

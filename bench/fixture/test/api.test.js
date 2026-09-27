'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../src/api');
const { resetOrders } = require('../src/orders');

test.beforeEach(() => resetOrders());

test('POST /orders makes an order, and GET /orders/:id reads it back', () => {
  const made = handle({ method: 'POST', path: '/orders', body: { items: [{ sku: 'cap', quantity: 2 }] } });
  assert.equal(made.status, 201);
  assert.equal(made.body.totalCents, 3600);
  const read = handle({ method: 'GET', path: `/orders/${made.body.id}` });
  assert.equal(read.status, 200);
  assert.equal(read.body.totalCents, 3600);
});

test('a bad order is a 400, and an unknown one a 404', () => {
  assert.equal(handle({ method: 'POST', path: '/orders', body: { items: [] } }).status, 400);
  assert.equal(handle({ method: 'GET', path: '/orders/99' }).status, 404);
});

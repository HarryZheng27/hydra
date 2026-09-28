'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrder, getOrder, totalFor, resetOrders } = require('../src/orders');

test.beforeEach(() => resetOrders());

test('an order totals its lines', () => {
  const order = createOrder([{ sku: 'mug', quantity: 2 }, { sku: 'tee', quantity: 1 }]);
  assert.equal(order.subtotalCents, 4900);
  assert.equal(totalFor(order), 4900);
  assert.equal(getOrder(order.id), order);
});

test('an unknown product or a bad quantity is refused', () => {
  assert.throws(() => createOrder([{ sku: 'nope', quantity: 1 }]), /Unknown product/);
  assert.throws(() => createOrder([{ sku: 'mug', quantity: 0 }]), /positive whole number/);
  assert.throws(() => createOrder([]), /at least one item/);
});

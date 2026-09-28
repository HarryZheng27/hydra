'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderOrder } = require('../src/ui');
const { createOrder, resetOrders } = require('../src/orders');

test.beforeEach(() => resetOrders());

test('an order renders its lines and its total', () => {
  const html = renderOrder(createOrder([{ sku: 'bag', quantity: 3 }]));
  assert.match(html, /<td>Tote bag<\/td><td>3<\/td><td>\$45\.00<\/td>/);
  assert.match(html, /<td class="total">\$45\.00<\/td>/);
});

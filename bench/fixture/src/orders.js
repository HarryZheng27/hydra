'use strict';
const { findProduct } = require('./catalog');

let nextId = 1;
const orders = new Map();

/** Makes an order from [{ sku, quantity }]; throws on an unknown product or a quantity that isn't a positive whole number. */
function createOrder(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('An order needs at least one item.');
  const lines = items.map(item => {
    const product = findProduct(item.sku);
    if (!product) throw new Error(`Unknown product "${item.sku}".`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error(`Quantity for "${item.sku}" must be a positive whole number.`);
    return { sku: product.sku, name: product.name, quantity: item.quantity, unitCents: product.priceCents, lineCents: product.priceCents * item.quantity };
  });
  const order = { id: String(nextId++), lines, subtotalCents: lines.reduce((sum, line) => sum + line.lineCents, 0) };
  orders.set(order.id, order);
  return order;
}

function getOrder(id) {
  return orders.get(String(id));
}

/** What the customer pays. */
function totalFor(order) {
  return order.subtotalCents;
}

function resetOrders() {
  orders.clear();
  nextId = 1;
}

module.exports = { createOrder, getOrder, totalFor, resetOrders };

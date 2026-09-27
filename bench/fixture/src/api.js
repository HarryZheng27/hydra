'use strict';
const { createOrder, getOrder, totalFor } = require('./orders');

/**
 * The shop's HTTP API as one function, so it can be tested without a server:
 * handle({ method, path, body }) -> { status, body }.
 */
function handle(request) {
  const { method, path, body } = request;
  if (method === 'POST' && path === '/orders') {
    try {
      const order = createOrder(body && body.items);
      return { status: 201, body: { ...order, totalCents: totalFor(order) } };
    } catch (error) {
      return { status: 400, body: { error: error.message } };
    }
  }
  const match = /^\/orders\/([^/]+)$/.exec(path);
  if (method === 'GET' && match) {
    const order = getOrder(match[1]);
    if (!order) return { status: 404, body: { error: 'No such order.' } };
    return { status: 200, body: { ...order, totalCents: totalFor(order) } };
  }
  return { status: 404, body: { error: 'Not found.' } };
}

module.exports = { handle };

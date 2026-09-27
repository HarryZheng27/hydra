'use strict';
const { totalFor } = require('./orders');

const money = cents => `$${(cents / 100).toFixed(2)}`;
const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** An order as the HTML the order page shows. */
function renderOrder(order) {
  const rows = order.lines.map(line => `<tr><td>${escape(line.name)}</td><td>${line.quantity}</td><td>${money(line.lineCents)}</td></tr>`).join('');
  return [
    `<table class="order" data-order="${escape(order.id)}">`,
    `<thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `<tfoot><tr><td colspan="2">Total</td><td class="total">${money(totalFor(order))}</td></tr></tfoot>`,
    '</table>',
  ].join('');
}

module.exports = { renderOrder, money };

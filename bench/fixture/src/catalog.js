'use strict';

/** Prices are in cents, so totals never pick up floating-point pennies. */
const products = [
  { sku: 'mug', name: 'Mug', priceCents: 1200 },
  { sku: 'tee', name: 'T-shirt', priceCents: 2500 },
  { sku: 'cap', name: 'Cap', priceCents: 1800 },
  { sku: 'bag', name: 'Tote bag', priceCents: 1500 },
];

function findProduct(sku) {
  return products.find(product => product.sku === sku);
}

module.exports = { products, findProduct };

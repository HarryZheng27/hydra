# Shop

A small shop: a catalog, orders, an HTTP API (`src/api.js`) and the order page (`src/ui.js`). Prices are in cents.

## API

- `POST /orders` with `{ "items": [{ "sku": "mug", "quantity": 2 }] }` makes an order and answers `201` with it, including `totalCents`.
- `GET /orders/:id` answers the order, or `404`.

## Running the tests

`npm test`

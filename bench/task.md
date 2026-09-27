# The benchmark task: discount codes

The same work as `fixture/.hydra/plans/discounts.json`, as one brief for a single agent (the baseline).

Customers can enter a discount code on an order. Codes: SAVE10 takes 10% off the subtotal (rounded down to a whole cent); FIVEOFF takes $5.00 (500 cents) off an order whose subtotal is at least $25.00 (2500 cents). Codes are case-insensitive. An order object gains `discountCode` (the code in upper case, only when one was applied) and `discountCents` (always present; 0 when there's no code); `totalFor(order)` returns `subtotalCents - discountCents`, never below 0. An unknown code, or FIVEOFF under its minimum, is refused with an Error whose message names the code.

Do all of this, in plain Node (CommonJS, no dependencies), and make `npm test` pass:

1. `src/discounts.js` exporting `applyDiscount(subtotalCents, code)` returning `{ code, discountCents }` (or `{ discountCents: 0 }` with no code), throwing as above; with `test/discounts.test.js`.
2. `createOrder(items, code)` in `src/orders.js` applies an optional code; `totalFor` subtracts the discount. `POST /orders` in `src/api.js` accepts an optional `code` and answers 400 with the error's message for a refused code.
3. `renderOrder` in `src/ui.js` shows `<tr class="discount"><td colspan="2">Discount (CODE)</td><td>-$X.XX</td></tr>` above the total when there's a discount.
4. Tests in `test/orders.test.js` and `test/api.test.js` for both codes, no code, a lower-case code, and the refusals.
5. Tests in `test/ui.test.js` for the discount row and its absence.
6. A README.md section documenting the codes, the API's `code`, the order's new fields and the discount row.

# Billing modules: the shared core

Six modules in `src/` each carry private copies of the same helpers: parsing and formatting money, dates, CSV, and input checks. The copies differ in small ways that are part of each module's behaviour, and the tests in `test/` pin that behaviour.

The work: write one shared core in `src/core/`, with its own tests, and move every module onto it, **with each module's behaviour unchanged**: every existing test in `test/` must pass without being changed. Plain Node (CommonJS, Node 20 or later), no dependencies.

## 1. Rules

- The existing tests (`test/invoices.test.js`, `test/payroll.test.js`, `test/expenses.test.js`, `test/subscriptions.test.js`, `test/reports.test.js`, `test/customers.test.js`) are the specification of the modules. Don't change them.
- A module's exports, their names, arguments, results and error messages stay exactly as they are.
- The core throws plain `Error`s with the messages below, character for character; the modules' tests depend on them.
- The core's tests go in `test/core/<name>.test.js` and cover every rule of their section, including every option and error.
- After the move, a module keeps only code that is about its own domain: none of the private helpers listed in section 6 remain, and it requires what it needs from `src/core/`.

## 2. `src/core/money.js`

Amounts are whole cents (integers).

- `parseMoney(text, options = {})` returns the cents of a money string. Options, all optional:
  - `symbol` (default `true`): a `$` may come right after the optional minus sign (`-$3.10`); with `false`, a `$` is refused.
  - `thousands` (default `true`): the whole part may use commas between groups of exactly three digits after the first group of one to three (`12,345,678`); with `false`, commas are refused.
  - `parens` (default `false`): the whole amount may be wrapped in parentheses, meaning negative (`(12.30)` is −1230, `($5)` is −500); a minus sign inside parentheses is refused.
  - The rest of the grammar: spaces around the whole text are ignored (but not inside the parentheses); an optional `-`; the optional `$`; one or more digits (or the comma groups); optionally `.` and one or two digits (`12.3` is 1230). Nothing else.
  - Anything else, or a `text` that isn't a string: `Error('invalid amount: <text>')`, with `text` as given (not trimmed).
- `formatMoney(cents, options = {})` returns the amount as text. Options:
  - `symbol` (default `'$'`): put before the digits; `''` for none.
  - `thousands` (default `true`): commas between groups of three digits in the whole part; `false` for none.
  - `negative` (default `'minus'`): `'minus'` puts `-` before the symbol (`-$1,234.56`); `'parens'` wraps the amount instead (`($1,234.56)`).
  - Always two decimals: `$0.05`, `$0.00`. `cents` that isn't an integer: `Error('invalid cents: <cents>')`.

## 3. `src/core/dates.js`

A **date** is a string `YYYY-MM-DD` that names a real calendar day (leap years count). Work in whole UTC days, never local time.

- `parseDate(text)` returns `{ year, month, day }` (numbers). No trimming. Anything else: `Error('invalid date: <text>')`.
- `formatDate({ year, month, day })` returns `YYYY-MM-DD`, zero-padded.
- `addDays(text, days)` returns the date `days` later (earlier when negative).
- `addMonths(text, months)` returns the date `months` later, keeping the day of the month but clamping it to the last day of a shorter month (`2024-01-31` plus 1 is `2024-02-29`; `2023-01-31` plus 1 is `2023-02-28`).
- `daysBetween(from, to)` returns the number of days from `from` to `to` (negative when `to` is earlier).
- `dayOfWeek(text)` returns 0 (Sunday) to 6 (Saturday); `isWeekend(text)` is true for Saturday and Sunday.
- `monthKey(text)` returns `YYYY-MM`.
- `formatLong(text)` returns the English month name, the day without padding, a comma and the year: `March 5, 2024`.
- `parseUsDate(text)` reads `M/D/YYYY` (one or two digits for month and day; surrounding spaces ignored) and returns the date `YYYY-MM-DD`. A date that isn't real, or anything else: `Error('invalid date: <text>')`, with `text` as given.
- Every function that takes a date checks it as `parseDate` does, with the same error.

## 4. `src/core/csv.js`

- `parseCsv(text, { delimiter = ',' } = {})` returns the records as arrays of strings, per RFC 4180: a field may be quoted with `"`; a quoted field may hold the delimiter, line breaks (kept as they are, `\r\n` included) and `""` for one quote; records end with `\n` or `\r\n`; a final line ending doesn't start another record; empty lines are skipped. An unclosed quote: `Error('unterminated quoted field')`.
- `parseCsvObjects(text, options)` reads the first record as the header, with each name trimmed, and returns one object per later record, keyed by those names. A record with a different number of fields: `Error('line <n>: expected <h> fields, got <m>')`, where `n` counts records from 1 with the header as record 1. Empty text gives `[]`.
- `formatCsvRow(fields)` joins the fields with commas; a field is `String(value)`, quoted when it contains a comma, a double quote, CR or LF, with each `"` doubled.
- `formatCsv(rows, { eol = '\n' } = {})` is every row formatted, each followed by `eol` (the last one too).

## 5. `src/core/validate.js`

- `requireString(value, field, { max } = {})` returns `value` trimmed. A value that isn't a string, or is empty once trimmed: `Error('<field> is required')`. Longer than `max` once trimmed: `Error('<field> must be at most <max> characters')`.
- `requireInteger(value, field, { min, max } = {})` returns `value`. Not an integer: `Error('<field> must be a whole number')`; below `min`: `Error('<field> must be at least <min>')`; above `max`: `Error('<field> must be at most <max>')`.
- `isEmail(value)`: true for a string matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, false for anything else.
- `normalizePhone(value)`: the digits of `String(value ?? '')`; eleven digits starting with 1 lose the 1; then there must be exactly ten, returned as `(555) 123-4567`. Otherwise `Error('invalid phone: <value>')`.
- `oneOf(value, allowed, field)` returns `value` when `allowed` includes it; otherwise `Error('<field> must be one of <allowed joined with ", ">')`.

## 6. Moving each module

Each module moves onto the core, keeping its exports and behaviour. These private helpers must be gone from it afterwards, replaced by the core:

| Module | Private helpers to remove | Core it uses |
| --- | --- | --- |
| `src/invoices.js` | `parseAmount`, `formatAmount`, `parseDay`, `plusDays`, `longDate`, `needText`, `needWhole`, `emailLike`, `monthNames` | money, dates, validate |
| `src/payroll.js` | `toCents`, `centsToString`, `dayNumber`, `between`, `weekday`, `weekend`, `shift`, `mustBeText` | money (no symbol, no thousands), dates, validate |
| `src/expenses.js` | `splitRecords`, `readMoney`, `showMoney`, `validDate`, `pick` | csv, money (parentheses), dates, validate |
| `src/subscriptions.js` | `priceText`, `readDay`, `pad`, `monthsLater`, `names`, `spelled`, `wholeNumber`, `among` | money, dates, validate |
| `src/reports.js` | `dollars`, `checkedDate`, `monthOf`, `csvField`, `csvLine` | money, dates, csv |
| `src/customers.js` | `readCsv`, `usToIso`, `requireText`, `checkEmail`, `tidyPhone` | csv, dates, validate |

## 7. Finishing

- `src/core/index.js` re-exports every function of the four core modules.
- `test/structure.test.js` reads each module's source and fails if any helper from section 6 is still defined in it, or if it doesn't require `./core/…`.
- `README.md` gets a section on the core: what each core module offers, with its options.

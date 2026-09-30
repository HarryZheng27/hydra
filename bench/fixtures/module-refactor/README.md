# Billing modules

Six small billing modules in plain Node (CommonJS, no dependencies): invoices, payroll, expenses, subscriptions, reports and customers, each in `src/` with its tests in `test/`.

```
npm test
```

They grew separately, so each carries its own private copy of the same helpers: money parsing and formatting, dates, CSV, and input checks. The copies differ in small ways that matter (payroll's amounts have no dollar sign; expenses write negatives in parentheses; reports use CRLF), and the tests pin every one of those behaviours.

## The task

Move the modules onto one shared core, as [SPEC.md](SPEC.md) describes exactly:

- a core in `src/core/` (`money.js`, `dates.js`, `csv.js`, `validate.js`), each with its own tests in `test/core/`;
- each of the six modules rewritten on the core, with its private helpers gone and its behaviour unchanged: the existing tests pass without being changed;
- then `src/core/index.js` and a section of this README on the core. `test/structure.test.js`, which fails when a moved module still has a private helper, is already here.

`npm test` must pass at the end.

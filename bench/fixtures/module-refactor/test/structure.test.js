'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// SPEC.md sections 6 and 7. This test ships with the starting code and nobody edits it. A module that has been
// moved onto the core (it requires from ./core/) must have lost every private helper named for it in section 6; a
// module that hasn't been moved yet is left alone, so the test passes on the starting code and each move's own
// `npm test` catches a helper left behind.
const helpers = {
  invoices: ['parseAmount', 'formatAmount', 'parseDay', 'plusDays', 'longDate', 'needText', 'needWhole', 'emailLike', 'monthNames'],
  payroll: ['toCents', 'centsToString', 'dayNumber', 'between', 'weekday', 'weekend', 'shift', 'mustBeText'],
  expenses: ['splitRecords', 'readMoney', 'showMoney', 'validDate', 'pick'],
  subscriptions: ['priceText', 'readDay', 'pad', 'monthsLater', 'names', 'spelled', 'wholeNumber', 'among'],
  reports: ['dollars', 'checkedDate', 'monthOf', 'csvField', 'csvLine'],
  customers: ['readCsv', 'usToIso', 'requireText', 'checkEmail', 'tidyPhone'],
};

const usesCore = source => /require\(\s*['"]\.\/core(\/[a-z]+)?(\.js)?['"]\s*\)/.test(source);
const defines = (source, helper) => new RegExp(`\\b(function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+)${helper}\\b`).test(source);

for (const [name, list] of Object.entries(helpers)) {
  test(`${name}: once it uses the core, none of its private helpers is left`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', `${name}.js`), 'utf8');
    if (!usesCore(source)) return;
    const left = list.filter(helper => defines(source, helper));
    assert.deepEqual(left, [], `src/${name}.js still defines ${left.join(', ')}: remove it and use the core`);
  });
}

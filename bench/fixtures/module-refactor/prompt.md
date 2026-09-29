# Move the billing modules onto a shared core

Extract one shared core from the six billing modules' duplicated helpers and move each module onto it, as SPEC.md describes exactly: four core modules in src/core/ with their own tests, then each module rewritten on the core with its private helpers gone and its behaviour unchanged, then a core index and a README section. test/structure.test.js is already in the repository (nobody edits it): once a module uses ./core/ it fails if any of that module's private helpers is still defined. Plain Node, CommonJS, no dependencies. The existing tests in test/ pin each module's behaviour, error messages included: they must pass unchanged, and nobody edits them. The core's error messages are given in SPEC.md: match them exactly. Run `npm test` before finishing.

Do all of the following yourself, then make sure `npm test` passes.

## 1. Core: money

Write src/core/money.js exactly as SPEC.md section 2 says: parseMoney(text, { symbol, thousands, parens }) and formatMoney(cents, { symbol, thousands, negative }). The private copies in src/invoices.js (parseAmount, formatAmount), src/payroll.js (toCents, centsToString) and src/expenses.js (readMoney, showMoney) show the behaviours the options must reproduce; read them but don't change them. Write test/core/money.test.js covering every rule and option of section 2: symbols, thousands groups (and bad groupings), one and two decimals, negatives with a minus and in parentheses (and a minus inside parentheses refused), surrounding spaces, non-strings, the exact error messages, and every formatting option including zero and negative amounts. Change no other file.

Files: src/core/money.js, test/core/money.test.js

## 2. Core: dates

Write src/core/dates.js exactly as SPEC.md section 3 says: parseDate, formatDate, addDays, addMonths, daysBetween, dayOfWeek, isWeekend, monthKey, formatLong and parseUsDate. Work in whole UTC days. The private copies in the six modules in src/ (parseDay, plusDays, longDate, dayNumber, between, weekday, shift, monthsLater, spelled, checkedDate, monthOf, usToIso, validDate) show the behaviours; read them but don't change them. Write test/core/dates.test.js covering every rule of section 3: real and unreal dates (February 29 in and out of leap years, April 31, month 13, a bad format), adding days across months and years and backwards, adding months with the end-of-month clamping, days between both ways, weekdays, month keys, long dates, US dates with one- and two-digit parts and spaces, and the exact error messages. Change no other file.

Files: src/core/dates.js, test/core/dates.test.js

## 3. Core: CSV and input checks

Write src/core/csv.js and src/core/validate.js exactly as SPEC.md sections 4 and 5 say: parseCsv(text, { delimiter }), parseCsvObjects(text, options), formatCsvRow(fields), formatCsv(rows, { eol }); and requireString(value, field, { max }), requireInteger(value, field, { min, max }), isEmail(value), normalizePhone(value), oneOf(value, allowed, field). The private copies in the six modules in src/ (splitRecords, readCsv, csvField, csvLine, needText, needWhole, emailLike, mustBeText, pick, wholeNumber, among, requireText, checkEmail, tidyPhone) show the behaviours; read them but don't change them. Write test/core/csv.test.js and test/core/validate.test.js covering every rule of both sections with the exact error messages: quoted fields with delimiters, line breaks and doubled quotes, LF and CRLF, empty lines, another delimiter, an unclosed quote, trimmed header names, a record with the wrong field count, quoting on output, both end-of-line choices; trimming, empty and non-string values, max length after trimming, integer bounds, emails that pass and fail, phones with punctuation, a leading 1 and the wrong number of digits, and oneOf. Change no other file.

Files: src/core/csv.js, src/core/validate.js, test/core/csv.test.js, test/core/validate.test.js

## 4. Move invoices onto the core

Move src/invoices.js onto the shared core as SPEC.md section 6 says. src/core/money.js, dates.js and validate.js now exist (SPEC.md sections 2, 3 and 5): read them. Remove the private helpers parseAmount, formatAmount, parseDay, plusDays, longDate, needText, needWhole, emailLike and monthNames, and use the core instead. Keep every export, result and error message exactly as it is: test/invoices.test.js must pass unchanged, and you must not edit it. Where a helper behaved differently from the core's defaults, use the core's options or keep the difference in the module's own code. Don't change the core: if it breaks SPEC.md, say so in your summary. test/structure.test.js is already in the repository and runs with npm test: once this module requires from ./core/, it fails if any helper named above is still defined in it, so run npm test and remove whatever it names; don't edit it. Change only src/invoices.js.

Files: src/invoices.js

## 5. Move payroll onto the core

Move src/payroll.js onto the shared core as SPEC.md section 6 says. src/core/money.js, dates.js and validate.js now exist (SPEC.md sections 2, 3 and 5): read them. Remove the private helpers toCents, centsToString, dayNumber, between, weekday, weekend, shift and mustBeText, and use the core instead: payroll's amounts have no dollar sign and no thousands separators, in and out. Keep every export, result and error message exactly as it is: test/payroll.test.js must pass unchanged, and you must not edit it. Don't change the core: if it breaks SPEC.md, say so in your summary. test/structure.test.js is already in the repository and runs with npm test: once this module requires from ./core/, it fails if any helper named above is still defined in it, so run npm test and remove whatever it names; don't edit it. Change only src/payroll.js.

Files: src/payroll.js

## 6. Move expenses onto the core

Move src/expenses.js onto the shared core as SPEC.md section 6 says. src/core/csv.js, money.js, dates.js and validate.js now exist (SPEC.md sections 2 to 5): read them. Remove the private helpers splitRecords, readMoney, showMoney, validDate and pick, and use the core instead: expenses read and write negative amounts in parentheses. Keep every export, result and error message exactly as it is, including which error wins when a file has several problems: test/expenses.test.js must pass unchanged, and you must not edit it. Don't change the core: if it breaks SPEC.md, say so in your summary. test/structure.test.js is already in the repository and runs with npm test: once this module requires from ./core/, it fails if any helper named above is still defined in it, so run npm test and remove whatever it names; don't edit it. Change only src/expenses.js.

Files: src/expenses.js

## 7. Move subscriptions onto the core

Move src/subscriptions.js onto the shared core as SPEC.md section 6 says. src/core/money.js, dates.js and validate.js now exist (SPEC.md sections 2, 3 and 5): read them. Remove the private helpers priceText, readDay, pad, monthsLater, names, spelled, wholeNumber and among, and use the core instead. Keep every export, result and error message exactly as it is: test/subscriptions.test.js must pass unchanged, and you must not edit it. Don't change the core: if it breaks SPEC.md, say so in your summary. test/structure.test.js is already in the repository and runs with npm test: once this module requires from ./core/, it fails if any helper named above is still defined in it, so run npm test and remove whatever it names; don't edit it. Change only src/subscriptions.js.

Files: src/subscriptions.js

## 8. Move reports onto the core

Move src/reports.js onto the shared core as SPEC.md section 6 says. src/core/money.js, dates.js and csv.js now exist (SPEC.md sections 2 to 4): read them. Remove the private helpers dollars, checkedDate, monthOf, csvField and csvLine, and use the core instead: the report's CSV keeps its CRLF line endings. Keep every export, result and error message exactly as it is: test/reports.test.js must pass unchanged, and you must not edit it. Don't change the core: if it breaks SPEC.md, say so in your summary. test/structure.test.js is already in the repository and runs with npm test: once this module requires from ./core/, it fails if any helper named above is still defined in it, so run npm test and remove whatever it names; don't edit it. Change only src/reports.js.

Files: src/reports.js

## 9. Move customers onto the core

Move src/customers.js onto the shared core as SPEC.md section 6 says. src/core/csv.js, dates.js and validate.js now exist (SPEC.md sections 3 to 5): read them. Remove the private helpers readCsv, usToIso, requireText, checkEmail and tidyPhone, and use the core instead. The import still reports a bad record by its line and carries on with the rest, rather than stopping at the first. Keep every export, result and error message exactly as it is: test/customers.test.js must pass unchanged, and you must not edit it. Don't change the core: if it breaks SPEC.md, say so in your summary. test/structure.test.js is already in the repository and runs with npm test: once this module requires from ./core/, it fails if any helper named above is still defined in it, so run npm test and remove whatever it names; don't edit it. Change only src/customers.js.

Files: src/customers.js

## 10. Core index and README section

Finish the move as SPEC.md section 7 says. The core (src/core/) and all six modules on it now exist, and test/structure.test.js (already in the repository, run by npm test) checks that no module keeps a private helper. Write src/core/index.js re-exporting every function of money.js, dates.js, csv.js and validate.js, and a README.md section describing each core module and its options. If npm test fails on something outside your two files, say so in your summary rather than changing it. Change only src/core/index.js and README.md.

Files: src/core/index.js, README.md

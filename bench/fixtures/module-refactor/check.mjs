#!/usr/bin/env node
// The hidden acceptance check for the module-refactor fixture (docs/Benchmark.md). The benchmark harness runs it after
// each setup, on the result: `node check.mjs <repo>`. It is never copied into the repositories the agents work in.
// It runs the modules' original tests (from this fixture, so an edited copy in the result can't pass for them) on
// the result's code, checks the core against SPEC.md, and checks that no private helper is left in a module.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(process.argv[2] ?? '.');
const fixture = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(repo, 'package.json'));
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`not ok - ${name}: ${String(error?.message ?? error).split('\n').slice(0, 3).join(' ').slice(0, 400)}`); }
}
const core = name => require(`./src/core/${name}.js`);
const throwsMessage = (fn, message) => assert.throws(fn, error => error instanceof Error && error.message === message, `expected the error "${message}"`);

const modules = {
  invoices: ['parseAmount', 'formatAmount', 'parseDay', 'plusDays', 'longDate', 'needText', 'needWhole', 'emailLike', 'monthNames'],
  payroll: ['toCents', 'centsToString', 'dayNumber', 'between', 'weekday', 'weekend', 'shift', 'mustBeText'],
  expenses: ['splitRecords', 'readMoney', 'showMoney', 'validDate', 'pick'],
  subscriptions: ['priceText', 'readDay', 'pad', 'monthsLater', 'names', 'spelled', 'wholeNumber', 'among'],
  reports: ['dollars', 'checkedDate', 'monthOf', 'csvField', 'csvLine'],
  customers: ['readCsv', 'usToIso', 'requireText', 'checkEmail', 'tidyPhone'],
};

// ---- behaviour unchanged: the original tests, on the result's code ----
const copy = mkdtempSync(path.join(tmpdir(), 'refactor-check-'));
try {
  cpSync(path.join(repo, 'src'), path.join(copy, 'src'), { recursive: true });
  cpSync(path.join(fixture, 'package.json'), path.join(copy, 'package.json'));
  cpSync(path.join(fixture, 'test'), path.join(copy, 'test'), { recursive: true, filter: source => !/[\\/]core([\\/]|$)/.test(path.relative(fixture, source)) });
  for (const name of Object.keys(modules)) {
    check(`${name}: the original tests still pass`, () => {
      const run = spawnSync(process.execPath, ['--test', path.join('test', `${name}.test.js`)], { cwd: copy, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      assert.equal(run.status, 0, (run.stdout + run.stderr).split('\n').filter(line => /^not ok|message:|expected|actual/.test(line.trim())).slice(0, 6).join(' | '));
    });
  }
} finally { rmSync(copy, { recursive: true, force: true }); }

// ---- the core (SPEC.md sections 2 to 5) ----
check('core money: parseMoney and its options', () => {
  const { parseMoney } = core('money');
  assert.equal(parseMoney('$1,234.5'), 123450);
  assert.equal(parseMoney(' -$0.05 '), -5);
  assert.equal(parseMoney('12,345,678'), 1234567800);
  assert.equal(parseMoney('7'), 700);
  for (const bad of ['1,23', '12,34.00', '1.234', '$-3', '.5', '', 'abc', '(5)']) throwsMessage(() => parseMoney(bad), `invalid amount: ${bad}`);
  throwsMessage(() => parseMoney(12), 'invalid amount: 12');
  throwsMessage(() => parseMoney('$5', { symbol: false }), 'invalid amount: $5');
  throwsMessage(() => parseMoney('1,000', { thousands: false }), 'invalid amount: 1,000');
  assert.equal(parseMoney('1000.1', { symbol: false, thousands: false }), 100010);
  assert.equal(parseMoney('(12.30)', { parens: true }), -1230);
  assert.equal(parseMoney('($1,000)', { parens: true }), -100000);
  assert.equal(parseMoney(' (5) ', { parens: true }), -500);
  throwsMessage(() => parseMoney('(-5)', { parens: true }), 'invalid amount: (-5)');
  throwsMessage(() => parseMoney('( 5)', { parens: true }), 'invalid amount: ( 5)');
});
check('core money: formatMoney and its options', () => {
  const { formatMoney } = core('money');
  assert.equal(formatMoney(123456789), '$1,234,567.89');
  assert.equal(formatMoney(-5), '-$0.05');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(-123456, { negative: 'parens' }), '($1,234.56)');
  assert.equal(formatMoney(123456, { negative: 'parens' }), '$1,234.56');
  assert.equal(formatMoney(-123456, { symbol: '', thousands: false }), '-1234.56');
  assert.equal(formatMoney(100000, { symbol: '€' }), '€1,000.00');
  throwsMessage(() => formatMoney(1.5), 'invalid cents: 1.5');
});
check('core dates: parsing, arithmetic and formats', () => {
  const d = core('dates');
  assert.deepEqual(d.parseDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
  for (const bad of ['2023-02-29', '2024-04-31', '2024-13-01', '2024-1-01', ' 2024-01-01']) throwsMessage(() => d.parseDate(bad), `invalid date: ${bad}`);
  assert.equal(d.formatDate({ year: 2024, month: 3, day: 5 }), '2024-03-05');
  assert.equal(d.addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(d.addDays('2024-01-01', -1), '2023-12-31');
  assert.equal(d.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(d.addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(d.addMonths('2023-11-30', 3), '2024-02-29');
  assert.equal(d.addMonths('2024-03-31', -1), '2024-02-29');
  assert.equal(d.daysBetween('2024-01-01', '2024-03-01'), 60);
  assert.equal(d.daysBetween('2024-03-01', '2024-01-01'), -60);
  assert.equal(d.dayOfWeek('2024-06-09'), 0);
  assert.equal(d.dayOfWeek('2024-06-15'), 6);
  assert.equal(d.isWeekend('2024-06-08'), true);
  assert.equal(d.isWeekend('2024-06-10'), false);
  assert.equal(d.monthKey('2024-06-10'), '2024-06');
  assert.equal(d.formatLong('2024-03-05'), 'March 5, 2024');
  assert.equal(d.parseUsDate(' 3/7/1990 '), '1990-03-07');
  assert.equal(d.parseUsDate('12/31/1999'), '1999-12-31');
  for (const bad of ['2/30/2000', '2000-01-01', '13/1/2000', '1/1/99']) throwsMessage(() => d.parseUsDate(bad), `invalid date: ${bad}`);
  throwsMessage(() => d.addDays('2024-02-30', 1), 'invalid date: 2024-02-30');
});
check('core csv: parsing, objects and formatting', () => {
  const c = core('csv');
  assert.deepEqual(c.parseCsv('a,"b,c"\r\n"say ""hi""","x\r\ny"\n\nlast,\n'), [['a', 'b,c'], ['say "hi"', 'x\r\ny'], ['last', '']]);
  assert.deepEqual(c.parseCsv('a;b\n1;2', { delimiter: ';' }), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(c.parseCsv(''), []);
  throwsMessage(() => c.parseCsv('"open'), 'unterminated quoted field');
  assert.deepEqual(c.parseCsvObjects(' a , b\n1,2\n3,4\n'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  assert.deepEqual(c.parseCsvObjects(''), []);
  throwsMessage(() => c.parseCsvObjects('a,b\n1,2\n3\n'), 'line 3: expected 2 fields, got 1');
  assert.equal(c.formatCsvRow(['a', 'b,c', 'say "hi"', 'x\ny', 'cr\r', 5, null]), 'a,"b,c","say ""hi""","x\ny","cr\r",5,null');
  assert.equal(c.formatCsv([['a', 'b'], [1, 2]]), 'a,b\n1,2\n');
  assert.equal(c.formatCsv([['a']], { eol: '\r\n' }), 'a\r\n');
});
check('core validate: strings, integers, emails, phones and choices', () => {
  const v = core('validate');
  assert.equal(v.requireString('  ada ', 'name'), 'ada');
  throwsMessage(() => v.requireString('   ', 'name'), 'name is required');
  throwsMessage(() => v.requireString(5, 'name'), 'name is required');
  assert.equal(v.requireString(' abc ', 'name', { max: 3 }), 'abc');
  throwsMessage(() => v.requireString('abcd', 'name', { max: 3 }), 'name must be at most 3 characters');
  assert.equal(v.requireInteger(5, 'n'), 5);
  throwsMessage(() => v.requireInteger(1.5, 'n'), 'n must be a whole number');
  throwsMessage(() => v.requireInteger('5', 'n'), 'n must be a whole number');
  throwsMessage(() => v.requireInteger(0, 'n', { min: 1 }), 'n must be at least 1');
  throwsMessage(() => v.requireInteger(11, 'n', { min: 1, max: 10 }), 'n must be at most 10');
  assert.deepEqual(['a@b.co', 'a b@c.co', 'a@b', 'ab.co', 5].map(v.isEmail), [true, false, false, false, false]);
  assert.equal(v.normalizePhone('+1 (555) 123-4567'), '(555) 123-4567');
  assert.equal(v.normalizePhone(5551234567), '(555) 123-4567');
  throwsMessage(() => v.normalizePhone('25551234567'), 'invalid phone: 25551234567');
  throwsMessage(() => v.normalizePhone(undefined), 'invalid phone: undefined');
  assert.equal(v.oneOf('b', ['a', 'b'], 'kind'), 'b');
  throwsMessage(() => v.oneOf('c', ['a', 'b'], 'kind'), 'kind must be one of a, b');
});
check('core index re-exports every core function', () => {
  const index = core('index');
  for (const name of ['parseMoney', 'formatMoney', 'parseDate', 'formatDate', 'addDays', 'addMonths', 'daysBetween', 'dayOfWeek', 'isWeekend', 'monthKey', 'formatLong', 'parseUsDate', 'parseCsv', 'parseCsvObjects', 'formatCsvRow', 'formatCsv', 'requireString', 'requireInteger', 'isEmail', 'normalizePhone', 'oneOf']) assert.equal(typeof index[name], 'function', name);
});

// ---- each module moved, with no private helper left (SPEC.md section 6) ----
// Scored separately, so one miss costs one item: a module that doesn't use the core, one that keeps a helper, the core
// index, the core's tests and the README section are each their own item.
for (const [name, helpers] of Object.entries(modules)) {
  check(`${name}: requires from ./core`, () => {
    const source = readFileSync(path.join(repo, 'src', `${name}.js`), 'utf8');
    assert.match(source, /require\(\s*['"]\.\/core(\/[a-z]+)?(\.js)?['"]\s*\)/, 'requires from ./core');
  });
  check(`${name}: keeps none of its private helpers`, () => {
    const source = readFileSync(path.join(repo, 'src', `${name}.js`), 'utf8');
    const left = helpers.filter(helper => new RegExp(`\\b(function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+)${helper}\\b`).test(source));
    assert.deepEqual(left, [], `still defines ${left.join(', ')}`);
  });
}
// test/structure.test.js ships with the starting code, so it isn't a check: the plan's own gate runs it.
check('the core has its own tests', () => {
  for (const file of ['test/core/money.test.js', 'test/core/dates.test.js', 'test/core/csv.test.js', 'test/core/validate.test.js']) assert.ok(existsSync(path.join(repo, file)), file);
});
check('the README has a section on the core', () => {
  assert.match(readFileSync(path.join(repo, 'README.md'), 'utf8'), /^#{1,4}[^\n]*\bcore\b/im, 'a heading that names the core');
});

const failed = results.filter(result => !result.ok).map(result => result.name);
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed }));
process.exitCode = failed.length ? 1 : 0;

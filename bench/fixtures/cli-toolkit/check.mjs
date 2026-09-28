#!/usr/bin/env node
// The hidden acceptance check for the cli-toolkit fixture (docs/Benchmark.md). The benchmark harness runs it after
// each setup, on the result: `node check.mjs <repo>`. It is never copied into the repositories the agents work in.
// It checks what SPEC.md specifies, the same for both setups, and ends with a JSON summary line.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(repo, 'package.json'));
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`not ok - ${name}: ${String(error?.message ?? error).split('\n').slice(0, 3).join(' ').slice(0, 400)}`); }
}
const errors = () => require('./src/errors.js');
const command = name => {
  const loaded = require(`./src/commands/${name}.js`);
  for (const key of ['name', 'summary', 'usage', 'options', 'run']) assert.ok(loaded[key] !== undefined, `${name} exports ${key}`);
  return loaded;
};
/** Runs a command directly, with files from `files` (name → text) through readFile. */
const run = (name, positionals = [], options = {}, input = '', files = {}) => command(name).run({
  positionals, options, input,
  readFile: file => { if (!(file in files)) { const error = new Error(`ENOENT: ${file}`); error.code = 'ENOENT'; throw error; } return Buffer.from(files[file], 'utf8'); },
});
const stdoutOf = result => typeof result === 'string' ? result : result.stdout;
/** Asserts `fn` throws a UsageError (kind 'usage') or InputError ('input'), with `message` when given (a string is exact, a RegExp matches). */
function fails(fn, kind, message) {
  const { UsageError, InputError } = errors();
  let thrown;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, 'expected an error');
  assert.ok(thrown instanceof (kind === 'usage' ? UsageError : InputError), `expected a ${kind === 'usage' ? 'UsageError' : 'InputError'}, got ${thrown?.name}: ${thrown?.message}`);
  if (typeof message === 'string') assert.equal(thrown.message, message);
  else if (message) assert.match(thrown.message, message);
}
const cli = (args, input) => spawnSync(process.execPath, [path.join(repo, 'bin', 'toolkit.js'), ...args], { cwd: repo, input: input ?? '', encoding: 'utf8', windowsHide: true, timeout: 20_000 });

// ---- csv-stats (SPEC.md section 3) ----
const shop = 'name,price,qty\ntea,2.5,1\ncake,10,\npie,3.5,4\nbun,,2\n';
check('csv-stats: the numeric columns, tab-separated, with every statistic', () => {
  assert.equal(run('csv-stats', [], {}, shop), 'column\tcount\tmissing\tmin\tmax\tsum\tmean\tmedian\tstddev\nprice\t3\t1\t2.5\t10\t16\t5.3333\t3.5\t3.325\nqty\t3\t1\t1\t4\t7\t2.3333\t2\t1.2472\n');
});
check('csv-stats: --columns picks and orders columns; --json', () => {
  assert.deepEqual(JSON.parse(run('csv-stats', [], { columns: 'qty, price', json: true }, shop)), [
    { column: 'qty', count: 3, missing: 1, min: 1, max: 4, sum: 7, mean: 2.3333, median: 2, stddev: 1.2472 },
    { column: 'price', count: 3, missing: 1, min: 2.5, max: 10, sum: 16, mean: 5.3333, median: 3.5, stddev: 3.325 },
  ]);
});
check('csv-stats: the median of an even count, a file, and --delimiter', () => {
  const out = run('csv-stats', ['data.csv'], { delimiter: ';' }, '', { 'data.csv': 'x;label\n1;a\n2;b\n3;c\n10;d\n' });
  assert.equal(out, 'column\tcount\tmissing\tmin\tmax\tsum\tmean\tmedian\tstddev\nx\t4\t0\t1\t10\t16\t4\t2.5\t3.5355\n');
});
check('csv-stats: errors for an unknown column, a column that isn\'t numeric, and a ragged row', () => {
  fails(() => run('csv-stats', [], { columns: 'nope' }, shop), 'usage', 'unknown column: nope');
  fails(() => run('csv-stats', [], { columns: 'name' }, shop), 'input', 'column name is not numeric');
  fails(() => run('csv-stats', [], {}, 'a,b,c\n1,2,3\n4,5\n'), 'input', 'row 2 has 2 fields, expected 3');
});
check('csv-stats: empty input', () => {
  assert.equal(run('csv-stats', [], {}, ''), 'column\tcount\tmissing\tmin\tmax\tsum\tmean\tmedian\tstddev\n');
  assert.equal(run('csv-stats', [], { json: true }, ''), '[]\n');
});

// ---- json-query (section 4) ----
const doc = JSON.stringify({ a: { b: [10, 20, 30] }, 'odd key': 'x', items: [{ name: 'tea', price: 2.5, tags: ['hot', 'drink'] }, { name: 'cake', price: 4, tags: ['sweet'] }, { name: 'pie', price: 3.5, tags: [] }], obj: { z: 1, a: 2 }, nums: [3, 1, 3, 2], n: 5, nothing: null });
check('json-query: keys, indexes (negative and out of range), quoted keys, and null for what is missing', () => {
  assert.equal(run('json-query', ['.a.b[1]'], {}, doc), '20\n');
  assert.equal(run('json-query', ['.a.b[-1]'], {}, doc), '30\n');
  assert.equal(run('json-query', ['.a.b[7]'], {}, doc), 'null\n');
  assert.equal(run('json-query', ['.missing.deeper'], {}, doc), 'null\n');
  assert.equal(run('json-query', ['.nothing.x'], {}, doc), 'null\n');
  assert.equal(run('json-query', ['.["odd key"]'], {}, doc), '"x"\n');
  assert.equal(run('json-query', ['.a'], {}, doc), '{\n  "b": [\n    10,\n    20,\n    30\n  ]\n}\n');
  assert.equal(run('json-query', ['.'], { compact: true }, '{"k": [1, 2]}'), '{"k":[1,2]}\n');
});
check('json-query: [] iterates arrays and objects and flattens, with --raw and --compact', () => {
  assert.equal(run('json-query', ['.items[].name'], { raw: true }, doc), 'tea\ncake\npie\n');
  assert.equal(run('json-query', ['.items[].tags[]'], { compact: true }, doc), '["hot","drink","sweet"]\n');
  assert.equal(run('json-query', ['.obj[]'], { compact: true }, doc), '[1,2]\n');
  assert.equal(run('json-query', ['.items[0].name'], { raw: true }, doc), 'tea\n');
});
check('json-query: functions, chained', () => {
  assert.equal(run('json-query', ['.items[].price | sum'], {}, doc), '10\n');
  assert.equal(run('json-query', ['.items | length'], {}, doc), '3\n');
  assert.equal(run('json-query', ['.obj | keys'], { compact: true }, doc), '["a","z"]\n');
  assert.equal(run('json-query', ['.nums | unique'], { compact: true }, doc), '[1,2,3]\n');
  assert.equal(run('json-query', ['.nums | sort | last'], {}, doc), '3\n');
  assert.equal(run('json-query', ['.nums | first'], {}, doc), '3\n');
  assert.equal(run('json-query', ['.items[].name | sort'], { compact: true }, doc), '["cake","pie","tea"]\n');
});
check('json-query: errors', () => {
  fails(() => run('json-query', ['.n.b'], {}, doc), 'input', 'cannot index number with .b');
  fails(() => run('json-query', ['.a[0]'], {}, doc), 'input', 'cannot index object with [0]');
  fails(() => run('json-query', ['.a'], {}, '{nope'), 'input', /^invalid json/);
  fails(() => run('json-query', ['a.b'], {}, doc), 'usage', /^invalid path/);
  fails(() => run('json-query', ['.a | nope'], {}, doc), 'usage', 'unknown function: nope');
  fails(() => run('json-query', [], {}, doc), 'usage', 'missing path');
  fails(() => run('json-query', ['.items | sum'], {}, doc), 'input', 'cannot sum non-numbers');
  fails(() => run('json-query', ['.n | keys'], {}, doc), 'input', 'cannot apply keys to number');
});

// ---- wrap (section 5) ----
check('wrap: greedy filling at a width, and the default of 80', () => {
  assert.equal(run('wrap', [], { width: 20 }, 'The quick brown fox jumps over the lazy dog'), 'The quick brown fox\njumps over the lazy\ndog\n');
  assert.equal(run('wrap', [], { width: 19 }, 'The quick brown fox jumps'), 'The quick brown fox\njumps\n', 'a word exactly as long as the room left');
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  assert.ok(run('wrap', [], {}, words).split('\n').every(line => line.length <= 80));
  assert.equal(run('wrap', [], {}, words).split('\n')[0], Array.from({ length: 13 }, (_, i) => `word${i}`).join(' '));
});
check('wrap: paragraphs, --indent, and a file', () => {
  assert.equal(run('wrap', ['t.txt'], { width: 12, indent: 2 }, '', { 't.txt': 'one two three four\n\n  \t \n\nfive   six\nseven\n' }), '  one two\n  three four\n\n  five six\n  seven\n');
});
check('wrap: long words, with and without --break-long', () => {
  assert.equal(run('wrap', [], { width: 6 }, 'a abcdefghij b'), 'a\nabcdefghij\nb\n');
  assert.equal(run('wrap', [], { width: 6, 'break-long': true }, 'a abcdefghij b'), 'a\nabcdef\nghij\nb\n');
});
check('wrap: errors and empty input', () => {
  fails(() => run('wrap', [], { width: 0 }, 'x'), 'usage', 'invalid width');
  fails(() => run('wrap', [], { width: 10, indent: 10 }, 'x'), 'usage', 'invalid width');
  fails(() => run('wrap', [], { indent: -1 }, 'x'), 'usage', 'invalid indent');
  assert.equal(run('wrap', [], {}, ' \n\n  '), '');
});

// ---- date-diff (section 6) ----
const dd = (from, to, options = {}) => run('date-diff', [from, to], options);
check('date-diff: days and weeks, both ways, across a leap day', () => {
  assert.equal(dd('2024-01-01', '2024-03-01'), '60\n');
  assert.equal(dd('2024-03-01', '2024-01-01'), '-60\n');
  assert.equal(dd('2024-01-01', '2024-01-20', { unit: 'weeks' }), '2\n');
  assert.equal(dd('2024-01-20', '2024-01-01', { unit: 'weeks' }), '-2\n');
  assert.equal(dd('2024-05-05', '2024-05-05'), '0\n');
});
check('date-diff: months with end-of-month clamping, and years', () => {
  assert.equal(dd('2024-01-31', '2024-02-29', { unit: 'months' }), '1\n');
  assert.equal(dd('2023-01-31', '2023-02-28', { unit: 'months' }), '1\n');
  assert.equal(dd('2023-01-31', '2023-02-27', { unit: 'months' }), '0\n');
  assert.equal(dd('2024-01-31', '2024-03-30', { unit: 'months' }), '1\n');
  assert.equal(dd('2024-01-31', '2024-03-31', { unit: 'months' }), '2\n');
  assert.equal(dd('2024-03-31', '2024-01-31', { unit: 'months' }), '-2\n');
  assert.equal(dd('2020-02-29', '2021-02-28', { unit: 'years' }), '1\n');
  assert.equal(dd('2020-03-01', '2023-02-28', { unit: 'years' }), '2\n');
});
check('date-diff: --business counts weekdays in [from, to)', () => {
  assert.equal(dd('2024-06-07', '2024-06-10', { business: true }), '1\n');
  assert.equal(dd('2024-06-10', '2024-06-07', { business: true }), '-1\n');
  assert.equal(dd('2024-06-03', '2024-06-17', { business: true }), '10\n');
  assert.equal(dd('2024-06-08', '2024-06-08', { business: true }), '0\n');
});
check('date-diff: errors', () => {
  fails(() => dd('2023-02-29', '2023-03-01'), 'usage', 'invalid date: 2023-02-29');
  fails(() => dd('2023-13-01', '2023-03-01'), 'usage', 'invalid date: 2023-13-01');
  fails(() => dd('2023-3-1', '2023-03-01'), 'usage', 'invalid date: 2023-3-1');
  fails(() => run('date-diff', ['2023-01-01'], {}), 'usage', 'expected two dates');
  fails(() => dd('2023-01-01', '2023-02-01', { unit: 'weeks', business: true }), 'usage', '--business works only with days');
});

// ---- checksum (section 7) ----
check('checksum: every algorithm on standard input', () => {
  assert.equal(run('checksum', [], { algo: 'crc32' }, '123456789'), 'cbf43926  -\n');
  assert.equal(run('checksum', [], {}, 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n');
  assert.equal(run('checksum', [], { algo: 'sha1' }, 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d  -\n');
  assert.equal(run('checksum', [], { algo: 'md5' }, 'abc'), '900150983cd24fb0d6963f7d28e17f72  -\n');
  assert.equal(run('checksum', [], { algo: 'crc32' }, ''), '00000000  -\n');
});
const files = { 'a.txt': 'abc', 'b.txt': '123456789' };
check('checksum: files in order, and a file that can\'t be read', () => {
  assert.equal(run('checksum', ['b.txt', 'a.txt'], { algo: 'crc32' }, '', files), 'cbf43926  b.txt\n352441c2  a.txt\n');
  fails(() => run('checksum', ['nope.txt'], {}, '', files), 'input', 'cannot read nope.txt');
});
check('checksum: --check reports OK, FAILED and MISSING, with exit code 1 unless all are OK', () => {
  const list = 'cbf43926  b.txt\n\n00000000  a.txt\n352441c2  gone.txt\n';
  const result = run('checksum', [], { algo: 'crc32', check: true }, list, files);
  assert.equal(typeof result, 'object');
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'b.txt: OK\na.txt: FAILED\ngone.txt: MISSING\n');
  assert.equal(stdoutOf(run('checksum', ['sums.txt'], { algo: 'crc32', check: true }, '', { ...files, 'sums.txt': 'cbf43926  b.txt\n352441c2  a.txt\n' })), 'b.txt: OK\na.txt: OK\n');
  const ok = run('checksum', [], { algo: 'crc32', check: true }, 'cbf43926  b.txt\n', files);
  assert.ok(typeof ok === 'string' || ok.exitCode === 0 || ok.exitCode === undefined);
  fails(() => run('checksum', [], { algo: 'crc32', check: true }, 'cbf43926  b.txt\nnot a line\n', files), 'input', 'line 2 is malformed');
});

// ---- table (section 8) ----
check('table: the example from the spec, numbers aligned right', () => {
  assert.equal(run('table', [], {}, 'name,price\ntea,3.50\ncake,12.00\n'), '+------+-------+\n| name | price |\n+------+-------+\n| tea  |  3.50 |\n| cake | 12.00 |\n+------+-------+\n');
});
check('table: JSON input, keys in first-seen order, empty and non-string cells', () => {
  const input = JSON.stringify([{ id: 1, name: 'a' }, { name: 'bb', ok: true, extra: null }, { id: 22, meta: { x: 1 } }]);
  assert.equal(run('table', [], { format: 'json' }, input),
    '+----+------+------+-------+---------+\n| id | name | ok   | extra | meta    |\n+----+------+------+-------+---------+\n|  1 | a    |      |       |         |\n|    | bb   | true |       |         |\n| 22 |      |      |       | {"x":1} |\n+----+------+------+-------+---------+\n');
  fails(() => run('table', [], { format: 'json' }, '{"a":1}'), 'input', 'expected an array of objects');
});
check('table: --align, centering with an odd leftover, and headers aligning with their column', () => {
  assert.equal(run('table', [], { align: 'name:center,qty:left' }, 'name,qty\nab,1\nabcdef,100\n'), '+--------+-----+\n|  name  | qty |\n+--------+-----+\n|   ab   | 1   |\n| abcdef | 100 |\n+--------+-----+\n');
  assert.equal(run('table', [], { align: 'x:center' }, 'x\nabcd\nab\na\n'), '+------+\n|  x   |\n+------+\n| abcd |\n|  ab  |\n|  a   |\n+------+\n');
  fails(() => run('table', [], { align: 'nope:left' }, 'a\n1\n'), 'usage', 'invalid align: nope:left');
  fails(() => run('table', [], { align: 'a:up' }, 'a\n1\n'), 'usage', 'invalid align: a:up');
});
check('table: --max-width, TSV, trimming, a header with no rows, and empty input', () => {
  assert.equal(run('table', [], { 'max-width': 4 }, 'word\nabcdefg\nabcd\n'), '+------+\n| word |\n+------+\n| abc… |\n| abcd |\n+------+\n');
  assert.equal(run('table', [], { format: 'tsv' }, 'a\tb\n x \t2\n'), '+---+---+\n| a | b |\n+---+---+\n| x | 2 |\n+---+---+\n');
  assert.equal(run('table', [], {}, 'only,header\n'), '+------+--------+\n| only | header |\n+------+--------+\n+------+--------+\n');
  assert.equal(run('table', [], {}, ''), '');
  fails(() => run('table', [], { 'max-width': 1 }, 'a\n1\n'), 'usage', 'invalid max-width');
});

// ---- case (section 9) ----
const conv = (to, input) => run('case', [], { to }, input);
check('case: every style on camel, capitals and punctuation', () => {
  const input = 'XMLHttpRequest\nhello_world-foo bar\n';
  assert.equal(conv('camel', input), 'xmlHttpRequest\nhelloWorldFooBar\n');
  assert.equal(conv('pascal', input), 'XmlHttpRequest\nHelloWorldFooBar\n');
  assert.equal(conv('snake', input), 'xml_http_request\nhello_world_foo_bar\n');
  assert.equal(conv('kebab', input), 'xml-http-request\nhello-world-foo-bar\n');
  assert.equal(conv('constant', input), 'XML_HTTP_REQUEST\nHELLO_WORLD_FOO_BAR\n');
  assert.equal(conv('sentence', input), 'Xml http request\nHello world foo bar\n');
});
check('case: digits stay with the letters before them; title case keeps small words low except first and last', () => {
  assert.equal(conv('snake', 'version2Beta'), 'version2_beta\n');
  assert.equal(conv('title', 'the lord of the rings\nwhat it is for\nA TALE OF TWO CITIES'), 'The Lord of the Rings\nWhat It Is For\nA Tale of Two Cities\n');
});
check('case: lines, empty lines, lines with no words, and errors', () => {
  assert.equal(conv('camel', 'foo bar\n\n---\nbaz\n'), 'fooBar\n\n\nbaz\n');
  assert.equal(conv('camel', ''), '');
  fails(() => run('case', [], {}, 'x'), 'usage', 'missing --to');
});

// ---- the command line (section 10) ----
check('parseArgs: values, =values, booleans, defaults, --, - and help', () => {
  const { parseArgs } = require('./src/args.js');
  const specs = { width: { type: 'number', default: 80 }, name: { type: 'string' }, mode: { type: 'string', choices: ['a', 'b'], default: 'a' }, loud: { type: 'boolean', default: false } };
  const parsed = parseArgs(['--width', '10', 'x', '--name=n=1', '--loud', '-', '--mode', 'b', '--width=12', '--', '--loud', '-h'], specs);
  assert.deepEqual(parsed.positionals, ['x', '-', '--loud', '-h']);
  assert.deepEqual(parsed.options, { width: 12, name: 'n=1', loud: true, mode: 'b' });
  assert.ok(!parsed.help);
  const defaults = parseArgs(['-h'], specs);
  assert.deepEqual(defaults.options, { width: 80, mode: 'a', loud: false });
  assert.equal(defaults.help, true);
  assert.equal(parseArgs(['--help'], specs).help, true);
});
check('parseArgs: errors', () => {
  const { parseArgs } = require('./src/args.js');
  const specs = { width: { type: 'number', default: 80 }, mode: { type: 'string', choices: ['a', 'b'] }, loud: { type: 'boolean' } };
  fails(() => parseArgs(['--nope'], specs), 'usage', 'unknown option --nope');
  fails(() => parseArgs(['--width'], specs), 'usage', '--width needs a value');
  fails(() => parseArgs(['--width', 'abc'], specs), 'usage', '--width expects a number');
  fails(() => parseArgs(['--mode', 'c'], specs), 'usage', '--mode must be one of a, b');
  fails(() => parseArgs(['--loud=yes'], specs), 'usage', '--loud takes no value');
});
check('src/commands/index.js lists every command, sorted by name', () => {
  assert.deepEqual(require('./src/commands/index.js').map(item => item.name), ['case', 'checksum', 'csv-stats', 'date-diff', 'echo', 'json-query', 'table', 'wrap']);
});
check('toolkit: the general help, exactly', () => {
  const list = require('./src/commands/index.js');
  const width = Math.max(...list.map(item => item.name.length)) + 2;
  const expected = ['Usage: toolkit <command> [options] [args]', '', 'Commands:', ...list.map(item => `  ${item.name.padEnd(width)}${item.summary}`), '', 'Run "toolkit help <command>" for a command\'s options.', ''].join('\n');
  for (const args of [[], ['help']]) { const result = cli(args); assert.equal(result.status, 0); assert.equal(result.stdout, expected); }
});
check('toolkit: a command\'s help, from help <command> and --help', () => {
  const wrap = require('./src/commands/wrap.js');
  for (const args of [['help', 'wrap'], ['wrap', '--help'], ['wrap', '-h']]) {
    const result = cli(args);
    assert.equal(result.status, 0, args.join(' '));
    assert.ok(result.stdout.startsWith(`Usage: ${wrap.usage}\n\n${wrap.summary}\n\nOptions:\n`), result.stdout);
    assert.match(result.stdout, /^ {2}--width <number> {2}.*\(default: 80\)$/m);
    assert.match(result.stdout, /^ {2}--break-long {2}\S/m);
  }
});
check('toolkit: --version, an unknown command, and exit codes for usage and input errors', () => {
  assert.equal(cli(['--version']).stdout, 'toolkit 1.0.0\n');
  const unknown = cli(['nope']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, 'toolkit: unknown command "nope". Run "toolkit help".\n');
  const usage = cli(['wrap', '--width', 'abc']);
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr, 'toolkit wrap: --width expects a number\n');
  const input = cli(['json-query', '.a'], 'nope');
  assert.equal(input.status, 1);
  assert.match(input.stderr, /^toolkit json-query: invalid json/);
});
check('toolkit: runs commands end to end, with standard input, files, -- and exit codes', () => {
  assert.equal(cli(['case', '--to', 'snake'], 'Hello World\n').stdout, 'hello_world\n');
  const folder = mkdtempSync(path.join(tmpdir(), 'toolkit-check-'));
  try {
    writeFileSync(path.join(folder, 'data.csv'), 'x,y\n1,a\n3,b\n');
    assert.equal(cli(['csv-stats', '--columns=x', path.join(folder, 'data.csv')]).stdout, 'column\tcount\tmissing\tmin\tmax\tsum\tmean\tmedian\tstddev\nx\t2\t0\t1\t3\t4\t2\t2\t1\n');
  } finally { rmSync(folder, { recursive: true, force: true }); }
  assert.equal(cli(['echo', '--', '--upper', 'x']).stdout, '--upper x\n');
  assert.equal(cli(['echo', '--upper', 'x']).stdout, 'X\n');
  assert.equal(cli(['date-diff', '2024-01-01', '2024-01-08', '--unit', 'weeks']).stdout, '1\n');
  const check = cli(['checksum', '--algo', 'crc32', '--check'], '00000000  package.json\n');
  assert.equal(check.status, 1);
  assert.equal(check.stdout, 'package.json: FAILED\n');
  assert.equal(cli(['table', '--format', 'json'], '[{"a":1}]').stdout, '+---+\n| a |\n+---+\n| 1 |\n+---+\n');
});

const failed = results.filter(result => !result.ok).map(result => result.name);
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed }));
process.exitCode = failed.length ? 1 : 0;

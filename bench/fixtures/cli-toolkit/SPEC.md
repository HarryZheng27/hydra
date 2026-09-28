# toolkit: specification

This is the exact behaviour every part of `toolkit` must have. Where it gives an output format, match it character for character. Plain Node (CommonJS, Node 20 or later), no dependencies.

## 1. The command contract

Every command is one module, `src/commands/<name>.js`, exporting one object:

```js
module.exports = {
  name: 'wrap',                       // the command's name, as typed after `toolkit`
  summary: 'Wrap text to a width',    // one line, under 60 characters, no trailing period
  usage: 'toolkit wrap [--width N] [--indent N] [--break-long] [file]',
  input: true,                        // false when the command never reads standard input
  options: {                          // every option it accepts, by name without the dashes
    width: { type: 'number', default: 80, description: 'Line width' },
    indent: { type: 'number', default: 0, description: 'Spaces before every line' },
    'break-long': { type: 'boolean', default: false, description: 'Split words longer than a line' },
  },
  run(context) { /* … */ },
};
```

- An option's `type` is `'string'`, `'number'` or `'boolean'`. A string option may have `choices: [...]`, the only values it accepts. `default` may be left out for a string option that has none.
- `run(context)` is synchronous. `context` is `{ positionals, options, input, readFile }`:
  - `positionals`: the arguments that aren't options, as strings, in order.
  - `options`: option values by name, already of the right type. **Any option may be missing** (a test can call `run` directly): `run` then uses that option's `default`.
  - `input`: all of standard input as a UTF-8 string (`''` when there is none).
  - `readFile(path)`: returns the file's bytes as a Buffer, or throws (as `fs.readFileSync` does) when it can't be read.
- Commands that take a `[file]` read the first positional with `readFile` when one is given, and `input` otherwise.
- `run` returns the text to print on standard output: a string, which ends with `\n` unless it is empty. A command that must also fail after printing returns `{ stdout, exitCode }` instead.
- Errors: `run` throws `UsageError` (from `src/errors.js`, exit code 2) for bad arguments or options, and `InputError` (exit code 1) for input it can't process or a file it can't read. Messages are one line, lower case, with no trailing period. Where this spec gives a message, use it exactly.

`src/commands/echo.js` already follows the contract; use it as the example.

## 2. CSV (already in `src/csv.js`)

`parseCsv(text, delimiter = ',')` returns the records as arrays of strings, per RFC 4180: fields may be quoted with `"`; a quoted field may contain the delimiter, newlines, and `""` for one quote. Records end with `\n` or `\r\n`; a final line ending doesn't start another record; blank lines (outside quotes) are skipped. Commands that read CSV use it.

A value is **numeric** when, after trimming spaces, it matches `/^-?\d+(\.\d+)?$/` (`isNumeric(value)`, also in `src/csv.js`).

Numbers in output are **rounded to 4 decimal places** and printed with no trailing zeros: `String(Number(x.toFixed(4)))`, and `-0` prints as `0` (`formatNumber(x)`, also in `src/csv.js`).

## 3. `toolkit csv-stats [--columns a,b] [--delimiter ,] [--json] [file]`

Statistics for the numeric columns of a CSV file whose first record is the header.

- Options: `columns` (string), `delimiter` (string, default `,`), `json` (boolean, default false). `input: true`.
- A **numeric column** has at least one non-empty value, and every non-empty value (after trimming) is numeric. Empty values (after trimming) are **missing**.
- Without `--columns`: every numeric column, in header order. With `--columns a,b` (names separated by commas, trimmed): exactly those, in that order.
  - A name that isn't in the header: `UsageError` with the message `unknown column: <name>`.
  - A named column that isn't numeric: `InputError` with the message `column <name> is not numeric`.
- A data record with a different number of fields than the header: `InputError` with the message `row <n> has <m> fields, expected <h>`, where `n` counts data records from 1.
- Per column: `count` (non-empty values), `missing`, `min`, `max`, `sum`, `mean`, `median` (the mean of the middle two for an even count), `stddev` (population: the square root of the mean squared distance from the mean). All numbers rounded as in section 2.
- Text output: a header line, then one line per column, fields separated by a tab (`\t`). For the input

  ```
  name,price,qty
  tea,2.5,1
  cake,10,
  pie,3.5,4
  bun,,2
  ```

  the output is (tabs between the fields):

  ```
  column	count	missing	min	max	sum	mean	median	stddev
  price	3	1	2.5	10	16	5.3333	3.5	3.325
  qty	3	1	1	4	7	2.3333	2	1.2472
  ```
- `--json`: `JSON.stringify(list, null, 2)` plus `\n`, where `list` is an array of `{ column, count, missing, min, max, sum, mean, median, stddev }` in the same order, numbers rounded.
- Empty input (no header): the text output is only the header line; the JSON output is `[]`.

## 4. `toolkit json-query <path> [--raw] [--compact] [file]`

Picks values out of a JSON document.

- Options: `raw` (boolean, default false), `compact` (boolean, default false). `input: true`. The path is the first positional (missing: `UsageError` `missing path`); the file, if any, the second.
- Invalid JSON: `InputError` with a message starting `invalid json`.
- **Paths** start with `.`. After it come any number of steps:
  - `.name`: an object key; `name` matches `[A-Za-z_][A-Za-z0-9_]*`. The path's leading `.` doubles as the first step's dot, so `.a.b` is key `a` then key `b`, `.[0]` and `.a[0]` are indexes, and `.` alone is the whole document.
  - `["key"]`: any key, as a JSON string.
  - `[n]`: an array index; `n` is an integer, and a negative one counts from the end (`[-1]` is the last element).
  - `[]`: every element of an array, or every value of an object in the order its keys appear in the document; the rest of the path applies to each.
  - Anything else is a `UsageError` with a message starting `invalid path`.
- A missing key or an index out of range gives `null`. A step on `null` gives `null`. A key step on a non-object (a number, string, boolean or array), or an index step on a non-array: `InputError` with the message `cannot index <type> with <step>`, where `<type>` is `number`, `string`, `boolean`, `array` or `object`, and `<step>` is the step as written (`.name`, `["key"]`, `[0]`).
- **Results.** A path without `[]` has one result. A path with one or more `[]` has as its result the array of every value produced, in order, flattened across all its `[]` (`.a[].b[]` on `{"a":[{"b":[1,2]},{"b":[3]}]}` is `[1,2,3]`). `[]` on `null` produces nothing; `[]` on anything else that isn't an array or object is an `InputError` `cannot iterate <type>`.
- **Functions.** The path may be followed by `| <function>`, any number of times, each applied to the result so far: `length` (array or string length, object key count, `0` for `null`), `keys` (an object's keys sorted, or an array's indices), `first`, `last` (an array's element or `null` when empty), `sort` (numbers ascending, or strings by code unit; any other mix is an `InputError` `cannot sort mixed values`), `unique` (sorted like `sort`, duplicates removed), `sum` (of an array of numbers; anything else is an `InputError` `cannot sum non-numbers`). Any other name: `UsageError` `unknown function: <name>`. A function applied to the wrong type (for example `keys` on a number): `InputError` `cannot apply <function> to <type>`.
- **Output:** `JSON.stringify(result, null, 2)` plus `\n`; with `--compact`, `JSON.stringify(result)` plus `\n`. With `--raw`, a string result prints as the string itself, and an array whose every element is a string prints one string per line; anything else prints as without `--raw`.

## 5. `toolkit wrap [--width N] [--indent N] [--break-long] [file]`

Wraps text into lines.

- Options as in section 1's example. `input: true`.
- `width` and `indent` must be whole numbers, `indent` at least 0, and `width - indent` at least 1; otherwise `UsageError` `invalid width` (or `invalid indent` for a bad indent).
- **Paragraphs** are separated by one or more blank lines (lines with only spaces and tabs). **Words** are runs of non-whitespace characters. Lengths are counted in UTF-16 code units (`string.length`).
- Each paragraph is filled greedily: each line takes as many words as fit, separated by single spaces, within `width` columns including the indent (`indent` spaces start every line).
- A word longer than `width - indent`: without `--break-long`, it goes on a line of its own, unbroken; with `--break-long`, it's cut into pieces of exactly `width - indent` characters (the last may be shorter), each on its own line, and the next word starts a new line.
- Output paragraphs are separated by exactly one empty line. The output ends with one `\n`. Input with no words gives `''`.

## 6. `toolkit date-diff <from> <to> [--unit days|weeks|months|years] [--business]`

The difference between two dates.

- Options: `unit` (string, choices `days`, `weeks`, `months`, `years`, default `days`), `business` (boolean, default false). `input: false`.
- `from` and `to` are the first two positionals, `YYYY-MM-DD` real calendar dates (leap years count). Missing: `UsageError` `expected two dates`. Invalid: `UsageError` `invalid date: <value>`.
- The result is signed: positive when `to` is after `from`.
  - `days`: calendar days from `from` to `to`.
  - `weeks`: whole weeks, `days / 7` truncated toward zero.
  - `months`: for `from <= to`, the largest `n` such that `from` plus `n` months is on or before `to`, where adding months keeps the day of the month but clamps it to the last day of a shorter month (January 31 plus 1 month is February 28, or 29 in a leap year). For `from > to`, minus the result with the two swapped.
  - `years`: `months / 12` truncated toward zero.
- `--business` counts the weekdays (Monday to Friday) in `[from, to)`: `from` included, `to` excluded; for `from > to`, minus the count with the two swapped. It works only with `--unit days` (`UsageError` `--business works only with days` otherwise).
- Output: the number and `\n`, for example `-3\n`.

## 7. `toolkit checksum [--algo sha256|sha1|md5|crc32] [--check] [files…]`

Checksums, like `sha256sum`.

- Options: `algo` (string, choices `sha256`, `sha1`, `md5`, `crc32`, default `sha256`), `check` (boolean, default false). `input: true`.
- Without files: one line for standard input, `<hex>  -` (two spaces). With files: one line per file in the order given, `<hex>  <file>`. A file that can't be read: `InputError` `cannot read <file>`.
- `sha256`, `sha1`, `md5`: Node's `crypto`, lowercase hex. `crc32`: the standard CRC-32 (IEEE, reflected polynomial `0xEDB88320`, initial value and final XOR `0xFFFFFFFF`), written by hand, as 8 lowercase hex digits with leading zeros (`crc32` of `123456789` is `cbf43926`).
- `--check`: reads checksum lines (from the files given, else standard input), each `<hex>  <file>`; blank lines are skipped. For each, it hashes that file with `--algo` and prints `<file>: OK`, `<file>: FAILED` (different hash) or `<file>: MISSING` (can't be read). A line that isn't a hex string, two spaces and a file name: `InputError` `line <n> is malformed` (`n` counts the lines of that list from 1). When any line isn't OK, it returns `{ stdout, exitCode: 1 }`.

## 8. `toolkit table [--format csv|tsv|json] [--align spec] [--max-width N] [file]`

Formats rows as a text table.

- Options: `format` (string, choices `csv`, `tsv`, `json`, default `csv`), `align` (string), `max-width` (number). `input: true`.
- Input: CSV (the first record is the header) or TSV (the same with a tab delimiter), both through `parseCsv`; or `json`, an array of objects: the columns are every key in the order first seen, a missing key or `null` is an empty cell, a string is itself, and any other value is `JSON.stringify(value)`. JSON that isn't an array of objects: `InputError` `expected an array of objects`.
- Cells and headers are trimmed of surrounding spaces. With `--max-width N` (a whole number, at least 2; otherwise `UsageError` `invalid max-width`), a cell or header longer than `N` becomes its first `N - 1` characters followed by `…`.
- Each column is as wide as its longest header or cell. A column is **numeric** when it has at least one non-empty cell and every non-empty cell is numeric (section 2). Numeric columns align right; others left. `--align name:right,other:center` overrides by header name (`left`, `right` or `center`; an unknown column or alignment: `UsageError` `invalid align: <item>`). Centered text puts the extra space on the right when it can't split evenly. Headers align like their column.
- Output, for a header and two rows:

  ```
  +------+-------+
  | name | price |
  +------+-------+
  | tea  |  3.50 |
  | cake | 12.00 |
  +------+-------+
  ```

  Every line ends with `\n`. With a header and no rows, the output is the border, the header line, and the border twice more (once after the header, once at the bottom). Empty input gives `''`.

## 9. `toolkit case --to <style> [file]`

Converts each line of text to a naming style.

- Options: `to` (string, required, choices `camel`, `pascal`, `snake`, `kebab`, `constant`, `title`, `sentence`; missing: `UsageError` `missing --to`). `input: true`.
- Each input line is converted on its own; the output has one line per input line (a final line ending in the input doesn't add an empty line), each ending with `\n`. Input `''` gives `''`.
- **Words:** split the line at every character that isn't an ASCII letter or digit; then split each piece where a lower-case letter or digit is followed by an upper-case letter (`fooBar` → `foo`, `Bar`), and where an upper-case letter is followed by an upper-case letter and then a lower-case one (`XMLHttp` → `XML`, `Http`). Digits stay with the letters before them (`version2Beta` → `version2`, `Beta`). Words are then lower-cased.
- **Styles**, where *capitalized* means the first character upper case and the rest lower case:
  - `camel`: the first word, then the rest capitalized, joined: `xmlHttpRequest`.
  - `pascal`: every word capitalized, joined: `XmlHttpRequest`.
  - `snake`: joined with `_`; `kebab`: joined with `-`; `constant`: upper-cased, joined with `_`.
  - `title`: every word capitalized, joined with spaces, except these small words, which stay lower case unless they are the first or last word: `a an and as at but by for in of on or the to`.
  - `sentence`: the first word capitalized, the rest lower case, joined with spaces.
- A line with no words gives an empty line.

## 10. The command line: `src/cli.js`, `src/args.js`, `src/commands/index.js`, `bin/toolkit.js`

- `src/commands/index.js` exports the array of every command module (echo and the seven above), sorted by name.
- `parseArgs(argv, options)` in `src/args.js` returns `{ positionals, options, help }` for one command's arguments, with `options` its option specs:
  - `--name value` and `--name=value` set an option; a boolean option is `--name` alone (`--name=value` for a boolean: `UsageError` `--name takes no value`).
  - A number option's value must be a finite number (`UsageError` `--name expects a number`); a string option with `choices` must be one of them (`UsageError` `--name must be one of a, b, c`).
  - An option that isn't in `options`: `UsageError` `unknown option --name`. An option missing its value: `UsageError` `--name needs a value`. The last of a repeated option wins.
  - `--` ends the options: everything after it is positional. `-` alone is positional.
  - `-h` or `--help` (before any `--`) sets `help: true`.
  - Every option that wasn't given and has a `default` gets it.
- `main(argv, io)` in `src/cli.js` returns a Promise of the exit code. `argv` is the arguments after `toolkit`; `io` is `{ readStdin, readFile, stdout, stderr }`: `readStdin()` returns (or resolves to) standard input as a string, `readFile(path)` returns a Buffer, and `stdout(text)` and `stderr(text)` write text.
  - No arguments, or `help`: prints the general help and returns 0. It is exactly: `Usage: toolkit <command> [options] [args]`, an empty line, `Commands:`, then one line per command: two spaces, the name padded with spaces to the longest name's length plus two, and its summary; then an empty line and `Run "toolkit help <command>" for a command's options.`
  - `help <command>`, or a command with `--help`/`-h`: prints the command's help and returns 0: `Usage: <usage>`, an empty line, the summary, and, when it has options, an empty line, `Options:` and one line per option: two spaces, `--<name>`, then for a string or number option a space and `<string>` or `<number>`, two spaces, the description, and `(default: <value>)` after it when it has a default other than `false`.
  - `--version`: prints `toolkit <version>` from package.json and returns 0.
  - An unknown command: prints `toolkit: unknown command "<name>". Run "toolkit help".` to stderr and returns 2.
  - Otherwise it parses the arguments, reads standard input only when the command's `input` isn't false, runs the command with `readFile` from `io`, prints its output to stdout, and returns its exit code (0 for a string).
  - A `UsageError` prints `toolkit <command>: <message>` to stderr and returns 2; an `InputError` or any other error prints the same and returns 1.
  - Every line printed ends with `\n`.
- `bin/toolkit.js` calls `main` with `process.argv.slice(2)` and real `io` (standard input read only when `main` asks, and `''` when it's a terminal), and exits with its code.

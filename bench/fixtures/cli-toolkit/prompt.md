# Toolkit subcommands and command line

Build the toolkit to SPEC.md: seven independent subcommands, each its own module with its own tests, the command line core (arguments, help, --version, errors) at the same time, then the command line end to end with a Usage section in the README. Plain Node, CommonJS, no dependencies. SPEC.md is exact about every option, output format and error message: match it character for character. Every command follows the command contract in SPEC.md section 1 (src/commands/echo.js is the example) and reads CSV and numbers through src/csv.js. Each command job touches only its own two files. Run `npm test` before finishing.

Do all of the following yourself, then make sure `npm test` passes.

## 1. csv-stats: statistics for CSV columns

Implement `toolkit csv-stats` exactly as SPEC.md section 3 says, following the command contract in section 1 (src/commands/echo.js is an example) and using parseCsv, isNumeric and formatNumber from src/csv.js. Create src/commands/csv-stats.js and test/csv-stats.test.js. The tests call run() directly and cover every rule of section 3: the default numeric columns, --columns (its order, an unknown column, a column that isn't numeric), missing values, a record with the wrong number of fields, every statistic (including the median of an even count and the population standard deviation), rounding, the tab-separated output, --json, --delimiter, empty input, and reading a file through readFile. Change no other file: running it from the command line is another job's work.

Files: src/commands/csv-stats.js, test/csv-stats.test.js

## 2. json-query: pick values out of JSON

Implement `toolkit json-query` exactly as SPEC.md section 4 says, following the command contract in section 1 (src/commands/echo.js is an example). Create src/commands/json-query.js and test/json-query.test.js. Write the path parser yourself (keys, quoted keys, positive and negative indexes, [] iteration with flattening) and the functions (length, keys, first, last, sort, unique, sum, chained with |). The tests call run() directly and cover every rule of section 4: each kind of step, missing keys and out-of-range indexes giving null, null propagating, iterating arrays and objects, nested iteration, each function and its errors, invalid paths, invalid JSON, indexing the wrong type (with the exact message), and the output modes (pretty, --compact, --raw for a string and for an array of strings). Change no other file.

Files: src/commands/json-query.js, test/json-query.test.js

## 3. wrap: fill text to a width

Implement `toolkit wrap` exactly as SPEC.md section 5 says, following the command contract in section 1 (src/commands/echo.js is an example). Create src/commands/wrap.js and test/wrap.test.js. The tests call run() directly and cover every rule of section 5: greedy filling at the default and a custom width, a word exactly as long as the room left, paragraphs separated by several blank lines (including lines of spaces) coming out separated by exactly one, --indent, a word longer than a line with and without --break-long, the errors for a bad width or indent, input with no words, and reading a file through readFile. Change no other file.

Files: src/commands/wrap.js, test/wrap.test.js

## 4. date-diff: the difference between two dates

Implement `toolkit date-diff` exactly as SPEC.md section 6 says, following the command contract in section 1 (src/commands/echo.js is an example). Create src/commands/date-diff.js and test/date-diff.test.js. Work in whole calendar days (UTC dates, no local time zone) so daylight saving never shifts a result. The tests call run() directly and cover every rule of section 6: days, weeks and years both ways, months with the end-of-month clamping (January 31 to February 28 and 29, and to March 30 and 31), leap years, invalid dates (February 30, month 13, a wrong format) and a missing date, --business across weekends in both directions and on the same day, and --business with another unit. Change no other file.

Files: src/commands/date-diff.js, test/date-diff.test.js

## 5. checksum: hashes and CRC-32

Implement `toolkit checksum` exactly as SPEC.md section 7 says, following the command contract in section 1 (src/commands/echo.js is an example). Create src/commands/checksum.js and test/checksum.test.js. Use node:crypto for sha256, sha1 and md5, and write CRC-32 yourself (a table-driven implementation is fine). The tests call run() directly, with a readFile stand-in over an in-memory set of files, and cover every rule of section 7: each algorithm on standard input and on several files (known values, such as crc32 of 123456789 being cbf43926), a file that can't be read, --check with OK, FAILED and MISSING lines and its exit code, blank lines in a list, and a malformed line. Change no other file.

Files: src/commands/checksum.js, test/checksum.test.js

## 6. table: rows as a bordered text table

Implement `toolkit table` exactly as SPEC.md section 8 says, following the command contract in section 1 (src/commands/echo.js is an example) and using parseCsv and isNumeric from src/csv.js. Create src/commands/table.js and test/table.test.js. The tests call run() directly and compare whole outputs, covering every rule of section 8: CSV, TSV and JSON input (keys in first-seen order, missing and null cells, non-string values), numeric columns aligning right, --align with left, right and center (including an odd leftover space) and its error, --max-width and its error, trimming, a header with no rows, empty input, and JSON that isn't an array of objects. Change no other file.

Files: src/commands/table.js, test/table.test.js

## 7. case: convert names between styles

Implement `toolkit case` exactly as SPEC.md section 9 says, following the command contract in section 1 (src/commands/echo.js is an example). Create src/commands/case.js and test/case.test.js. The tests call run() directly and cover every rule of section 9: splitting on punctuation and spaces, at lower-to-upper boundaries, inside runs of capitals (XMLHttpRequest), and keeping digits with the letters before them; every style; title case's small words, including as the first and last word; several lines, an empty line, a line with no words, and a final line ending; and a missing --to. Change no other file.

Files: src/commands/case.js, test/case.test.js

## 8. The command line core: arguments, help, version and errors

Write the parts of toolkit's command line that don't need the seven new commands, exactly as SPEC.md section 10 says, following the command contract in section 1 (src/commands/echo.js is the example command, src/errors.js has the errors). Create src/args.js (parseArgs) and src/commands/index.js, which exports the array of every command module in src/commands/ sorted by name (read the folder and require each .js file except index.js, so the commands other jobs add appear by themselves). Rewrite src/cli.js: main(argv, io, commands = require('./commands/index')) with the general help, a command's help (`help <command>`, `--help`, `-h`), --version (from package.json), an unknown command, parsing the arguments, reading standard input only for a command whose input isn't false, running the command with readFile from io, printing its output, its exit code (a string result is 0, { stdout, exitCode } is that code), and errors: a UsageError is exit code 2 and any other error exit code 1, each printed as `toolkit <command>: <message>`. Keep bin/toolkit.js working as SPEC.md says. Tests: test/args.test.js for every parseArgs rule, and test/cli.test.js, replacing the current one, for the help texts (character for character), --version, an unknown command, a usage error, an input error, a command that returns an exit code, and standard input being read only when it should be, all through stand-in command modules passed as main's third argument (the seven commands are being written at the same time, by someone else, so the tests mustn't require them). Change no other file.

Files: src/args.js, src/commands/index.js, src/cli.js, bin/toolkit.js, test/args.test.js, test/cli.test.js

## 9. The command line end to end, and the README

Finish toolkit's command line as SPEC.md section 10 says. The seven commands csv-stats, json-query, wrap, date-diff, checksum, table and case now exist in src/commands/, each following the contract in section 1, and the command line core (src/args.js, src/commands/index.js, src/cli.js, bin/toolkit.js, with their tests) exists too: read them, and read the commands' options from the modules rather than assuming them. Write test/toolkit.test.js: the general help through bin/toolkit.js lists all eight commands, `help <command>` for every command matches its module's usage, summary and options, --version, and one end-to-end run of each command through bin/toolkit.js with child_process (real standard input for the commands that read it). Add a Usage section to README.md with one example per command. Don't change the command modules or the command line core; if one breaks the contract or section 10, say so in your summary.

Files: test/toolkit.test.js, README.md

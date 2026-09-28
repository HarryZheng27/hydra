# toolkit

A small command-line toolkit in plain Node (CommonJS, no dependencies): one `toolkit` command with subcommands, each its own module in `src/commands/`.

Today it has one subcommand, `echo`, the example of the command contract, and a bare-bones `src/cli.js` that runs only that. `src/csv.js` has a CSV parser and number helpers the commands share.

```
node bin/toolkit.js echo hello world
npm test
```

## The task

Build the rest of the toolkit to [SPEC.md](SPEC.md), which is exact about every command's options, output and errors:

- seven subcommands, each independent of the others: `csv-stats`, `json-query`, `wrap`, `date-diff`, `checksum`, `table` and `case` (sections 3 to 9), each in `src/commands/<name>.js` with its tests in `test/<name>.test.js`;
- then the command line that ties them together (section 10): argument parsing (`src/args.js`), the command list (`src/commands/index.js`), dispatch, help, `--version` and exit codes (`src/cli.js`, `bin/toolkit.js`), with tests, and this README's usage section.

Every command's tests cover each rule of its section, including the errors. `npm test` must pass at the end.

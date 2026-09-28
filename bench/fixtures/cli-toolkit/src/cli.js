'use strict';
const echo = require('./commands/echo');

/**
 * The command line, as it stands: only `echo`, with its arguments taken as they are and no options, help or
 * errors. SPEC.md section 10 is what it has to become.
 */
async function main(argv, io) {
  const [name, ...rest] = argv;
  if (name !== 'echo') {
    io.stderr(`toolkit: unknown command "${name ?? ''}"\n`);
    return 2;
  }
  io.stdout(echo.run({ positionals: rest, options: {}, input: '', readFile: io.readFile }));
  return 0;
}

module.exports = { main };

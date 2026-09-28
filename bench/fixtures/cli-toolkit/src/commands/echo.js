'use strict';
const { UsageError } = require('../errors');

/** The example command (SPEC.md section 1): prints its arguments, joined by single spaces. */
module.exports = {
  name: 'echo',
  summary: 'Print the arguments',
  usage: 'toolkit echo [--upper] [--repeat N] <words…>',
  input: false,
  options: {
    upper: { type: 'boolean', default: false, description: 'Print in upper case' },
    repeat: { type: 'number', default: 1, description: 'How many times to print the line' },
  },
  run({ positionals, options = {} }) {
    const upper = options.upper ?? false;
    const repeat = options.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1) throw new UsageError('invalid repeat');
    const line = positionals.join(' ');
    return `${upper ? line.toUpperCase() : line}\n`.repeat(repeat);
  },
};

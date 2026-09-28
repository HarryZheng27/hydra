'use strict';

/** Bad arguments or options: the command line was wrong. Exit code 2. */
class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.exitCode = 2; }
}

/** Input the command can't process, or a file it can't read. Exit code 1. */
class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; this.exitCode = 1; }
}

module.exports = { UsageError, InputError };

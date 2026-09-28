'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const echo = require('../src/commands/echo');
const { UsageError } = require('../src/errors');

test('echo follows the command contract', () => {
  assert.equal(echo.name, 'echo');
  assert.equal(typeof echo.summary, 'string');
  assert.match(echo.usage, /^toolkit echo /);
  assert.equal(echo.input, false);
  assert.deepEqual(Object.keys(echo.options), ['upper', 'repeat']);
});

test('echo prints its arguments, with its options or their defaults', () => {
  assert.equal(echo.run({ positionals: ['a', 'b'], options: {}, input: '' }), 'a b\n');
  assert.equal(echo.run({ positionals: ['hi'], options: { upper: true, repeat: 2 }, input: '' }), 'HI\nHI\n');
  assert.throws(() => echo.run({ positionals: [], options: { repeat: 0 }, input: '' }), UsageError);
});

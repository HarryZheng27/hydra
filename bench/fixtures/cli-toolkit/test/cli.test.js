'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../src/cli');

function io() {
  const out = { stdout: '', stderr: '' };
  return { out, io: { readStdin: () => '', readFile: () => Buffer.from(''), stdout: text => { out.stdout += text; }, stderr: text => { out.stderr += text; } } };
}

test('toolkit echo prints its arguments', async () => {
  const { out, io: streams } = io();
  assert.equal(await main(['echo', 'hello', 'world'], streams), 0);
  assert.equal(out.stdout, 'hello world\n');
});

test('an unknown command exits with 2', async () => {
  const { out, io: streams } = io();
  assert.equal(await main(['nope'], streams), 2);
  assert.match(out.stderr, /unknown command "nope"/);
});

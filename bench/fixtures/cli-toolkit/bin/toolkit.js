#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { main } = require('../src/cli');

const io = {
  readStdin: () => (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8')),
  readFile: file => fs.readFileSync(file),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
};

main(process.argv.slice(2), io).then(code => { process.exitCode = code; });

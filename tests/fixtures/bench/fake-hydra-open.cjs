// A stand-in for Hydra's bin/hydra.cmd in tests/benchmarkWindows.test.ts, for scripts/bench-open.ps1: `status --json`
// answers as window <pid> when <folder>/.git/fake-owner holds that pid (else exit 3, no window); anything else is
// "open this folder", which makes window 5151 own it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'status') {
  const owner = path.join(process.cwd(), '.git', 'fake-owner');
  if (!fs.existsSync(owner)) { process.stderr.write('No open Hydra window owns this folder.'); process.exitCode = 3; }
  else process.stdout.write(JSON.stringify({ repository: process.cwd(), window: { pid: Number(fs.readFileSync(owner, 'utf8')), port: 1 }, heads: {} }, null, 2));
} else {
  const folder = args[0];
  fs.writeFileSync(path.join(folder, '.git', 'fake-owner'), '5151');
  fs.appendFileSync(path.join(folder, '.git', 'fake-opened'), 'opened\n');
}

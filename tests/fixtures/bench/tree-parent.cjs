// A stand-in for a command that leaves something running, for tests/benchmarkRun.test.ts. It starts a grandchild that
// runs until killed, sharing this process's output, and writes the grandchild's pid to the file named by its first
// argument. With "hang" it then waits forever too (an agent past its timeout); with "exit" it exits at once (a test run
// that left a server open).
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidFile, mode] = process.argv.slice(2);
// Detached with "exit", so it outlives this process (on Windows, Node's children otherwise die with their parent).
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true, detached: mode === 'exit' });
fs.writeFileSync(pidFile, String(grandchild.pid));
process.stdout.write('started\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else { grandchild.unref(); process.exit(0); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { coalescedScanner, type ProcessTable } from '../src/core/leadVerification';

/**
 * The Windows lead/user checks walk a connecting process's ancestors through a full
 * machine-wide process-table scan (`Get-CimInstance Win32_Process`); a burst of new
 * connections used to each pay for their own. `coalescedScanner` shares one in-flight
 * scan across concurrent callers instead — but deliberately keeps nothing once a scan
 * settles, because HSEC-07/HSEC-63's reused-PID guard needs every answer to reflect who
 * is actually running right now (see the comment in src/core/leadVerification.ts).
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test('concurrent callers share one in-flight scan', async () => {
  let calls = 0;
  const gate = deferred<ProcessTable>();
  const scanner = coalescedScanner(() => { calls++; return gate.promise; });
  const [a, b, c] = [scanner(), scanner(), scanner()];
  assert.equal(calls, 1, 'only one real scan was started for three concurrent callers');
  const table: ProcessTable = new Map([[1, { ppid: 0, created: 1 }]]);
  gate.resolve(table);
  assert.deepEqual(await Promise.all([a, b, c]), [table, table, table], 'every caller gets the same result');
});

test('a scan after one settles is a fresh one, never a cached one (no TTL to keep it around)', async () => {
  let calls = 0;
  const tables: ProcessTable[] = [new Map([[1, { ppid: 0, created: 1 }]]), new Map([[2, { ppid: 0, created: 2 }]])];
  const scanner = coalescedScanner(async () => tables[calls++]!);
  const first = await scanner();
  const second = await scanner();
  assert.equal(calls, 2, 'the second call started its own scan instead of reusing the first result');
  assert.equal(first, tables[0]); assert.equal(second, tables[1]);
});

test('a caller that arrives after a scan is in flight but before it settles still joins it, not a new one', async () => {
  let calls = 0;
  const gate = deferred<ProcessTable>();
  const scanner = coalescedScanner(() => { calls++; return gate.promise; });
  const first = scanner();
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = scanner(); // arrives while the first scan is still running
  assert.equal(calls, 1);
  gate.resolve(new Map());
  await Promise.all([first, second]);
});

test('a failed scan is not cached either, and the next call retries', async () => {
  let calls = 0;
  const scanner = coalescedScanner(async () => { calls++; if (calls === 1) throw new Error('scan failed'); return new Map(); });
  await assert.rejects(scanner(), /scan failed/);
  await scanner();
  assert.equal(calls, 2);
});

test('the scan is timed and logged once per real scan, not once per waiting caller', async () => {
  const lines: string[] = [];
  let now = 1000;
  const scanner = coalescedScanner(async () => { now += 42; return new Map([[1, { ppid: 0, created: 1 }], [2, { ppid: 1, created: 2 }]]); }, () => now);
  await Promise.all([scanner(line => lines.push(line)), scanner(line => lines.push(line))]);
  assert.deepEqual(lines, ['[lead] process scan: 2 processes in 42ms']);
  // A later, separate scan logs again.
  await scanner(line => lines.push(line));
  assert.equal(lines.length, 2);
});

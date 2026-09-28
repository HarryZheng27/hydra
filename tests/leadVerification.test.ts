import test from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { windowsConnectionChain } from '../src/core/leadVerification';

/**
 * `windowsConnectionChain` logs how long its check took (the process-table scan inside it is real
 * work). A port pair that matches no live connection still runs the whole script and resolves
 * quickly with an empty chain, so this is cheap and needs no real lead/user connection.
 */
test('windowsConnectionChain logs how long its check took', async () => {
  const lines: string[] = [];
  let now = 1000;
  const socket = { remotePort: 65000, localPort: 65001 } as unknown as Socket;
  const chain = await windowsConnectionChain(socket, line => lines.push(line), () => (now += 7));
  assert.deepEqual(chain, []);
  assert.equal(lines.length, 1, `expected exactly one timing line, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0]!, /^\[lead\] process check: 0 link\(s\) in \d+ms$/);
});

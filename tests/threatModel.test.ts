import test from 'node:test';
import assert from 'node:assert/strict';
import { HelperEndpoint, callHelperEndpoint, requestLeadSession } from '../src/core/helperEndpoint';

/**
 * docs/THREAT_MODEL.md, HSEC-45 and HR-14. `docs/Heads.md`'s "Logging" line says every action,
 * and every accepted or refused lead connection, is logged to the Hydra output channel. That
 * logging lives entirely in `src/extension.ts`'s wiring around `HelperEndpoint` (plain
 * `this.output.appendLine(...)` calls, which needs a real VS Code extension host), so it was
 * untested by the unit suite. This test replicates the exact wrapping `extension.ts` uses --
 * a handler closure that logs before calling through, and a `verifyLead` wrapper that logs both
 * outcomes -- around a real `HelperEndpoint`, with a plain array standing in for the output
 * channel. It also confirms the resulting gap named in HR-14: a denied action (wrong role, or an
 * unknown token) is never logged, because `HelperEndpoint.serve` (src/core/helperEndpoint.ts)
 * returns its 401/403 before ever calling the wrapped handler.
 */
test('an accepted action and both outcomes of a lead connection are logged, in the same shape extension.ts wires them', async () => {
  const log: string[] = [];
  let allowLead = false;

  // The same two wrappers src/extension.ts builds around HelperEndpoint (see the construction
  // around line 400 there): a handler that logs the caller's role, job id and tool before running
  // it, and a verifyLead wrapper that logs whether the lead connection was accepted or refused.
  const endpoint = new HelperEndpoint(
    async (caller, tool) => {
      log.push(`[heads] ${caller.role}${caller.jobId ? ` ${caller.jobId}` : ''}: ${tool}`);
      return { handled: tool };
    },
    {
      leadKey: 'window',
      verifyLead: async () => {
        const verdict = allowLead ? { ok: true as const } : { ok: false as const, reason: 'it runs inside a Hydra head.' };
        log.push(`[heads] lead connection ${verdict.ok ? 'accepted' : `refused: ${verdict.reason}`}`);
        return verdict;
      },
    },
  );
  const port = await endpoint.start();
  try {
    // A refused lead connection is logged.
    const refused = await requestLeadSession(port);
    assert.equal(refused.ok, false);
    assert.deepEqual(log, ["[heads] lead connection refused: it runs inside a Hydra head."]);

    // An accepted lead connection is logged too, and separately from the refusal above.
    allowLead = true;
    const granted = await requestLeadSession(port);
    assert.equal(granted.ok, true);
    assert.deepEqual(log.slice(-1), ['[heads] lead connection accepted']);
    const leadToken = (granted.result as { token: string }).token;

    // An authorized action is logged with the caller's role and the tool it called.
    const called = await callHelperEndpoint(port, leadToken, 'hydra_list_heads', {});
    assert.deepEqual(called, { ok: true, result: { handled: 'hydra_list_heads' } });
    assert.deepEqual(log.slice(-1), ['[heads] lead: hydra_list_heads']);

    // HR-14: a denied action is not logged anywhere -- only returned to the caller. A head
    // token calling a lead-only tool never reaches the wrapped handler that does the logging.
    const helperToken = endpoint.issue({ role: 'helper', leadKey: 'window', jobId: 'aaaaaaaaaaaa' });
    const before = log.length;
    const denied = await callHelperEndpoint(port, helperToken, 'hydra_start_head', {});
    assert.equal(denied.ok, false);
    assert.match(denied.error || '', /not available to a Hydra head/);
    assert.equal(log.length, before, 'a denied action left the log untouched');

    // The same is true of an unrecognized token.
    const unknown = await callHelperEndpoint(port, 'x'.repeat(43), 'hydra_list_heads', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error || '', /Unknown Hydra token/);
    assert.equal(log.length, before, 'an unknown token also left the log untouched');
  } finally {
    await endpoint.close();
  }
});

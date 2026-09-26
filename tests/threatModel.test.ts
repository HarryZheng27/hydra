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
test('every action, both outcomes of a lead connection, and every refusal are logged, in the shape extension.ts wires them; never a token', async () => {
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
      // The refusal hook extension.ts wires to the same output channel (HSEC-47).
      onRefuse: event => log.push(`[heads] refused ${event.status}: ${event.reason}${event.role ? ` (${event.role}${event.jobId ? ` ${event.jobId}` : ''}${event.tool ? `, ${event.tool}` : ''})` : ''}`),
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

    // HSEC-47 (was HR-14): a denied action never reaches the wrapped handler, so the endpoint's own
    // refusal hook logs it: who, what and why, never the token.
    const helperToken = endpoint.issue({ role: 'helper', leadKey: 'window', jobId: 'aaaaaaaaaaaa' });
    const before = log.length;
    const denied = await callHelperEndpoint(port, helperToken, 'hydra_start_head', {});
    assert.equal(denied.ok, false);
    assert.match(denied.error || '', /not available to a Hydra head/);
    assert.deepEqual(log.slice(before), ['[heads] refused 403: a tool its role may not use (helper aaaaaaaaaaaa, hydra_start_head)']);

    // The same is true of an unrecognized token.
    const unknown = await callHelperEndpoint(port, 'x'.repeat(43), 'hydra_list_heads', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error || '', /Unknown Hydra token/);
    assert.deepEqual(log.slice(-1), ['[heads] refused 401: an unknown token']);
    assert.ok(!log.join('\n').includes('x'.repeat(43)), 'a token never reaches the log');
    assert.ok(!log.join('\n').includes(helperToken), 'nor does a real one');
  } finally {
    await endpoint.close();
  }
});

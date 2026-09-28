import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeRunCost, codexRunUsage } from '../src/core/helperRunner';

/** O9: what a head's run cost, read from the lines its CLI already prints (docs/Heads.md, "The report"). */

test('claudeRunCost (O9): the session cost a result line reports, kept as the largest seen for the run', () => {
  assert.equal(claudeRunCost({ type: 'result', total_cost_usd: 0.12 }, undefined), 0.12);
  assert.equal(claudeRunCost({ type: 'result', total_cost_usd: 0.3 }, 0.12), 0.3, 'a later turn reports the session so far');
  assert.equal(claudeRunCost({ type: 'result', total_cost_usd: 0.1 }, 0.3), 0.3);
  assert.equal(claudeRunCost({ type: 'result' }, 0.3), 0.3, 'a line without a cost changes nothing');
  assert.equal(claudeRunCost({ type: 'result', total_cost_usd: -1 }, undefined), undefined);
  assert.equal(claudeRunCost({ type: 'result', total_cost_usd: 'lots' }, undefined), undefined);
});

test('codexRunUsage (O9): token counts summed over a run\'s completed turns; other lines change nothing', () => {
  const first = codexRunUsage({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }, undefined);
  assert.deepEqual(first, { inputTokens: 1000, outputTokens: 50 });
  assert.deepEqual(codexRunUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }, first), { inputTokens: 1010, outputTokens: 55 });
  assert.equal(codexRunUsage({ type: 'item.completed', usage: { input_tokens: 9 } }, first), first);
  assert.equal(codexRunUsage({ type: 'turn.completed' }, first), first);
});

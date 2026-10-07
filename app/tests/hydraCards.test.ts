import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { headCard, planCard } from '../src/main/hydra';
import { hydraCard } from '../src/renderer/HydraCards';
import type { HelperJobView } from '../../src/core/model';
import type { Plan } from '../../src/core/plans';

const head: HelperJobView = {
  id: 'a1b2c3d4e5f6', title: 'Add the parser', state: 'done', provider: 'claude', createdAt: '2026-10-03T00:00:00Z', changedFiles: 3,
  summary: 'Parser added with tests.', branch: 'hydra/a1b2', worktree: 'C:\\secret\\worktree', repository: 'C:\\repo', dependsOn: [],
  checks: [{ id: 'tests', passed: true, kind: 'command', state: 'passed', required: true, evidence: ['C:\\secret\\log.txt'] } as never],
  lead: { sessionId: 'session-1', provider: 'claude' },
};

test('a head or plan card carries what a chat shows, never a path or a log', () => {
  const card = headCard(head);
  assert.equal(card.leadSessionId, 'session-1');
  assert.deepEqual(card.checks, [{ id: 'tests', passed: true, state: 'passed', required: true }]);
  assert.ok(!JSON.stringify(card).includes('secret'), 'no worktree, repository or evidence path reaches the page');
  const plan = { version: 1, id: 'feedfacecafe', title: 'Ship it', createdAt: '', updatedAt: '', state: 'running', jobs: [{ key: 'a', title: 'A', brief: 'secret brief', dependsOn: [] }, { key: 'b', title: 'B', brief: '', dependsOn: ['a'] }], leadOrigin: { leadSessionId: 'session-1', idempotencyKey: 'k' } } as Plan;
  const view = planCard(plan, [{ key: 'a', runAs: 'head', status: 'done' } as never]);
  assert.deepEqual(view.jobs.map(job => [job.key, job.status]), [['a', 'done'], ['b', 'waiting']]);
  assert.ok(!JSON.stringify(view).includes('secret brief'));
});

test('a Hydra tool call in a chat shows as its live head or plan card (Claude\'s and Codex\'s tool names); anything else stays a tool block', () => {
  const view = { heads: [headCard(head)], plans: [planCard({ version: 1, id: 'feedfacecafe', title: 'Ship it', createdAt: '', updatedAt: '', state: 'done', jobs: [] } as Plan)] };
  const call = (name: string, output: string) => ({ kind: 'tool' as const, key: 't1', id: 'x', name, input: {}, output });
  const claude = hydraCard(call('mcp__hydra__hydra_start_head', '{"job_id":"a1b2c3d4e5f6","state":"queued"}'), view);
  assert.match(renderToStaticMarkup(claude!), /Add the parser.*done.*checks 1\/1/s);
  const codex = hydraCard(call('hydra/hydra_plan_create', JSON.stringify({ content: [{ type: 'text', text: '{"plan_id":"feedfacecafe"}' }] })), view);
  assert.match(renderToStaticMarkup(codex!), /Ship it/);
  assert.equal(hydraCard(call('mcp__hydra__hydra_start_head', '{"job_id":"000000000000"}'), view), undefined, 'an unknown head is a plain tool block');
  assert.equal(hydraCard(call('Bash', '{"job_id":"a1b2c3d4e5f6"}'), view), undefined);
  // Text in a reply that names a head isn't a card: only the tool call's result is read.
  assert.equal(hydraCard(call('mcp__other__start_head', '{"job_id":"a1b2c3d4e5f6"}'), view), undefined);
});

test('a done head\'s card shows its headline under the title, and nothing for a head without one', () => {
  const withHeadline = headCard({ ...head, headline: 'Parser added; nothing left to decide.' });
  assert.equal(withHeadline.headline, 'Parser added; nothing left to decide.');
  const markup = renderToStaticMarkup(hydraCard({ kind: 'tool' as const, key: 't', id: 'x', name: 'mcp__hydra__hydra_start_head', input: {}, output: '{"job_id":"a1b2c3d4e5f6"}' }, { heads: [withHeadline], plans: [] })!);
  assert.match(markup, /Add the parser.*hydra-card-headline">Parser added; nothing left to decide\./s);
  assert.equal(headCard(head).headline, undefined);
});

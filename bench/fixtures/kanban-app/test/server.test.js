'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createMemoryStore } = require('../src/store');

test('the board routes: create, list, get, rename and delete', async () => {
  const app = await startServer();
  try {
    assert.deepEqual((await app.request('GET', '/health')).body, { ok: true });
    const created = await app.request('POST', '/boards', { name: 'Roadmap' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { id: 'b1', name: 'Roadmap' });
    assert.deepEqual((await app.request('GET', '/boards')).body, [{ id: 'b1', name: 'Roadmap' }]);
    assert.deepEqual((await app.request('PATCH', '/boards/b1', { name: 'Plans' })).body, { id: 'b1', name: 'Plans' });
    assert.equal((await app.request('DELETE', '/boards/b1')).status, 204);
    assert.deepEqual((await app.request('GET', '/boards')).body, []);
  } finally { await app.close(); }
});

test('errors: 400 for bad input or JSON, 404 for unknown things and routes, 405 for a wrong method', async () => {
  const app = await startServer();
  try {
    assert.deepEqual(await app.request('POST', '/boards', { name: '' }).then(r => [r.status, r.body.error.code]), [400, 'invalid']);
    assert.deepEqual(await app.request('POST', '/boards', '{nope').then(r => [r.status, r.body.error.message]), [400, 'invalid JSON body']);
    assert.deepEqual(await app.request('GET', '/boards/b9').then(r => [r.status, r.body]), [404, { error: { code: 'not_found', message: 'board b9 not found' } }]);
    assert.deepEqual(await app.request('GET', '/nowhere').then(r => [r.status, r.body.error.message]), [404, 'no route']);
    const wrong = await app.request('PUT', '/boards');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET, POST');
  } finally { await app.close(); }
});

test('the in-memory store runs updates one at a time and puts the state back when one throws', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.update(state => { state.boards.push({ id: 'x', name: 'x' }); throw new Error('no'); }), /no/);
  assert.deepEqual(store.read(state => state.boards), []);
  const order = [];
  await Promise.all([store.update(() => order.push(1)), store.update(() => order.push(2))]);
  assert.deepEqual(order, [1, 2]);
});

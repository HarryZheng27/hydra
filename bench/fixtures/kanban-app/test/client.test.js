'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createClient, ApiError } = require('../client/api');

test('the client drives the board routes and turns error bodies into ApiErrors', async () => {
  const app = await startServer();
  try {
    const client = createClient(app.url + '/');
    assert.deepEqual(await client.health(), { ok: true });
    const board = await client.createBoard('Roadmap');
    assert.deepEqual(await client.listBoards(), [board]);
    assert.deepEqual(await client.renameBoard(board.id, 'Plans'), { id: board.id, name: 'Plans' });
    assert.equal(await client.deleteBoard(board.id), undefined);
    await assert.rejects(client.getBoard(board.id), error => error instanceof ApiError && error.status === 404 && error.code === 'not_found');
  } finally { await app.close(); }
});

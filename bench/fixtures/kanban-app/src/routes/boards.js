'use strict';
const boards = require('../boards');

/**
 * The board routes (SPEC.md section 6), and the example of a route module: `register(router, context)` adds its
 * routes; `context` is `{ store, today }`, where `today()` returns the current date as YYYY-MM-DD.
 */
function register(router, { store }) {
  router.route('GET', '/boards', () => store.read(state => boards.listBoards(state)));
  router.route('POST', '/boards', async ({ body }) => ({ status: 201, body: await store.update(state => boards.createBoard(state, body ?? {})) }));
  router.route('GET', '/boards/:id', ({ params }) => store.read(state => boards.getBoard(state, params.id)));
  router.route('PATCH', '/boards/:id', ({ params, body }) => store.update(state => boards.renameBoard(state, params.id, body?.name)));
  router.route('DELETE', '/boards/:id', async ({ params }) => { await store.update(state => boards.deleteBoard(state, params.id)); return { status: 204 }; });
}

module.exports = { register };

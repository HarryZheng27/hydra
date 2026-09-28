'use strict';
const http = require('node:http');
const { createRouter } = require('./http');
const { createMemoryStore } = require('./store');

const utcToday = () => new Date().toISOString().slice(0, 10);

/**
 * The HTTP server (SPEC.md section 6). Options:
 * - `store`: where the state lives (default: a new in-memory store);
 * - `routes`: route modules' `register` functions (default: the board routes only, for now);
 * - `today`: returns today's date as YYYY-MM-DD (default: the UTC date).
 * GET /health is always there.
 */
function createServer({ store = createMemoryStore(), routes = [require('./routes/boards').register], today = utcToday } = {}) {
  const router = createRouter();
  router.route('GET', '/health', () => ({ ok: true }));
  for (const register of routes) register(router, { store, today });
  const server = http.createServer((req, res) => { router.handle(req, res); });
  server.store = store;
  return server;
}

/** Starts a server on a free port; resolves with it and its base URL. */
function listen(server, port = 0) {
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { createServer, listen };

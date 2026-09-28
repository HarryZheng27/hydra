'use strict';
const { createServer, listen } = require('../src/server');

/**
 * Starts a server for a test on a free port (SPEC.md section 8). `options` go to createServer (`routes`, `store`,
 * `today`). `request(method, path, body)` resolves with `{ status, headers, body }`, the body parsed when it's JSON.
 * Call `close()` when done.
 */
async function startServer(options) {
  const { server, url } = await listen(createServer(options));
  async function request(method, path, body) {
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const json = (response.headers.get('content-type') ?? '').includes('application/json');
    return { status: response.status, headers: response.headers, body: json && text ? JSON.parse(text) : text };
  }
  return { url, server, request, close: () => new Promise(resolve => server.close(resolve)) };
}

module.exports = { startServer };

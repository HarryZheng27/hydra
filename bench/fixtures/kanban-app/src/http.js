'use strict';
const { KanbanError, statusFor } = require('./errors');

const maxBody = 1024 * 1024;

/**
 * A small router (SPEC.md section 6). `route(method, pattern, handler)` adds a route; `:name` in the pattern
 * matches one path segment and lands in `request.params`. A handler gets
 * `{ params, query, body, method, path }` (query: URLSearchParams; body: the parsed JSON body, or undefined)
 * and returns, or resolves to:
 * - `{ status, body }`: JSON (status 204 sends no body);
 * - `{ status, text, type }`: text with that content type;
 * - anything else: status 200 with it as JSON.
 * A thrown KanbanError becomes its status with `{ error: { code, message } }`; any other error is a 500.
 */
function createRouter() {
  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp(`^${pattern.split('/').map(part => part.startsWith(':') ? (names.push(part.slice(1)), '([^/]+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`);
    routes.push({ method, pattern, regex, names, handler });
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const matching = routes.map(item => ({ item, match: item.regex.exec(url.pathname) })).filter(({ match }) => match);
    if (!matching.length) return send(res, 404, { error: { code: 'not_found', message: 'no route' } });
    const found = matching.find(({ item }) => item.method === req.method);
    if (!found) {
      res.setHeader('Allow', [...new Set(matching.map(({ item }) => item.method))].join(', '));
      return send(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} is not allowed here` } });
    }
    const params = Object.fromEntries(found.item.names.map((name, index) => [name, decodeURIComponent(found.match[index + 1])]));
    try {
      const body = await readBody(req);
      const result = await found.item.handler({ params, query: url.searchParams, body, method: req.method, path: url.pathname });
      if (result && typeof result === 'object' && 'text' in result && typeof result.status === 'number') {
        res.writeHead(result.status, { 'Content-Type': result.type ?? 'text/plain; charset=utf-8' });
        return res.end(result.text);
      }
      if (result && typeof result === 'object' && typeof result.status === 'number' && ('body' in result || result.status === 204)) return send(res, result.status, result.body);
      return send(res, 200, result);
    } catch (error) {
      if (error instanceof KanbanError) return send(res, statusFor(error.code), { error: { code: error.code, message: error.message } });
      return send(res, 500, { error: { code: 'internal', message: 'internal error' } });
    }
  }

  return { route, handle, routes };
}

function send(res, status, body) {
  if (status === 204 || body === undefined) { res.writeHead(status); return res.end(); }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** The request's JSON body: undefined when empty; a 400 for invalid JSON or more than 1 MB. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size <= maxBody) chunks.push(chunk); });
    req.on('error', reject);
    req.on('end', () => {
      if (size > maxBody) return reject(new KanbanError('invalid', 'body too large'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(undefined);
      try { resolve(JSON.parse(text)); } catch { reject(new KanbanError('invalid', 'invalid JSON body')); }
    });
  });
}

module.exports = { createRouter };

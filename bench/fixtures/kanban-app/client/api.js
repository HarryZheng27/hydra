'use strict';

/** An error from the API: its HTTP status, and the `code` and `message` of its `{ error }` body. */
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

/**
 * The browser-and-Node client for the board API (SPEC.md section 7). `createClient(baseUrl, { fetch })` uses the
 * global fetch unless one is given. Every method resolves with the response's JSON (undefined for 204), or rejects
 * with an ApiError.
 */
function createClient(baseUrl, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  async function request(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined;
    const type = response.headers.get('content-type') ?? '';
    const payload = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const error = payload && typeof payload === 'object' && payload.error ? payload.error : { code: 'http_error', message: `HTTP ${response.status}` };
      throw new ApiError(response.status, error.code, error.message);
    }
    return payload;
  }
  const id = value => encodeURIComponent(value);
  return {
    request,
    health: () => request('GET', '/health'),
    listBoards: () => request('GET', '/boards'),
    createBoard: name => request('POST', '/boards', { name }),
    getBoard: boardId => request('GET', `/boards/${id(boardId)}`),
    renameBoard: (boardId, name) => request('PATCH', `/boards/${id(boardId)}`, { name }),
    deleteBoard: boardId => request('DELETE', `/boards/${id(boardId)}`),
  };
}

module.exports = { createClient, ApiError };

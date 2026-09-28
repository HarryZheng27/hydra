'use strict';

/**
 * Every error the board's modules throw on purpose (SPEC.md section 3). `code` decides the HTTP status:
 * invalid 400, not_found 404, conflict 409.
 */
class KanbanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KanbanError';
    this.code = code;
  }
}

const invalid = message => new KanbanError('invalid', message);
const notFound = message => new KanbanError('not_found', message);
const conflict = message => new KanbanError('conflict', message);
const statusFor = code => ({ invalid: 400, not_found: 404, conflict: 409, method_not_allowed: 405 })[code] ?? 500;

module.exports = { KanbanError, invalid, notFound, conflict, statusFor };

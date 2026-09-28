'use strict';
const { createState } = require('./state');

/**
 * The in-memory store (SPEC.md section 5): the one way routes reach the state. `read(fn)` returns fn(state);
 * `update(fn)` runs fn(state) and resolves with its result, one update at a time. When fn throws, the state is
 * put back as it was and the promise rejects with that error.
 */
function createMemoryStore(initial = createState()) {
  let state = initial;
  let queue = Promise.resolve();
  return {
    read: fn => fn(state),
    update(fn) {
      const next = queue.then(() => {
        const before = structuredClone(state);
        try { return fn(state); } catch (error) { state = before; throw error; }
      });
      queue = next.catch(() => {});
      return next;
    },
    snapshot: () => structuredClone(state),
  };
}

module.exports = { createMemoryStore };

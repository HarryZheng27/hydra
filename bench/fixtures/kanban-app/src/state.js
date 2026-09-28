'use strict';
const { invalid, notFound } = require('./errors');

/** An empty board state (SPEC.md section 2). */
function createState() {
  return { version: 1, seq: 0, boards: [], columns: [], cards: [], labels: [] };
}

/** The next id: the prefix and the next number of the one counter every kind shares ("b1", "c2", "k3", "l4"). */
function nextId(state, prefix) {
  state.seq += 1;
  return `${prefix}${state.seq}`;
}

const finder = (collection, kind) => (state, id) => {
  const found = state[collection].find(item => item.id === id);
  if (!found) throw notFound(`${kind} ${id} not found`);
  return found;
};
const findBoard = finder('boards', 'board');
const findColumn = finder('columns', 'column');
const findCard = finder('cards', 'card');
const findLabel = finder('labels', 'label');

/** A trimmed name of 1 to `max` characters, or an "invalid" error naming the field. */
function cleanName(value, field, max) {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw invalid(`${field} must be 1-${max} characters`);
  return trimmed;
}

/** Refuses fields an input object may not have. */
function onlyFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('expected an object');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw invalid(`unknown field: ${key}`);
}

module.exports = { createState, nextId, findBoard, findColumn, findCard, findLabel, cleanName, onlyFields };

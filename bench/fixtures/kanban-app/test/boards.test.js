'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, nextId, findBoard } = require('../src/state');
const { createBoard, renameBoard, deleteBoard, listBoards } = require('../src/boards');
const { KanbanError } = require('../src/errors');

test('ids come from one counter shared by every kind', () => {
  const state = createState();
  assert.equal(nextId(state, 'b'), 'b1');
  assert.equal(nextId(state, 'c'), 'c2');
  assert.equal(state.seq, 2);
});

test('boards are created with a trimmed name, renamed and listed', () => {
  const state = createState();
  const board = createBoard(state, { name: '  Roadmap ' });
  assert.deepEqual(board, { id: 'b1', name: 'Roadmap' });
  renameBoard(state, 'b1', 'Plans');
  assert.deepEqual(listBoards(state), [{ id: 'b1', name: 'Plans' }]);
});

test('bad names, unknown fields and unknown boards are refused with the right code', () => {
  const state = createState();
  assert.throws(() => createBoard(state, { name: '   ' }), error => error instanceof KanbanError && error.code === 'invalid');
  assert.throws(() => createBoard(state, { name: 'x'.repeat(101) }), /1-100 characters/);
  assert.throws(() => createBoard(state, { name: 'a', color: 'red' }), /unknown field: color/);
  assert.throws(() => findBoard(state, 'b9'), error => error.code === 'not_found' && error.message === 'board b9 not found');
});

test('deleting a board removes its columns, their cards and its labels, and nothing else', () => {
  const state = createState();
  createBoard(state, { name: 'A' }); createBoard(state, { name: 'B' });
  state.columns.push({ id: 'c3', boardId: 'b1', name: 'Todo', position: 0, wipLimit: null }, { id: 'c4', boardId: 'b2', name: 'Todo', position: 0, wipLimit: null });
  state.cards.push({ id: 'k5', columnId: 'c3', title: 'x', description: '', position: 0, labels: [], due: null, archived: false }, { id: 'k6', columnId: 'c4', title: 'y', description: '', position: 0, labels: [], due: null, archived: false });
  state.labels.push({ id: 'l7', boardId: 'b1', name: 'bug', color: '#ff0000' });
  deleteBoard(state, 'b1');
  assert.deepEqual(state.boards.map(board => board.id), ['b2']);
  assert.deepEqual(state.columns.map(column => column.id), ['c4']);
  assert.deepEqual(state.cards.map(card => card.id), ['k6']);
  assert.deepEqual(state.labels, []);
});

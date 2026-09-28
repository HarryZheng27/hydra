'use strict';
const { nextId, findBoard, cleanName, onlyFields } = require('./state');

/** Boards (SPEC.md section 4). */
function createBoard(state, input) {
  onlyFields(input, ['name']);
  const board = { id: nextId(state, 'b'), name: cleanName(input.name, 'name', 100) };
  state.boards.push(board);
  return board;
}

function renameBoard(state, boardId, name) {
  const board = findBoard(state, boardId);
  board.name = cleanName(name, 'name', 100);
  return board;
}

/** Removes a board with everything on it: its columns, their cards, and its labels. */
function deleteBoard(state, boardId) {
  const board = findBoard(state, boardId);
  const columnIds = new Set(state.columns.filter(column => column.boardId === boardId).map(column => column.id));
  state.cards = state.cards.filter(card => !columnIds.has(card.columnId));
  state.columns = state.columns.filter(column => column.boardId !== boardId);
  state.labels = state.labels.filter(label => label.boardId !== boardId);
  state.boards = state.boards.filter(item => item.id !== boardId);
  return board;
}

const listBoards = state => [...state.boards];
const getBoard = (state, boardId) => findBoard(state, boardId);

module.exports = { createBoard, renameBoard, deleteBoard, listBoards, getBoard };

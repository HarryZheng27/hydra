#!/usr/bin/env node
// The hidden acceptance check for the kanban-app fixture (docs/Benchmark.md). The benchmark harness runs it after
// each setup, on the result: `node check.mjs <repo>`. It is never copied into the repositories the agents work in.
// It checks what SPEC.md specifies, the same for both setups, and ends with a JSON summary line.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(repo, 'package.json'));
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`not ok - ${name}: ${String(error?.message ?? error).split('\n').slice(0, 3).join(' ').slice(0, 400)}`); }
}
const mod = name => require(`./src/${name}.js`);
/** Asserts `fn` throws a KanbanError with this code (and this exact message, when given). */
function fails(fn, code, message) {
  let thrown;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected a ${code} error`);
  assert.equal(thrown.code, code, `expected code ${code}, got ${thrown.code}: ${thrown.message}`);
  if (message !== undefined) assert.equal(thrown.message, message);
}
/** A state with one board "Main" (b1) and, when asked, columns Todo (c2), Doing (c3), Done (c4). */
function setup({ columns = false } = {}) {
  const state = mod('state').createState();
  mod('boards').createBoard(state, { name: 'Main' });
  if (columns) for (const name of ['Todo', 'Doing', 'Done']) mod('columns').addColumn(state, 'b1', { name });
  return state;
}
const positions = (state, columnId) => state.cards.filter(card => card.columnId === columnId && !card.archived).sort((a, b) => a.position - b.position).map(card => `${card.id}@${card.position}`);
const ids = list => list.map(item => item.id);
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'kanban-check-'));

// ---- columns (SPEC.md section 9) ----
await check('columns: added in order or at a position, moved and removed, positions always 0..n-1', () => {
  const { addColumn, updateColumn, removeColumn, listColumns } = mod('columns');
  const state = setup();
  assert.deepEqual(addColumn(state, 'b1', { name: ' Todo ' }), { id: 'c2', boardId: 'b1', name: 'Todo', position: 0, wipLimit: null });
  addColumn(state, 'b1', { name: 'Done', wipLimit: 3 });
  addColumn(state, 'b1', { name: 'Doing', position: 1 });
  assert.deepEqual(listColumns(state, 'b1').map(column => `${column.name}@${column.position}`), ['Todo@0', 'Doing@1', 'Done@2']);
  updateColumn(state, 'c3', { position: 0 });
  assert.deepEqual(listColumns(state, 'b1').map(column => column.name), ['Done', 'Todo', 'Doing']);
  removeColumn(state, 'c2');
  assert.deepEqual(listColumns(state, 'b1').map(column => `${column.name}@${column.position}`), ['Done@0', 'Doing@1']);
});
await check('columns: names unique ignoring case, WIP limits, unknown fields and boards', () => {
  const { addColumn, updateColumn } = mod('columns');
  const state = setup({ columns: true });
  fails(() => addColumn(state, 'b1', { name: 'todo' }), 'conflict', 'column name already used');
  assert.equal(updateColumn(state, 'c2', { name: 'TODO' }).name, 'TODO');
  fails(() => updateColumn(state, 'c3', { name: 'todo' }), 'conflict', 'column name already used');
  fails(() => addColumn(state, 'b1', { name: 'X', wipLimit: 0 }), 'invalid');
  fails(() => addColumn(state, 'b1', { name: 'X', position: 9 }), 'invalid');
  fails(() => addColumn(state, 'b1', { name: 'X', color: 'red' }), 'invalid', 'unknown field: color');
  fails(() => addColumn(state, 'b9', { name: 'X' }), 'not_found', 'board b9 not found');
  state.cards.push({ id: 'k9', columnId: 'c2', title: 'a', description: '', position: 0, labels: [], due: null, archived: false }, { id: 'k10', columnId: 'c2', title: 'b', description: '', position: 1, labels: [], due: null, archived: false });
  fails(() => updateColumn(state, 'c2', { wipLimit: 1 }), 'conflict', 'WIP limit below current cards');
  assert.equal(updateColumn(state, 'c2', { wipLimit: 2 }).wipLimit, 2);
  assert.equal(updateColumn(state, 'c2', { wipLimit: null }).wipLimit, null);
});
await check('columns: a column with cards is removed only with force, which removes its cards', () => {
  const { removeColumn } = mod('columns');
  const state = setup({ columns: true });
  state.cards.push({ id: 'k9', columnId: 'c3', title: 'a', description: '', position: null, labels: [], due: null, archived: true });
  fails(() => removeColumn(state, 'c3'), 'conflict', 'column has cards');
  removeColumn(state, 'c3', { force: true });
  assert.deepEqual(state.cards, []);
  assert.deepEqual(state.columns.map(column => `${column.id}@${column.position}`).sort(), ['c2@0', 'c4@1']);
});

// ---- cards (section 10) ----
await check('cards: added at the end or a position, with defaults, description kept exactly', () => {
  const { addCard, updateCard } = mod('cards');
  const state = setup({ columns: true });
  assert.deepEqual(addCard(state, 'c2', { title: ' First ', description: '  spaced  ' }), { id: 'k5', columnId: 'c2', title: 'First', description: '  spaced  ', position: 0, labels: [], due: null, archived: false });
  addCard(state, 'c2', { title: 'Second' });
  addCard(state, 'c2', { title: 'Zeroth', position: 0 });
  assert.deepEqual(positions(state, 'c2'), ['k7@0', 'k5@1', 'k6@2']);
  assert.equal(updateCard(state, 'k5', { title: 'One' }).title, 'One');
  fails(() => addCard(state, 'c2', { title: '' }), 'invalid');
  fails(() => addCard(state, 'c2', { title: 'x', description: 'x'.repeat(2001) }), 'invalid');
  fails(() => updateCard(state, 'k5', { columnId: 'c3' }), 'invalid', 'unknown field: columnId');
  fails(() => addCard(state, 'c9', { title: 'x' }), 'not_found', 'column c9 not found');
});
await check('cards: moves within and between columns keep both columns without gaps', () => {
  const { addCard, moveCard, listCards } = mod('cards');
  const state = setup({ columns: true });
  for (const title of ['a', 'b', 'c']) addCard(state, 'c2', { title });
  addCard(state, 'c3', { title: 'd' });
  moveCard(state, 'k5', { position: 2 });
  assert.deepEqual(positions(state, 'c2'), ['k6@0', 'k7@1', 'k5@2']);
  moveCard(state, 'k7', { columnId: 'c3', position: 0 });
  assert.deepEqual(positions(state, 'c2'), ['k6@0', 'k5@1']);
  assert.deepEqual(positions(state, 'c3'), ['k7@0', 'k8@1']);
  moveCard(state, 'k6', { columnId: 'c3' });
  assert.deepEqual(positions(state, 'c3'), ['k7@0', 'k8@1', 'k6@2']);
  assert.deepEqual(ids(listCards(state, 'c3')), ['k7', 'k8', 'k6']);
  fails(() => moveCard(state, 'k6', { position: 5 }), 'invalid');
});
await check('cards: WIP limits on add, move and restore; archive, restore and delete', () => {
  const { addCard, moveCard, archiveCard, restoreCard, deleteCard, listCards } = mod('cards');
  const state = setup({ columns: true });
  state.columns.find(column => column.id === 'c3').wipLimit = 1;
  addCard(state, 'c3', { title: 'x' });
  fails(() => addCard(state, 'c3', { title: 'y' }), 'conflict', 'column is at its WIP limit');
  addCard(state, 'c2', { title: 'a' }); addCard(state, 'c2', { title: 'b' }); addCard(state, 'c2', { title: 'c' });
  fails(() => moveCard(state, 'k6', { columnId: 'c3' }), 'conflict', 'column is at its WIP limit');
  moveCard(state, 'k5', { columnId: 'c3', position: 0 });
  const archived = archiveCard(state, 'k7');
  assert.equal(archived.archived, true); assert.equal(archived.position, null);
  assert.deepEqual(positions(state, 'c2'), ['k6@0', 'k8@1']);
  fails(() => archiveCard(state, 'k7'), 'conflict', 'card is already archived');
  fails(() => moveCard(state, 'k7', { position: 0 }), 'conflict', 'card is archived');
  assert.deepEqual(ids(listCards(state, 'c2', { includeArchived: true })), ['k6', 'k8', 'k7']);
  assert.equal(restoreCard(state, 'k7').position, 2);
  fails(() => restoreCard(state, 'k7'), 'conflict', 'card is not archived');
  archiveCard(state, 'k5');
  moveCard(state, 'k6', { columnId: 'c3' });
  fails(() => restoreCard(state, 'k5'), 'conflict', 'column is at its WIP limit');
  deleteCard(state, 'k8');
  assert.deepEqual(positions(state, 'c2'), ['k7@0']);
});
await check('cards: a column on another board is refused', () => {
  const { addCard, moveCard } = mod('cards');
  const state = setup({ columns: true });
  mod('boards').createBoard(state, { name: 'Other' });
  mod('columns').addColumn(state, 'b5', { name: 'Elsewhere' });
  addCard(state, 'c2', { title: 'x' });
  fails(() => moveCard(state, 'k7', { columnId: 'c6' }), 'invalid', 'column is on another board');
});

// ---- labels (section 11) ----
await check('labels: created with lower-case colours, unique ignoring case, sorted, attached once and in order', () => {
  const { createLabel, updateLabel, deleteLabel, attachLabel, detachLabel, listLabels } = mod('labels');
  const state = setup({ columns: true });
  mod('cards').addCard(state, 'c2', { title: 'x' });
  assert.deepEqual(createLabel(state, 'b1', { name: 'bug', color: '#FF0000' }), { id: 'l6', boardId: 'b1', name: 'bug', color: '#ff0000' });
  createLabel(state, 'b1', { name: 'Docs', color: '#00ff00' });
  createLabel(state, 'b1', { name: 'api', color: '#0000ff' });
  assert.deepEqual(listLabels(state, 'b1').map(label => label.name), ['api', 'bug', 'Docs']);
  fails(() => createLabel(state, 'b1', { name: 'BUG', color: '#000000' }), 'conflict', 'label name already used');
  fails(() => createLabel(state, 'b1', { name: 'x', color: 'red' }), 'invalid');
  fails(() => createLabel(state, 'b1', { name: 'x', color: '#12345' }), 'invalid');
  assert.equal(updateLabel(state, 'l6', { color: '#ABCDEF' }).color, '#abcdef');
  attachLabel(state, 'k5', 'l7'); attachLabel(state, 'k5', 'l6'); attachLabel(state, 'k5', 'l7');
  assert.deepEqual(state.cards[0].labels, ['l7', 'l6']);
  detachLabel(state, 'k5', 'l8');
  assert.deepEqual(detachLabel(state, 'k5', 'l7').labels, ['l6']);
  fails(() => detachLabel(state, 'k5', 'l99'), 'not_found');
  deleteLabel(state, 'l6');
  assert.deepEqual(state.cards[0].labels, []);
  mod('boards').createBoard(state, { name: 'Other' });
  createLabel(state, 'b9', { name: 'bug', color: '#000000' });
  fails(() => attachLabel(state, 'k5', 'l10'), 'invalid', 'label is on another board');
});

// ---- due dates (section 12) ----
await check('due: dates validated, and every status with its boundaries', () => {
  const { setDue, dueStatus } = mod('due');
  const state = setup({ columns: true });
  mod('cards').addCard(state, 'c2', { title: 'x' });
  assert.equal(setDue(state, 'k5', '2024-02-29').due, '2024-02-29');
  for (const bad of ['2023-02-29', '2024-13-01', '2024-1-01', 'soon', 20240101]) fails(() => setDue(state, 'k5', bad), 'invalid', 'due must be a date or null');
  assert.equal(setDue(state, 'k5', null).due, null);
  const status = due => dueStatus({ due }, '2024-02-28');
  assert.deepEqual([status(null), status('2024-02-27'), status('2024-02-28'), status('2024-02-29'), status('2024-03-02'), status('2024-03-03')], ['none', 'overdue', 'today', 'soon', 'soon', 'later']);
  fails(() => dueStatus({ due: null }, '2024-02-30'), 'invalid');
});
await check('due: upcoming and overdue, ends included, archived and other boards left out, in order', () => {
  const { setDue, upcoming, overdue } = mod('due');
  const { addCard, archiveCard } = mod('cards');
  const state = setup({ columns: true });
  const dues = { a: '2024-06-17', b: '2024-06-10', c: '2024-06-10', d: '2024-06-09', e: '2024-06-18', f: null, g: '2024-06-12' };
  for (const [title, due] of Object.entries(dues)) { const card = addCard(state, title === 'c' ? 'c3' : 'c2', { title }); setDue(state, card.id, due); }
  archiveCard(state, state.cards.find(card => card.title === 'g').id);
  const titles = list => list.map(card => card.title);
  assert.deepEqual(titles(upcoming(state, 'b1', '2024-06-10')), ['b', 'c', 'a']);
  assert.deepEqual(titles(upcoming(state, 'b1', '2024-06-10', 8)), ['b', 'c', 'a', 'e']);
  assert.deepEqual(titles(upcoming(state, 'b1', '2024-06-10', 0)), ['b', 'c']);
  assert.deepEqual(titles(overdue(state, 'b1', '2024-06-11')), ['d', 'b', 'c']);
  fails(() => upcoming(state, 'b1', '2024-06-10', 366), 'invalid');
});

// ---- filters (section 13) ----
await check('filters: parseQuery reads every kind of term', () => {
  const { parseQuery } = mod('filters');
  assert.deepEqual(parseQuery('label:bug  label:"needs review" column:Todo column:doing due:soon fix "login page" is:archived'), { text: ['fix', 'login page'], labels: ['bug', 'needs review'], columns: ['Todo', 'doing'], due: 'soon', archived: true });
  assert.deepEqual(parseQuery(''), { text: [], labels: [], columns: [], due: null, archived: false });
  fails(() => parseQuery('due:tomorrow'), 'invalid', 'unknown due filter: tomorrow');
  fails(() => parseQuery('is:open'), 'invalid', 'unknown is filter: open');
  fails(() => parseQuery('owner:me'), 'invalid', 'unknown filter: owner');
});
await check('filters: filterCards matches text, labels (all), columns (any), due and archived, in board order', () => {
  const { filterCards } = mod('filters');
  const state = setup({ columns: true });
  const card = (id, columnId, position, title, extra = {}) => state.cards.push({ id, columnId, title, description: '', position, labels: [], due: null, archived: false, ...extra });
  state.labels.push({ id: 'l20', boardId: 'b1', name: 'Bug', color: '#ff0000' }, { id: 'l21', boardId: 'b1', name: 'ui', color: '#00ff00' });
  card('k10', 'c3', 1, 'Fix login', { labels: ['l20', 'l21'], due: '2024-06-12' });
  card('k11', 'c2', 0, 'Write docs', { description: 'about the LOGIN page', due: '2024-06-09' });
  card('k12', 'c3', 0, 'Login bug', { labels: ['l20'] });
  card('k13', 'c2', null, 'Old login', { archived: true, labels: ['l20'] });
  card('k14', 'c4', 0, 'Ship it', { due: '2024-06-20' });
  const today = '2024-06-10';
  const found = query => ids(filterCards(state, 'b1', query, today));
  assert.deepEqual(found('login'), ['k11', 'k12', 'k10']);
  assert.deepEqual(found('label:bug label:UI'), ['k10']);
  assert.deepEqual(found('label:bug'), ['k12', 'k10']);
  assert.deepEqual(found('column:todo column:DONE'), ['k11', 'k14']);
  assert.deepEqual(found('due:soon'), ['k10']);
  assert.deepEqual(found('due:overdue'), ['k11']);
  assert.deepEqual(found('due:later'), ['k14']);
  assert.deepEqual(found('due:none'), ['k12']);
  assert.deepEqual(found('due:any'), ['k11', 'k10', 'k14']);
  assert.deepEqual(found('is:archived login'), ['k13']);
  assert.deepEqual(found('"login page"'), ['k11']);
  assert.deepEqual(ids(filterCards(state, 'b1', { text: [], labels: ['bug'], columns: ['Doing'], due: null, archived: false }, today)), ['k12', 'k10']);
});

// ---- export (section 14) ----
function exportState() {
  const state = setup({ columns: true });
  state.labels.push({ id: 'l20', boardId: 'b1', name: 'ui', color: '#00ff00' }, { id: 'l21', boardId: 'b1', name: 'Bug', color: '#ff0000' });
  state.cards.push(
    { id: 'k10', columnId: 'c3', title: 'Plain', description: '', position: 0, labels: [], due: null, archived: false },
    { id: 'k11', columnId: 'c2', title: 'Says "hi", then', description: 'line one\nline two', position: 1, labels: ['l20', 'l21'], due: '2024-06-12', archived: false },
    { id: 'k12', columnId: 'c2', title: 'First', description: 'a\rb', position: 0, labels: [], due: null, archived: false },
    { id: 'k13', columnId: 'c2', title: 'Gone', description: '', position: null, labels: ['l21'], due: null, archived: true },
  );
  return state;
}
await check('export: boardToCsv, row order, quoting, CRLF, and archived cards on request', () => {
  const { boardToCsv } = mod('export');
  const head = 'column,position,id,title,description,labels,due,archived\r\n';
  const rows = ['Todo,0,k12,First,"a\rb",,,false\r\n', 'Todo,1,k11,"Says ""hi"", then","line one\nline two",Bug;ui,2024-06-12,false\r\n'];
  assert.equal(boardToCsv(exportState(), 'b1'), head + rows.join('') + 'Doing,0,k10,Plain,,,,false\r\n');
  assert.equal(boardToCsv(exportState(), 'b1', { archived: true }), head + rows.join('') + 'Todo,,k13,Gone,,Bug,,true\r\nDoing,0,k10,Plain,,,,false\r\n');
  fails(() => boardToCsv(exportState(), 'b9'), 'not_found');
});
await check('export: boardToJson', () => {
  const { boardToJson } = mod('export');
  assert.deepEqual(boardToJson(exportState(), 'b1'), {
    id: 'b1', name: 'Main',
    columns: [
      { id: 'c2', name: 'Todo', wipLimit: null, cards: [{ id: 'k12', title: 'First', description: 'a\rb', labels: [], due: null }, { id: 'k11', title: 'Says "hi", then', description: 'line one\nline two', labels: ['ui', 'Bug'], due: '2024-06-12' }] },
      { id: 'c3', name: 'Doing', wipLimit: null, cards: [{ id: 'k10', title: 'Plain', description: '', labels: [], due: null }] },
      { id: 'c4', name: 'Done', wipLimit: null, cards: [] },
    ],
    labels: [{ id: 'l21', name: 'Bug', color: '#ff0000' }, { id: 'l20', name: 'ui', color: '#00ff00' }],
  });
});

// ---- persistence (section 15) ----
await check('persistence: serialize, deserialize and its errors', () => {
  const { serialize, deserialize } = mod('persistence');
  const state = setup({ columns: true });
  assert.equal(serialize(state), JSON.stringify({ format: 'kanban', version: 1, state }, null, 2) + '\n');
  assert.deepEqual(deserialize(serialize(state)), state);
  fails(() => deserialize('nope'), 'invalid', 'not a kanban file');
  fails(() => deserialize('{"format":"other","version":1}'), 'invalid', 'not a kanban file');
  fails(() => deserialize('{"format":"kanban","version":2,"state":{}}'), 'invalid', 'unsupported version 2');
  fails(() => deserialize(JSON.stringify({ format: 'kanban', version: 1, state: { ...state, cards: {} } })), 'invalid', 'corrupt file');
  fails(() => deserialize(JSON.stringify({ format: 'kanban', version: 1, state: { ...state, seq: -1 } })), 'invalid', 'corrupt file');
});
await check('persistence: saveState into a new folder, loadState, and a missing file', async () => {
  const { saveState, loadState, serialize } = mod('persistence');
  const dir = tempDir();
  try {
    const file = path.join(dir, 'deep', 'er', 'board.json');
    const state = setup({ columns: true });
    await saveState(file, state);
    assert.equal(readFileSync(file, 'utf8'), serialize(state));
    assert.equal(existsSync(`${file}.tmp`), false);
    assert.deepEqual(await loadState(file), state);
    assert.deepEqual(await loadState(path.join(dir, 'missing.json')), mod('state').createState());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await check('persistence: the file store saves after each update, and neither saves nor keeps a failed one', async () => {
  const { createFileStore, loadState } = mod('persistence');
  const dir = tempDir();
  try {
    const file = path.join(dir, 'board.json');
    const store = await createFileStore(file);
    const board = await store.update(state => mod('boards').createBoard(state, { name: 'Saved' }));
    assert.equal(board.id, 'b1');
    assert.deepEqual((await loadState(file)).boards, [{ id: 'b1', name: 'Saved' }]);
    const before = readFileSync(file, 'utf8');
    await assert.rejects(store.update(state => { state.boards.push({ id: 'x', name: 'x' }); throw new Error('no'); }), /no/);
    assert.deepEqual(store.read(state => state.boards.map(item => item.id)), ['b1']);
    assert.equal(readFileSync(file, 'utf8'), before);
    const order = [];
    await Promise.all([store.update(() => order.push(1)), store.update(() => order.push(2))]);
    assert.deepEqual(order, [1, 2]);
    const again = await createFileStore(file);
    assert.deepEqual(again.read(state => state.boards), [{ id: 'b1', name: 'Saved' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the HTTP API with every route (sections 9 to 14, 17) ----
async function api(options) {
  const { openServer } = mod('server');
  const opened = await openServer(options);
  const call = async (method, route, body) => {
    const response = await fetch(opened.url + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, type, body: type.includes('application/json') && text ? JSON.parse(text) : text };
  };
  return { ...opened, call, close: () => new Promise(resolve => opened.server.close(resolve)) };
}
await check('HTTP: createServer serves every route module by default', async () => {
  const { createServer, listen } = mod('server');
  const { server, url } = await listen(createServer({ today: () => '2024-06-10' }));
  try {
    await fetch(url + '/boards', { method: 'POST', body: JSON.stringify({ name: 'B' }), headers: { 'Content-Type': 'application/json' } });
    for (const route of ['/boards/b1/columns', '/boards/b1/labels', '/boards/b1/upcoming', '/boards/b1/overdue', '/boards/b1/cards?q=x', '/boards/b1/export.json', '/boards/b1/export.csv']) {
      assert.equal((await fetch(url + route)).status, 200, route);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
await check('HTTP: columns, cards, labels and due dates with their statuses', async () => {
  const app = await api({ today: () => '2024-06-10' });
  try {
    await app.call('POST', '/boards', { name: 'Main' });
    const todo = await app.call('POST', '/boards/b1/columns', { name: 'Todo', wipLimit: 2 });
    assert.equal(todo.status, 201); assert.equal(todo.body.id, 'c2');
    assert.equal((await app.call('POST', '/boards/b1/columns', { name: 'Done' })).status, 201);
    assert.equal((await app.call('POST', '/boards/b1/columns', { name: 'todo' })).status, 409);
    assert.equal((await app.call('POST', '/boards/b1/columns', { name: '' })).status, 400);
    assert.equal((await app.call('PATCH', '/columns/c3', { position: 0 })).body.position, 0);
    assert.deepEqual((await app.call('GET', '/boards/b1/columns')).body.map(column => column.name), ['Done', 'Todo']);
    const card = await app.call('POST', '/columns/c2/cards', { title: 'First' });
    assert.equal(card.status, 201); assert.equal(card.body.id, 'k4');
    await app.call('POST', '/columns/c2/cards', { title: 'Second' });
    const full = await app.call('POST', '/columns/c2/cards', { title: 'Third' });
    assert.deepEqual([full.status, full.body.error?.code], [409, 'conflict']);
    assert.equal((await app.call('PATCH', '/cards/k4', { title: 'One' })).body.title, 'One');
    const moved = await app.call('POST', '/cards/k4/move', { columnId: 'c3' });
    assert.deepEqual([moved.status, moved.body.columnId, moved.body.position], [200, 'c3', 0]);
    assert.equal((await app.call('POST', '/cards/k5/archive')).body.archived, true);
    assert.deepEqual((await app.call('GET', '/columns/c2/cards?archived=true')).body.map(item => item.id), ['k5']);
    assert.equal((await app.call('POST', '/cards/k5/restore')).body.position, 0);
    assert.equal((await app.call('GET', '/cards/k5')).body.title, 'Second');
    const label = await app.call('POST', '/boards/b1/labels', { name: 'Bug', color: '#FF0000' });
    assert.deepEqual([label.status, label.body.color], [201, '#ff0000']);
    assert.deepEqual((await app.call('PUT', '/cards/k4/labels/l6')).body.labels, ['l6']);
    assert.deepEqual((await app.call('DELETE', '/cards/k4/labels/l6')).body.labels, []);
    assert.equal((await app.call('PATCH', '/labels/l6', { name: 'Defect' })).body.name, 'Defect');
    assert.equal((await app.call('PUT', '/cards/k4/due', { due: '2024-06-12' })).body.due, '2024-06-12');
    assert.equal((await app.call('PUT', '/cards/k5/due', { due: '2024-06-01' })).status, 200);
    assert.equal((await app.call('PUT', '/cards/k5/due', { due: 'tomorrow' })).status, 400);
    assert.deepEqual((await app.call('GET', '/boards/b1/upcoming')).body.map(item => item.id), ['k4']);
    assert.deepEqual((await app.call('GET', '/boards/b1/upcoming?days=1')).body, []);
    assert.deepEqual((await app.call('GET', '/boards/b1/overdue')).body.map(item => item.id), ['k5']);
    assert.equal((await app.call('DELETE', '/labels/l6')).status, 204);
    assert.equal((await app.call('DELETE', '/cards/k5')).status, 204);
    assert.equal((await app.call('GET', '/cards/k5')).status, 404);
    assert.equal((await app.call('DELETE', '/columns/c3')).status, 409);
    assert.equal((await app.call('DELETE', '/columns/c3?force=true')).status, 204);
    assert.deepEqual((await app.call('GET', '/boards/b1/columns')).body.map(column => column.id), ['c2']);
  } finally { await app.close(); }
});
await check('HTTP: search and both exports', async () => {
  const app = await api({ today: () => '2024-06-10' });
  try {
    await app.call('POST', '/boards', { name: 'Main' });
    await app.call('POST', '/boards/b1/columns', { name: 'Todo' });
    await app.call('POST', '/columns/c2/cards', { title: 'Fix login', description: 'a, b' });
    await app.call('POST', '/columns/c2/cards', { title: 'Docs' });
    await app.call('POST', '/boards/b1/labels', { name: 'bug', color: '#ff0000' });
    await app.call('PUT', '/cards/k3/labels/l5');
    assert.deepEqual((await app.call('GET', `/boards/b1/cards?q=${encodeURIComponent('label:bug login')}`)).body.map(item => item.id), ['k3']);
    assert.equal((await app.call('GET', `/boards/b1/cards?q=${encodeURIComponent('due:never')}`)).status, 400);
    const csv = await app.call('GET', '/boards/b1/export.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.type, /^text\/csv; charset=utf-8/);
    assert.equal(csv.body, 'column,position,id,title,description,labels,due,archived\r\nTodo,0,k3,Fix login,"a, b",bug,,false\r\nTodo,1,k4,Docs,,,,false\r\n');
    const json = await app.call('GET', '/boards/b1/export.json');
    assert.deepEqual(json.body.columns[0].cards.map(item => item.labels), [['bug'], []]);
  } finally { await app.close(); }
});
await check('HTTP: openServer with a data file keeps everything across a restart', async () => {
  const dir = tempDir();
  try {
    const dataFile = path.join(dir, 'board.json');
    let app = await api({ dataFile, today: () => '2024-06-10' });
    await app.call('POST', '/boards', { name: 'Kept' });
    await app.call('POST', '/boards/b1/columns', { name: 'Todo', wipLimit: 3 });
    await app.call('POST', '/columns/c2/cards', { title: 'Card' });
    await app.close();
    app = await api({ dataFile, today: () => '2024-06-10' });
    try {
      assert.deepEqual((await app.call('GET', '/boards')).body, [{ id: 'b1', name: 'Kept' }]);
      assert.deepEqual((await app.call('GET', '/boards/b1/columns')).body, [{ id: 'c2', boardId: 'b1', name: 'Todo', position: 0, wipLimit: 3 }]);
      assert.equal((await app.call('POST', '/columns/c2/cards', { title: 'Next' })).body.id, 'k4', 'the id counter was saved too');
    } finally { await app.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the client (section 16) against the real server ----
await check('client: every method against the real server', async () => {
  const { createClient, ApiError } = require('./client/api.js');
  const app = await api({ today: () => '2024-06-10' });
  try {
    const client = createClient(app.url);
    const board = await client.createBoard('Main');
    const todo = await client.addColumn(board.id, { name: 'Todo', wipLimit: 2 });
    const done = await client.addColumn(board.id, { name: 'Done' });
    assert.deepEqual((await client.listColumns(board.id)).map(column => column.name), ['Todo', 'Done']);
    assert.equal((await client.updateColumn(done.id, { name: 'Shipped' })).name, 'Shipped');
    const card = await client.addCard(todo.id, { title: 'Write' });
    await client.addCard(todo.id, { title: 'Read' });
    await assert.rejects(client.addCard(todo.id, { title: 'Too many' }), error => error instanceof ApiError && error.status === 409 && error.code === 'conflict');
    assert.equal((await client.updateCard(card.id, { description: 'd' })).description, 'd');
    assert.equal((await client.getCard(card.id)).description, 'd');
    assert.equal((await client.moveCard(card.id, { columnId: done.id })).columnId, done.id);
    const label = await client.createLabel(board.id, { name: 'ui', color: '#123456' });
    assert.deepEqual((await client.attachLabel(card.id, label.id)).labels, [label.id]);
    assert.deepEqual((await client.listLabels(board.id)).map(item => item.name), ['ui']);
    assert.equal((await client.updateLabel(label.id, { name: 'UI' })).name, 'UI');
    assert.equal((await client.setDue(card.id, '2024-06-11')).due, '2024-06-11');
    assert.deepEqual((await client.upcoming(board.id, { days: 1 })).map(item => item.id), [card.id]);
    assert.deepEqual(await client.overdue(board.id), []);
    assert.deepEqual((await client.searchCards(board.id, 'label:ui due:soon')).map(item => item.id), [card.id]);
    assert.match(await client.exportCsv(board.id), /^column,position,id,title,description,labels,due,archived\r\n/);
    assert.equal((await client.exportJson(board.id)).name, 'Main');
    assert.deepEqual((await client.detachLabel(card.id, label.id)).labels, []);
    assert.equal(await client.deleteLabel(label.id), undefined);
    const archived = await client.archiveCard(card.id);
    assert.equal(archived.archived, true);
    assert.deepEqual((await client.listCards(done.id, { archived: true })).map(item => item.id), [card.id]);
    assert.match(await client.exportCsv(board.id, { archived: true }), /,true\r\n$/);
    assert.equal((await client.restoreCard(card.id)).archived, false);
    assert.equal(await client.deleteCard(card.id), undefined);
    await assert.rejects(client.removeColumn(todo.id), error => error instanceof ApiError && error.status === 409);
    assert.equal(await client.removeColumn(todo.id, { force: true }), undefined);
  } finally { await app.close(); }
});
await check('the plan\'s other files exist: routes index, bin/serve.js, the end-to-end test, client/README.md', () => {
  assert.equal(require('./src/routes/index.js').length, 7);
  for (const file of ['bin/serve.js', 'test/e2e.test.js', 'client/README.md', 'test/api.test.js']) assert.ok(existsSync(path.join(repo, file)), file);
});

const failed = results.filter(result => !result.ok).map(result => result.name);
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed }));
process.exitCode = failed.length ? 1 : 0;

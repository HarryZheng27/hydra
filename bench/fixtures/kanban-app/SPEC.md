# Kanban board: specification

The exact behaviour of every part of the board. Plain Node (CommonJS, Node 20 or later), no dependencies. Sections 1 to 8 describe what exists today; sections 9 to 18 are the work.

## 1. Rules for every module

- A domain module (`src/<name>.js`) exports plain functions that take the state (section 2) first and change it in place. They never do I/O.
- A route module (`src/routes/<name>.js`) exports `register(router, context)` (section 6) and reaches the state only through `context.store`.
- Input objects are checked strictly: a field that isn't listed is refused with `invalid` and the message `unknown field: <name>` (`onlyFields` in `src/state.js`). Names are trimmed and checked with `cleanName` from `src/state.js`.
- Errors are `KanbanError`s from `src/errors.js`, made with `invalid(message)`, `notFound(message)` or `conflict(message)`. Where this spec gives a message, use it exactly. An unknown id is `notFound` with `<kind> <id> not found`, as the `find*` helpers in `src/state.js` do.
- A module's tests may build state by hand (section 2) or with `src/boards.js`, but must not require another module this spec adds: those are written at the same time, by someone else.

## 2. The state

```js
{
  version: 1,
  seq: 7,                  // the last number handed out by nextId
  boards:  [{ id: 'b1', name: 'Roadmap' }],
  columns: [{ id: 'c2', boardId: 'b1', name: 'Todo', position: 0, wipLimit: null }],
  cards:   [{ id: 'k3', columnId: 'c2', title: 'Write docs', description: '', position: 0, labels: ['l4'], due: '2026-10-01', archived: false }],
  labels:  [{ id: 'l4', boardId: 'b1', name: 'docs', color: '#1d76db' }],
}
```

- `createState()` makes an empty one; `nextId(state, prefix)` hands out `b`, `c`, `k` and `l` ids from the one counter.
- A board's columns have positions `0` to `n - 1`, with no gaps. A column's **active** cards (`archived: false`) have positions `0` to `n - 1`, with no gaps; **archived** cards have position `null`. Every function keeps this true.
- `wipLimit` is `null` (no limit) or a whole number, at least 1. `due` is `null` or a date `YYYY-MM-DD`. `labels` holds label ids in the order they were attached. `color` is `#` and 6 lower-case hex digits.

## 3. Errors and HTTP statuses

`invalid` is 400, `not_found` 404, `conflict` 409. An error response's body is `{ "error": { "code": "<code>", "message": "<message>" } }`.

## 4. Boards (exists: `src/boards.js`, `src/routes/boards.js`)

`createBoard(state, { name })` (1 to 100 characters), `renameBoard(state, boardId, name)`, `deleteBoard(state, boardId)` (removes its columns, their cards and its labels), `listBoards(state)`, `getBoard(state, boardId)`. Routes: `GET /boards`, `POST /boards` (201), `GET /boards/:id`, `PATCH /boards/:id` with `{ name }`, `DELETE /boards/:id` (204).

## 5. The store (exists: `src/store.js`)

Routes reach the state only through a store: `read(fn)` returns `fn(state)`; `update(fn)` runs `fn(state)`, one update at a time, and resolves with its result; when `fn` throws, the state is put back as it was before and the promise rejects with the error; `snapshot()` returns a deep copy. `createMemoryStore(state?)` is the in-memory one.

## 6. HTTP (exists: `src/http.js`, `src/server.js`)

- `createRouter()`: `route(method, pattern, handler)`, where `:name` in the pattern matches one path segment. A handler gets `{ params, query, body, method, path }` (`query` is a URLSearchParams, `body` the parsed JSON body or `undefined`) and returns or resolves to `{ status, body }` (JSON; 204 sends nothing), `{ status, text, type }` (text), or any other value (200 with it as JSON). A thrown KanbanError becomes its status and error body. An unknown path is 404 `no route`; a known path with another method is 405 with an `Allow` header.
- `createServer({ store, routes, today })` returns a Node `http.Server`: `store` defaults to a new in-memory store; `routes` is a list of route modules' `register` functions (today, only the board routes by default); `today()` returns the current date as `YYYY-MM-DD` (UTC by default; tests pass a fixed one). `GET /health` is always there. `listen(server, port = 0)` starts it on 127.0.0.1 and resolves with `{ server, url }`.
- Route modules are registered with `register(router, { store, today })`.
- Unless a section says otherwise, a route that creates something answers 201 with it, a route that changes something answers 200 with the changed thing, and a route that deletes answers 204.

## 7. The client (exists: `client/api.js`)

`createClient(baseUrl, { fetch })` returns methods that call the API and resolve with the response's JSON (a string for text responses, `undefined` for 204), or reject with an `ApiError` carrying `status`, `code` and `message`. Today: `health`, `listBoards`, `createBoard(name)`, `getBoard(id)`, `renameBoard(id, name)`, `deleteBoard(id)`, and `request(method, path, body)`.

## 8. Tests

`node --test`. `test/helpers.js` has `startServer(options)`, which starts `createServer(options)` on a free port and gives `{ url, request(method, path, body), close() }`. Route tests pass the route modules they need: `startServer({ routes: [require('../src/routes/boards').register, require('../src/routes/columns').register] })`.

## 9. Columns: `src/columns.js`, `src/routes/columns.js`

- `addColumn(state, boardId, input)`: fields `name` (required, 1 to 60 characters), `wipLimit` (optional, default `null`), `position` (optional, a whole number from 0 to the board's column count; default: the end). The name must be unique on its board, ignoring case: otherwise `conflict` `column name already used`. A bad `wipLimit` or `position` is `invalid`. Columns at or after the position move up by one. Returns the new column `{ id, boardId, name, position, wipLimit }`, with an id from `nextId(state, 'c')`.
- `updateColumn(state, columnId, input)`: optional fields `name` (same rules; the column's own name in another case is fine), `wipLimit` (`null` clears it; a limit below the column's active card count is `conflict` `WIP limit below current cards`), `position` (0 to count − 1: the column moves there and the others close up). Returns the column.
- `removeColumn(state, columnId, { force = false } = {})`: a column with any cards, archived ones included, is `conflict` `column has cards` unless `force` is true, which deletes its cards too. The board's other columns close up. Returns the removed column.
- `listColumns(state, boardId)`: the board's columns by position.
- Routes: `GET /boards/:id/columns`, `POST /boards/:id/columns` (201), `PATCH /columns/:id`, `DELETE /columns/:id` (204; `?force=true` forces).

## 10. Cards: `src/cards.js`, `src/routes/cards.js`

- `addCard(state, columnId, input)`: fields `title` (required, 1 to 200 characters), `description` (optional string of at most 2000 characters, kept exactly as given; default `''`), `position` (optional, 0 to the column's active card count; default: the end). A column with a `wipLimit` whose active card count has reached it: `conflict` `column is at its WIP limit`. Returns the new card, with an id from `nextId(state, 'k')`, `labels: []`, `due: null` and `archived: false`.
- `updateCard(state, cardId, input)`: optional fields `title` and `description`, with the same rules. Returns the card.
- `moveCard(state, cardId, input)`: optional fields `columnId` (default: the card's column) and `position` (0 to the number of other active cards in the target column; default: the end). A target column on another board: `invalid` `column is on another board`. An archived card: `conflict` `card is archived`. Moving into another column checks its WIP limit (`conflict` as for `addCard`). Both columns' positions stay without gaps. Returns the card.
- `archiveCard(state, cardId)`: sets `archived: true` and `position: null`, and the column closes up; an archived card is `conflict` `card is already archived`. `restoreCard(state, cardId)`: puts it back at the end of its column, checking the WIP limit; a card that isn't archived is `conflict` `card is not archived`. Both return the card.
- `deleteCard(state, cardId)`: removes it (the column closes up) and returns it.
- `listCards(state, columnId, { includeArchived = false } = {})`: the column's active cards by position; with `includeArchived`, then its archived cards in the order they appear in `state.cards`.
- Routes: `GET /columns/:id/cards` (`?archived=true` includes archived cards), `POST /columns/:id/cards` (201), `GET /cards/:id`, `PATCH /cards/:id`, `POST /cards/:id/move`, `POST /cards/:id/archive`, `POST /cards/:id/restore` (all 200 with the card), `DELETE /cards/:id` (204).

## 11. Labels: `src/labels.js`, `src/routes/labels.js`

- `createLabel(state, boardId, input)`: fields `name` (required, 1 to 30 characters, unique on the board ignoring case: otherwise `conflict` `label name already used`) and `color` (required: `#` and 6 hex digits in either case, stored in lower case; anything else is `invalid`). Id from `nextId(state, 'l')`.
- `updateLabel(state, labelId, input)`: optional `name` and `color`, with the same rules.
- `deleteLabel(state, labelId)`: removes it from every card's `labels` too; returns it.
- `attachLabel(state, cardId, labelId)`: the label must be on the card's board (its column's board): otherwise `invalid` `label is on another board`. Attaching one already attached changes nothing. It goes at the end of `labels`. Returns the card.
- `detachLabel(state, cardId, labelId)`: removes it from the card's `labels` (nothing changes when it isn't there; an unknown label is still `not_found`). Returns the card.
- `listLabels(state, boardId)`: the board's labels sorted by name, lower-cased, by code unit.
- Routes: `GET /boards/:id/labels`, `POST /boards/:id/labels` (201), `PATCH /labels/:id`, `DELETE /labels/:id` (204), `PUT /cards/:id/labels/:labelId` and `DELETE /cards/:id/labels/:labelId` (both 200 with the card).

## 12. Due dates: `src/due.js`, `src/routes/due.js`

- A **date** is `YYYY-MM-DD` and a real calendar date (leap years count). Work in whole days (UTC), never local time.
- `setDue(state, cardId, due)`: `due` is a date or `null`; anything else is `invalid` `due must be a date or null`. Returns the card.
- `dueStatus(card, today)`: `'none'` when `due` is null; `'overdue'` before today; `'today'`; `'soon'` 1 to 3 days after today; `'later'` after that. A `today` that isn't a date is `invalid`.
- `upcoming(state, boardId, today, days = 7)`: the board's active cards due from today to `days` days after it, both included, sorted by due date and then by their order in `state.cards`. `days` is a whole number from 0 to 365 (`invalid` otherwise).
- `overdue(state, boardId, today)`: the board's active cards due before today, in the same order.
- Routes: `PUT /cards/:id/due` with `{ due }` (200 with the card), `GET /boards/:id/upcoming` (`?days=N`, default 7) and `GET /boards/:id/overdue`, both with `today` from `context.today()`.

## 13. Filters: `src/filters.js`, `src/routes/filters.js`

- `parseQuery(text)` returns `{ text: [], labels: [], columns: [], due: null, archived: false }` filled from the query's terms. Terms are separated by whitespace, except inside double quotes. A term `key:value`, where key is lower-case letters, is a filter; its value may be quoted (`label:"needs review"`):
  - `label:<name>`: the card has this label (every `label:` term must match);
  - `column:<name>`: the card is in this column (any one `column:` term may match);
  - `due:<status>`: `overdue`, `today`, `soon`, `later` (as in section 12), `none` (no due date) or `any` (has one); another value is `invalid` `unknown due filter: <value>`; the last one wins;
  - `is:archived`: only archived cards (another value is `invalid` `unknown is filter: <value>`);
  - any other key is `invalid` `unknown filter: <key>`.
  Every other term is text (a quoted one without its quotes): each must appear in the card's title or description, ignoring case.
- `filterCards(state, boardId, query, today)`: `query` is a string (parsed with `parseQuery`) or an object of that shape. Returns the board's cards that match every part of it: active cards only, or archived cards only with `archived`. Label and column names match ignoring case. The due statuses are computed as in section 12 (implement them here: `src/due.js` is written at the same time). Order: by column position, then by card position; archived cards by column position, then by their order in `state.cards`.
- Route: `GET /boards/:id/cards?q=<query>` (200 with the list; `today` from `context.today()`).

## 14. Export: `src/export.js`, `src/routes/export.js`

- `boardToCsv(state, boardId, { archived = false } = {})`: CSV with the header `column,position,id,title,description,labels,due,archived`, then for each column by position its active cards by position, then, with `archived`, its archived cards in `state.cards` order with an empty position. `column` is the column's name; `labels` the names of the card's labels sorted as `listLabels` sorts them, joined with `;`; `due` the date or empty; `archived` `true` or `false`. A field containing a comma, a double quote, CR or LF is quoted, with each `"` doubled. Every record, the last included, ends with CRLF.
- `boardToJson(state, boardId)`: `{ id, name, columns: [{ id, name, wipLimit, cards: [{ id, title, description, labels, due }] }], labels: [{ id, name, color }] }`: columns by position, each with its active cards by position, `labels` on a card as label names in the card's order, and the board's labels sorted as `listLabels` sorts them.
- Routes: `GET /boards/:id/export.csv` (`?archived=true` includes them; 200 with content type `text/csv; charset=utf-8`) and `GET /boards/:id/export.json`.

## 15. Persistence: `src/persistence.js`

- `serialize(state)`: `JSON.stringify({ format: 'kanban', version: 1, state }, null, 2)` followed by `\n`.
- `deserialize(text)`: the state. Text that isn't JSON, or whose `format` isn't `'kanban'`, is `invalid` `not a kanban file`; a `version` other than 1 is `invalid` `unsupported version <version>`; a missing `state`, a `seq` that isn't a whole number of at least 0, or any of `boards`, `columns`, `cards`, `labels` not an array is `invalid` `corrupt file`.
- `saveState(file, state)`: resolves once `serialize(state)` is written to `<file>.tmp` and that file is renamed over `file`, creating the folder if needed, so a crash never leaves half a file.
- `loadState(file)`: resolves with the deserialized state, or `createState()` when the file doesn't exist.
- `createFileStore(file)`: resolves with a store (section 5: `read`, `update`, `snapshot`) whose state is loaded from `file`. `update(fn)` runs one at a time; after `fn` succeeds it saves the whole state with `saveState` and only then resolves with `fn`'s result. When `fn` throws, or saving fails, the state is put back, and the promise rejects with that error.

## 16. The client: `client/api.js`

Add these methods, each calling the route of sections 9 to 14 (ids are URL-encoded):
- `listColumns(boardId)`, `addColumn(boardId, input)`, `updateColumn(columnId, input)`, `removeColumn(columnId, { force } = {})` (adds `?force=true` when `force`);
- `listCards(columnId, { archived } = {})` (`?archived=true`), `getCard(cardId)`, `addCard(columnId, input)`, `updateCard(cardId, input)`, `moveCard(cardId, input)`, `archiveCard(cardId)`, `restoreCard(cardId)`, `deleteCard(cardId)`;
- `listLabels(boardId)`, `createLabel(boardId, input)`, `updateLabel(labelId, input)`, `deleteLabel(labelId)`, `attachLabel(cardId, labelId)`, `detachLabel(cardId, labelId)`;
- `setDue(cardId, due)`, `upcoming(boardId, { days } = {})` (`?days=N` when given), `overdue(boardId)`;
- `searchCards(boardId, query)` (`?q=` with the query URL-encoded);
- `exportCsv(boardId, { archived } = {})` (resolves with the CSV text), `exportJson(boardId)`.

Its tests run against a small stand-in server in the test file (the routes are written at the same time), checking each method's HTTP method, path, query and body, and that an error body becomes an ApiError.

## 17. The server: `src/routes/index.js`, `src/server.js`, `bin/serve.js`

- `src/routes/index.js` exports the `register` functions of every route module: boards, columns, cards, labels, due, filters, export.
- `createServer` uses all of them when `routes` isn't given.
- `openServer({ dataFile, port = 0, today })` in `src/server.js`: with `dataFile`, a file store (`createFileStore(dataFile)`), otherwise an in-memory one; starts listening; resolves with `{ server, url, store }`.
- `bin/serve.js [--port N] [--data <file>]` starts it and prints `Listening on <url>`.
- `test/api.test.js`: one flow through every route module on a real server, the error statuses, and a restart from the same data file keeping everything. `README.md`: an API section listing every route.

## 18. End to end: `test/e2e.test.js`, `client/README.md`

A test that drives a whole board through `client/api.js` against `openServer` with a data file in a temporary folder: columns with a WIP limit, cards added, moved and archived, labels attached, due dates set, a search, both exports, and the WIP limit and another-board errors as ApiErrors; then it closes the server, opens a new one on the same file, and finds everything still there. `client/README.md` documents every client method with one line each.

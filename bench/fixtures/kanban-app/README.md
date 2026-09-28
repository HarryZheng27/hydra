# Kanban board

A small kanban board in plain Node (CommonJS, no dependencies): the board's state and the functions that change it, an HTTP API on Node's `http` module, and a client for it that runs in Node or a browser.

Today it has boards only: `src/state.js` (the state and its helpers), `src/boards.js`, `src/store.js` (the in-memory store), `src/http.js` (a small router), `src/server.js`, `src/routes/boards.js`, and `client/api.js`.

```
npm test
```

## The task

Build the rest of the board to [SPEC.md](SPEC.md), which is exact about every function, route, status and error:

- columns with ordering and WIP limits, cards with ordering, moves and archiving, labels, due dates, search filters, CSV and JSON export (sections 9 to 14), each a domain module with its route module and tests;
- persistence to a JSON file (section 15);
- the client's methods for all of it (section 16);
- then the server that serves every route, with a data file (section 17), and an end-to-end test through the client (section 18).

Every part comes with tests covering each rule of its section, including the errors. `npm test` must pass at the end.

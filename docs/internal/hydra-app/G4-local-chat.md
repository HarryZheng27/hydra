# G4: Local chat with Claude and Codex

**Goal:** Nico can use the app daily as a chat client for Claude Code and Codex in a local folder: streaming, approvals, questions, stop, resume, and a diff review. Hydra's orchestration comes in G5.

**Needs:** G1 (decisions, fixtures, live checks) and G3. **Runs on:** Windows; signed-in CLIs only for the live checks.

## Shape
- **Shared logic in `src/core/chat/`**, host-agnostic and tested by root `npm test`:
  - `events.ts`: one `ChatEvent` union: text delta, thinking, tool call, tool result, file change, approval request, question, plan, usage, error, done.
  - `claude.ts` and `codex.ts`: the adapters, built from G1's decisions and the prior art at `f7c56d1^`.
  - `session.ts`: lifecycle, the turn queue, stop, the idle policy from G1.
  - `store.ts`: an append-only JSONL log per chat plus an index, written with `src/core/atomicFile.ts`, behind the user-only access list `src/core/userHandshake.ts` applies. It keeps the provider's session or thread id for resume and never parses provider transcripts.
- **Stand-in CLIs** in `tests/fixtures/app/standins/` replay G1's fixtures. CI never runs a real provider.
- **UI in `app/src/renderer/`:** chat pane, composer, approval and question cards, review pane.
- **A chat is the user's own agent,** like the official extensions. Head confinement doesn't apply to it; it runs with the CLI's own permissions and sandbox. Say so in THREAT_MODEL.

## Milestones (one PR each, in order)
1. **Core and Claude:** `events.ts`, `store.ts`, `session.ts`, `claude.ts`, the Claude stand-in, and tests for every Claude fixture scenario.
2. **Claude in the app:**
   - **Chat pane:** streamed markdown with no raw HTML and sanitized links, collapsible tool and thinking blocks.
   - **Composer:** model, effort, and permission mode. Default, accept edits and plan are allowed; bypass is excluded in v1.
   - **Controls:** approval cards drawn only from structured requests, and Stop.
   - **Folder trust:** a prompt before the first chat in a folder. It states that the project's own hooks and MCP servers will run, and no chat starts without it.
   - **Chat list:** chats grouped by project, kept across restarts.
3. **Codex:** `codex.ts`, its stand-in and tests, and the UI parity: approval kinds, model list, effort, and sandbox. Read-only and workspace-write are allowed; full access is excluded in v1.
4. **The rest of the conversation:**
   - **Questions and plan approval** use G1's chosen route.
   - **Images** in the composer.
   - **Slash commands** pass through.
   - **Open in terminal** runs the CLI's interactive resume in a console, for anything the adapter can't render.
5. **Review and polish:**
   - **Review pane:** read-only Monaco diff of the working tree against HEAD, plus Open in editor.
   - **Usage and cost** per turn, as the provider reports them.
   - **Clear errors:** a missing CLI sends you to onboarding. A usage limit shows a message, and G5 adds the handoff. Malformed output stops safely.
   - **Live checks:** extend `scripts/app-live/` to run through the adapters.

## Local checks per PR
Root `npm run check` and `npm test`; `npm --prefix app run check`, `test`, `build` and `smoke`.

## Acceptance
- [ ] Every G1 fixture scenario passes through its adapter: text, tools, approval allow, deny and edit, interrupt, resume. Malformed output stops safely, and an unknown request is denied and logged.
- [ ] App smoke with stand-ins, for both providers: new chat, stream, approve, deny, stop, restart the app, resume, and the review pane shows the diff.
- [ ] A test proves HTML, scripts and `javascript:` links in model output render inert.
- [ ] A test proves approval-looking text in a reply renders as text, never as a card.
- [ ] A test proves no chat starts in an untrusted folder.
- [ ] On Windows, a test checks that chat logs are readable only by the user.
- [ ] Live checks pass for both providers on Nico's machine, with evidence in the Result.
- [ ] THREAT_MODEL entries exist for chat logs, sanitization, approval routing, trust, and the chat's own permissions.
- [ ] Last step: ask Nico to do one real task with each provider. Fix what he finds, or list it as follow-ups in the Result.

# G1: Spikes

**Goal:** answer the questions the app depends on, with recorded evidence, before product code exists. No product code in this goal.

**Needs:** Windows; `claude` and `codex` signed in by Nico, at or above the minimums in `src/core/cliVersions.ts`; a scratch git repository outside this one (`CONTRIBUTING.md`: tests never make worktrees of this repository).

**Budget:** the smallest model of each provider, at most 30 turns each. Stop on a usage limit.

## Deliverables (one PR, `feat/app-g1-spikes`)
- `scripts/app-live/claude.mjs` and `scripts/app-live/codex.mjs`: live checks that drive each CLI through the scenarios below and print pass or fail per scenario. Follow `scripts/claude-acceptance.mjs`'s shape (`--fixture` or `--live`, `--evidence <path>`), but these do send turns, with the turn cap built in. G4 reruns them on every CLI update.
- `tests/fixtures/app/claude/*.jsonl` and `tests/fixtures/app/codex/*.jsonl`: one recorded protocol transcript per scenario, both directions, redacted with `src/core/redact.ts` plus home paths, emails and account ids, each under 200 KB. G4's stand-in CLIs replay these.
- A **Result** section in this file answering every question below, then the plan's adapters table, Cloud and Security sections updated where the facts differ.

## S1: Claude
Start: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>`. Prior art: `f7c56d1^:src/core/claudeProtocol.ts` and `managedClaude.ts`; today's `src/core/helperRunner.ts` already sends `initialize` and `interrupt` control requests.
1. Three turns in one process: list every event type seen.
2. **Route A, the control channel:** `--permission-prompts host`, as Hydra 0.22 used, or its documented equivalent ([headless](https://code.claude.com/docs/en/headless) documents `--permission-prompts none`). Record `control_request` `can_use_tool` for Bash, Edit or Write, WebFetch and an MCP tool. Answer allow, deny, and allow with edited input.
3. **Questions and plan approval on route A:** answer `AskUserQuestion` through `updatedInput` answers, the shape the Agent SDK documents for `canUseTool` ([user input](https://code.claude.com/docs/en/agent-sdk/user-input)). Allow `ExitPlanMode` in `--permission-mode plan`, and deny it with feedback.
4. **Route B:** `--permission-prompt-tool mcp__<stub>__approve` with a stub MCP server. Confirm questions can't pass there. Check whether a model-made call to the tool can be told apart.
5. `interrupt` mid-tool and mid-text. `/model` and `/effort` as messages. A custom slash command and a skill. An image in a user message.
6. Kill the process, restart with `--resume <id>`, continue.
7. Record that `-p` runs a project's hooks and `.mcp.json` without a trust prompt (headless docs), so the app's own trust prompt is required.

**Decide:** route A or B (A is expected, since only A carries questions and plan approval); the image format; whether an idle chat keeps its process or resumes per message.

## S2: Codex
Start: `codex app-server`, JSON-RPC over stdio. Prior art: `f7c56d1^:src/core/managedCodex.ts` and `codexProtocol.ts`; types in `src/core/generated/codex-0.154.0/`.
1. `initialize`, `thread/start` with a working folder, `turn/start`: list every notification in a turn, including `thread/tokenUsage/updated`.
2. `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`: accept, decline, and any per-session option.
3. `turn/interrupt` mid-command. `thread/resume` after the process restarts.
4. Images in `UserInput`; `model/list`; reasoning effort per turn.
5. In a folder Codex hasn't trusted, does it run that project's config or MCP servers without asking?
6. If the CLI version changed, generate types with `codex app-server generate-ts` into a new `src/core/generated/codex-<version>/`, following the existing folder.

**Decide:** one app-server per chat or one per app; the exact method list G4 uses.

## S4: Electron and node-pty
Work in a scratch folder outside the repository.
1. **Electron version:** match the IDE's, the `target` in upstream VS Code's `.npmrc` at the commit pinned in `desktop/upstream.json`, unless there's a reason not to.
2. **node-pty:** for that Electron on Windows, prebuilt or `@electron/rebuild`; ConPTY works; how `src/core/lanePty.ts` finds it in the app.
3. **MCP bridge:** `ELECTRON_RUN_AS_NODE=1 <app exe> hydra-mcp.cjs` works, since the bridge needs it. The IDE ships upstream's fuse defaults; `scripts/desktop-asar-compatibility-probe.mjs` only probes ASAR integrity. Pick the app's fuses, keeping RunAsNode.
4. **Renderer:** Monaco's diff editor and xterm.js run in a sandboxed renderer under the plan's CSP, including workers. Record the exact CSP that works.
5. **Identity:** a userData override and a single-instance lock that never touch the IDE's.

**Decide:** the Electron version, the node-pty approach, the fuses and the CSP string.

## Acceptance
- [ ] Every numbered question answered in the Result with evidence: the command and an excerpt.
- [ ] Both live checks pass on Nico's machine.
- [ ] Fixtures committed, redacted, each under 200 KB.
- [ ] The plan updated where facts differ.
- [ ] No product code changed; Check and `npm test` green.

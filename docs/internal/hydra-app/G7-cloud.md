# G7: Cloud chats and Codex cloud heads

**Goal:** a Local or Cloud switch. Cloud chats work for both providers, and Codex cloud heads work in plans. Cloud work counts only after it comes back and passes local gates.

**Needs:** G5. Nico must set up a test repository on GitHub, Claude Code on the web with that repository connected (a paid plan), and a Codex cloud environment for it (its env id). If any is missing, stop and ask. **Runs on:** Windows.

**Budget:** at most 10 cloud tasks per provider while developing.

## Milestones (one PR each, in order)
1. **Spike S3,** recorded like G1, with fixtures and stand-ins:
   - **Claude:** what `claude --cloud "<prompt>"` prints (session id, URL) and how it fails: repository not on GitHub, dirty tree, not signed in. Whether `claude --teleport <id>` works on Windows into a fresh worktree, and whether the app can then continue it with `--resume`.
   - **Codex:** the output of `codex cloud exec --env <id> "<prompt>"`, `codex cloud status`, `codex cloud diff`, `codex apply` and `codex cloud list`, including any JSON output.
   - Update the plan's Cloud section with the facts.
2. **Cloud chats:**
   - **The switch:** Local or Cloud in the composer.
   - **Status:** a Codex cloud chat polls its status. A Claude cloud chat shows "running on claude.ai" and the link, because the CLI reports no status.
   - **Bring back:** into a fresh worktree on a new branch, then continue locally if S3 allows; otherwise open the CLI in a console.
3. **Codex cloud heads:**
   - **The setting:** a plan job gets `where: "cloud"`, only with provider `codex`, added to `schemas/hydra-plan.schema.json` and the canvas job editor.
   - **The run:** `src/core/planRunner.ts` starts it, polls it with a time limit, and applies its diff to the job's branch at the job's base. It then runs the job's gates and review locally, confined as usual, and lands it like any other job. Failures retry or skip like local jobs.
   - **The canvas** shows cloud state and the link.
4. **Docs and threat model:**
   - **Docs:** cloud in `docs/App.md` and `docs/Heads.md`.
   - **THREAT_MODEL:** a cloud diff is untrusted input. It's applied only inside a worktree, and the gates, git settings and hook checks (HSEC-30) and the scope rules still apply. Opening provider links needs a confirm.
   - **Tests:** with stand-in `codex cloud` and `claude --cloud`.

## Local checks per PR
Root `npm run check` and `npm test`; `npm --prefix app run check`, `test`, `build` and `smoke`.

## Acceptance
- [ ] Stand-in tests: a cloud head lands only after its local gates pass. A failed gate gets a fix round or fails like a local job. A diff that touches files outside the job's scope is handled like a local scope conflict.
- [ ] Live, once each on Nico's machine: a Claude cloud chat starts and comes back, a Codex cloud chat does too, and a 2-job plan with one Codex cloud head lands.
- [ ] Old plan files validate unchanged, and `where: "cloud"` is refused for Claude jobs.
- [ ] The Result explains how to add Claude cloud heads once its CLI reports status.

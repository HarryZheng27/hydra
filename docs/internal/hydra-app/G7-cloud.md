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

## Spike S3 (2026-10-04)

### Claude (done; 5 of the 10 Claude cloud sessions used)
Run on Nico's machine with Claude Code 2.1.282 (Claude Max), against the private sandbox `ndunl075/hydra-cloud-sandbox` (the benchmark's `shop` fixture). The script is `scripts/app-live/claude-cloud.mjs`; the redacted captures, with stand-in session ids and `<project>` for the folder, are in `tests/fixtures/app/claude-cloud/`.

1. **`--cloud` needs a terminal.** With stdout piped it refuses: "--cloud requires an interactive terminal. Non-interactive invocations … would silently ignore --cloud" (`cloud-requires-tty`). The app runs it in a pseudo-terminal (node-pty, as lanes do), which must answer the terminal's queries (version, device attributes, cursor position).
2. **Starting a session** (`cloud-created`): in a folder Claude Code hasn't trusted, its own trust prompt comes first. Then it prints three lines and exits 0:
   `Created cloud session: <title>`, `View: https://claude.ai/code/<session_id>?from=cli&m=0`, `Resume with: claude --teleport <session_id>`. The title is Claude's summary of the task.
3. **No status while it runs.** The CLI reports nothing after that, as the plan expected: a Claude cloud chat shows "running on claude.ai" and the link.
4. **What is uploaded: a snapshot of the local working tree, not the GitHub repository.**
   - A repository with **no remote at all** still makes a session (`cloud-no-github-remote`); the plan's "needs the repository on GitHub" is wrong for the CLI.
   - **Uncommitted edits to tracked files go to the cloud** (`cloud-dirty-tree`, `teleport-dirty-tree-answer`: the session read a line that was never committed), with no warning.
   - **Untracked and git-ignored files don't** (`teleport-untracked-listing`: no `.gitignore`, untracked file or ignored `.env` in the session's listing).
5. **The work can't come back as code.** The session's copy has no git remote: asked to commit and push, it committed (on a branch in its own copy) and then reported "fatal: 'origin' does not appear to be a git repository" (`teleport-push-refused`). Nothing reached GitHub, and teleport brought no file back.
6. **`claude --teleport <session_id>` works on Windows into a fresh worktree:** it validates the session, fetches its log, looks for a branch, and resumes the conversation in the terminal ("Session resumed"), interactive from there. The worktree's files are unchanged, because of 5.
7. **No non-interactive continue.** `claude -p --resume <session_id>` refuses the cloud id ("is not a UUID and does not match any session title", `resume-rejects-cloud-id`), and a teleported session left no local transcript to resume by UUID (checked in a scratch folder and in a folder under Documents). Continuing a teleported session means its terminal.
8. **Environment.** Started from inside another Claude Code session, the child inherits that session's `CLAUDE*` / `ANTHROPIC*` variables, which turn transcript saving off ("inherited CLAUDE_CODE_CHILD_SESSION marker"). The app must start the CLI without them, as it already does for `ELECTRON_RUN_AS_NODE`.
9. **Not tested:** signed out (signing Nico out isn't ours to do), and a session started on claude.ai/code itself, which has the GitHub app's access and may push.

**Decisions for milestone 2 (Claude cloud chats):**
- **Start:** `claude --cloud "<message>"` in a pseudo-terminal in the project folder, without the parent's `CLAUDE*`/`ANTHROPIC*` variables; parse the three lines; show the title, "running on claude.ai" and the link (opened only after a confirm).
- **Before starting, say what goes:** the folder's tracked files as they are on disk, uncommitted edits included; untracked and ignored files stay. Hydra checks nothing about GitHub, because the CLI doesn't need it.
- **"Continue here"** (the plan's Bring back): a fresh worktree on a new branch, with `claude --teleport <session_id>` in a console there. The window says plainly that the cloud's file changes stay in the cloud: what comes back is the conversation.
- **Bringing the changes themselves back** needs the CLI to push or export a session's commits. The Result explains how to add it then, as it does for Claude cloud heads.

### Codex (waiting)
Nico's ChatGPT workspace has no Codex cloud environment yet: `codex cloud exec --env hydra-cloud-sandbox …` answers "no cloud environments are available for this workspace", and `codex cloud list --json` is empty. The Codex half of S3 runs once an environment exists for `ndunl075/hydra-cloud-sandbox` (chatgpt.com/codex → Settings → Environments → Create environment).

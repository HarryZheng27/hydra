# The Windows journey

Run on 2026-09-26, with Claude only: Codex ran nothing.

## The build and setup

- **Build:** Hydra 0.24.0, commit `e2f422a` (main after the evidence status was added). The installed `Hydra.exe` from `.desktop/VSCode-win32-x64`.
- **Extension code:** the same commit's extension, loaded as a development extension from the main checkout. A test window that runs the installed extension code unmodified can re-point the user's real Claude connection to itself. Loading it this way keeps that connection untouched, and the code is identical.
- **Profile:** a fresh, isolated profile and extensions folder, with no settings or extensions carried over.
- **Sign-in:** Nico's Claude Code subscription, through `claude.exe`. No API keys.
- **The repository:** a new one, `hydra-journey`, with one command gate: `node check.js`. It requires every `add.js` or `mul.js` it finds to start with `// SPDX-License-Identifier: MIT`, and checks their results.
- **After the run:** Nico's `~/.claude/settings.json`, his Claude Hydra server entry and `~/.codex/config.toml` were byte-for-byte unchanged. Accepting Claude's folder trust for the journey's lane added a normal `~/.claude.json` project entry, as it would for any user.

## What each step showed

| # | Step | Result |
| --- | --- | --- |
| 1 | Onboarding from a fresh profile | Welcome → Preferences → Appearance → Providers, then Start editing. It opens by itself only in a production window, so it was opened with **Hydra: Open Onboarding**. Providers showed Claude connected and memory on, and Codex not installed. |
| 2 | A plan with two dependent heads | **New plan** from a brief, planned by Claude: two jobs, `mul.js` depending on `add.js`. The second head started only after the first had started, and used its result. Both finished with **Passed required gates** on the canvas. The plan read "2 of 2 done". |
| 3 | A gate that fails, then the head fixes it | In a second plan, the head's first attempt failed `check` for real: the earlier heads' branches weren't merged, so `add.js` wasn't there. The head then asked a question (**Needs an answer**). It was answered from the canvas menu (**Answer question…**). Attempt 2 failed the `flaky` gate on purpose (below). Attempt 3 passed both gates: "✓ check ✓ flaky · Passed required gates". |
| 4 | A lane: work, gates, merge | A Claude lane with a goal created and committed `div.js`. Its first **Merge** ran the gates, and `flaky` failed. **Send to lane** typed the cleaned failure text into Claude's prompt without sending it, so it can be reviewed first. The second Merge passed both gates and merged, and the tile read "Merged · Passed required gates". |
| 4b | Open PR | Not run: the journey repository has no GitHub remote, and a real PR on a public repository was out of scope. The compare link, and the "### Checks" body Step A adds to it, are covered by unit tests. |
| 5 | Reload while a head runs | **Developer: Reload Window** about 3 seconds after **Run plan**. Afterwards the head read "Failed · The Hydra window closed while this head was running.", and the plan read "Incomplete · 1 failed", with **Retry failed jobs**. Retrying started a fresh head, which is step 3's head. |
| 6 | Keyboard and contrast | See below. |
| 7 | Usage-limit handoff | Not caused on purpose, since a real limit can't be triggered. The existing handoff tests cover it, and no limit happened during the run. |

The **`flaky` gate** was a device added for this journey. It fails the first time it runs in a worktree, so Hydra's feedback loop runs even when a head gets everything right first time. In practice the heads read `check.js` and met its rules before finishing: the planner even copied the header rule into its briefs. So one brief was trimmed by hand, and this gate was added.

## Keyboard and contrast

- **What was checked:** the Agents view (canvas and lanes) and four Settings pages (General, Heads, Gates, Packs), in Hydra Dark and Hydra Light.
- **Names:** every focusable control has a name.
- **Keyboard order:** Tab moves through the Agents view in a sensible order: the mode switches, Canvas, Lanes, New plan, the zoom controls, Learn how, each job, then Clear. Settings follows its navigation list.
- **Contrast:** no body text fell below 4.5:1 in either theme. The check blends translucent backgrounds into their parents, and ignores the terminal's hidden measuring elements.

**Found, and fixed in this change:**
- **The settings search box showed no focus.** Its input removed its outline, and the box around it didn't take one. The box now shows the focus colour while its input has focus.
- **A text area showed no focus ring**, such as a gate's command on Settings → Gates. The shared focus rule listed buttons, links, inputs and selects, but not text areas. It now includes them.
- **"Connected, updating for this Hydra…"** appeared in a development window, which by design never rewrites the connection, so the update never came. That window now says "Connected to another Hydra. A development window leaves it as it is."

## What the journey showed about Hydra

- **The evidence status held up** on the canvas for heads, and on the lane tile for a merged lane. The same status was in each job's record.
- **Heads check their own work.** With a readable gate script, heads met its rules before finishing, so Hydra's retry loop was rarely needed.
- **Recovery is honest.** A reload fails the running head with the reason, and the plan offers Retry. It never quietly restarts work. A head that can't pass asks its question instead of guessing, and the answer came from the canvas.
- **Claude's folder-trust prompt defaults to "No, exit".** A stray Enter in a new lane's terminal quits Claude with exit code 0. Earlier live checks hit this, and it isn't Hydra's to change. A lane's first run should expect the prompt.

## What stays open, and who owns it

| Open item | Owner |
| --- | --- |
| A code-signing certificate for `Hydra.exe` and `HydraSetup.exe` | Release owner (Nico) |
| An HTTPS update host serving the fixed paths without redirects | Release owner |
| Custody of the update-signing key, and its GitHub secrets | Release owner |
| The native install step: the helper checks the installer's code signature and runs it | Hydra, after the certificate and trust root exist |
| An upgrade from one signed release to the next, run and recorded | Hydra, after the items above |
| Open PR against a real GitHub repository | Hydra: run on the next public release branch |
| The same journey on a clean machine, with a downloaded, verified installer | Release owner, once installers are signed |

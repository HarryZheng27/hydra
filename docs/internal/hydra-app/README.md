# Building the Hydra app: goals

The [plan](../Hydra_App_Plan.md) is the architecture. This folder splits the build into seven goals an agent can finish alone. Each goal is one file; start it with:

```
/goal Build docs/internal/hydra-app/G2-host-split.md
```

## Goal map

| Goal | What | Needs first | Runs on | AGENTS.md tier |
| --- | --- | --- | --- | --- |
| [G1](G1-spikes.md) | Spikes: Claude chat protocol, Codex app-server, Electron and node-pty | signed-in CLIs | Windows | Sol |
| [G2](G2-host-split.md) | Split the IDE's controller from VS Code | nothing | any; CI covers Windows | Sol |
| [G3](G3-app-foundation.md) | App foundation: secure shell, identity, settings, CI | G1's Electron note | Windows | Terra |
| [G4](G4-local-chat.md) | Local chat with Claude and Codex | G1, G3 | Windows, signed-in CLIs | Terra, Sol for adapters |
| [G5](G5-orchestration.md) | Hydra in the app: heads, plans, gates, canvas, lanes, settings | G2, G4 | Windows | Sol |
| [G6](G6-ship.md) | Ship: "Hydra IDE" rename, installer, updates, release | G5 (its milestone 1 needs nothing) | Windows | Sol |
| [G7](G7-cloud.md) | Cloud chats and Codex cloud heads | G5, Nico's cloud setup | Windows | Terra |

G1 and G2 can run at the same time, in separate sessions. G6 and G7 can too.

## Rules for every goal

**Read first:** this file, the plan, your goal file, `CONTRIBUTING.md`, and every file your goal names. Read code before changing it.

**How work lands:**
1. Each milestone is one pull request from a `feat/app-g<n>-<slug>` branch, following `CONTRIBUTING.md`: small, a plain-sentence title, tests and docs in the same PR, and an HSEC entry for any new security surface.
2. Before every push, merge `main` into your branch. Main moves daily; never rewrite it or force-push a shared branch.
3. Before merging: your goal's local checks pass, CI is green, and an **independent review** is done. That's a fresh agent session, ideally the other provider, reviewing the diff read-only against the goal file. Fix every blocking and high finding, and summarize the review in the PR body under "Independent review:", as recent PRs do. Then merge with a merge commit.
4. Land a milestone before starting the next, unless the goal says they're independent.

**Never:**
- Change the IDE's behaviour, unless your goal says so. Check, `npm test`, `test:smoke` and the Windows desktop workflow stay green.
- Break the plan's hard rules: unmodified CLIs, no sign-in screen, no tokens, plain-text provider names, each user's own subscription.
- Skip, disable or weaken a test or a THREAT_MODEL control.
- Put a real provider in `npm test` or app CI. Use stand-in executables that replay recorded streams. Live checks are separate scripts with a turn cap, and their output goes through `src/core/redact.ts` before anything is committed.
- Touch the IDE's identity: `nameShort`, data folders, AppId, `HydraSetup.exe`. G6 changes only `nameLong`.
- Publish a release or change `desktop/upstream.json`.

**Stop and ask Nico when:**
- A sign-in, account, payment or cloud setup is needed.
- The plan doesn't cover a decision, and the options lead to materially different work.
- The goal can't be done without breaking a rule above.
- CI fails twice for a cause outside your goal, after you've root-caused it.

**Done** means every acceptance box is checked with evidence (a command and its result, or a CI link), every PR is merged, a dated **Result** section is appended to the goal file in the last PR (what changed versus the plan, follow-ups), the plan is updated if a decision changed, and the status table below is updated.

## Status

| Goal | Status | PRs |
| --- | --- | --- |
| G1 | Done | [#294](https://github.com/ndunl075/hydra/pull/294) |
| G2 | Done | #290, #291, #292, #293, #295, #296, #297 |
| G3 | Done | [#298](https://github.com/ndunl075/hydra/pull/298), [#299](https://github.com/ndunl075/hydra/pull/299), [#300](https://github.com/ndunl075/hydra/pull/300), [#301](https://github.com/ndunl075/hydra/pull/301) |
| G4 | Done | [#302](https://github.com/ndunl075/hydra/pull/302), [#304](https://github.com/ndunl075/hydra/pull/304), [#305](https://github.com/ndunl075/hydra/pull/305), [#306](https://github.com/ndunl075/hydra/pull/306), [#307](https://github.com/ndunl075/hydra/pull/307) |
| G5 | Done | [#308](https://github.com/ndunl075/hydra/pull/308), [#309](https://github.com/ndunl075/hydra/pull/309), [#310](https://github.com/ndunl075/hydra/pull/310), [#311](https://github.com/ndunl075/hydra/pull/311), [#312](https://github.com/ndunl075/hydra/pull/312) |
| G6 | Done | [#303](https://github.com/ndunl075/hydra/pull/303), [#313](https://github.com/ndunl075/hydra/pull/313), [#314](https://github.com/ndunl075/hydra/pull/314), [#315](https://github.com/ndunl075/hydra/pull/315), [#316](https://github.com/ndunl075/hydra/pull/316), [#317](https://github.com/ndunl075/hydra/pull/317) |
| G7 | Not started | |

# Changelog

What changed in each Hydra release. Installers and checksums are on the [releases page](https://github.com/ndunl075/hydra/releases); installed copies offer each new release in-app.

## Unreleased

- **The editor is now "Hydra IDE".** Its Start Menu entry, desktop shortcut and title bar say Hydra IDE; the name "Hydra" goes to the upcoming Hydra app. Updating renames the old Hydra shortcuts and keeps your taskbar pins, settings, extensions and data. Uninstalling the IDE later never removes the app's Hydra shortcut.
- **The Hydra app gets an installer** (`HydraAppSetup.exe`): per user with no admin prompt, beside Hydra IDE and never in its way. Uninstalling it removes only its own Claude Code and Codex entries, and its data only when you ask. See the [app guide](docs/App.md).
- **The app updates itself** from stable releases, checked against the release's own `SHA256SUMS-app`; previews never do. Hydra IDE's update prompt is unchanged.
- **Releases carry both installers.** `SHA256SUMS` still lists only `HydraSetup.exe`, so every installed Hydra IDE keeps updating; the app's installer has `SHA256SUMS-app`. App previews are prereleases tagged `v<version>-app.<n>`. `install.ps1` installs the app with `-App` or `$env:HYDRA_INSTALL_APP = '1'`.

## 0.27.1 (2026-10-01)

- **`hydra close`** closes the Hydra window that owns the current folder. It refuses while heads, lanes or a plan are still working, unless you add `--force`. ([#281](https://github.com/ndunl075/hydra/pull/281))
- **Benchmark harness:** runs the computer slept through are marked void and kept out of the results, and the harness closes the windows it opened. ([#280](https://github.com/ndunl075/hydra/pull/280), [#281](https://github.com/ndunl075/hydra/pull/281))

## 0.27.0 (2026-09-30)

**Plans and heads:**
- **A failed integration gate gets fixed:** the plan adds a job that fixes what the gate found, then checks again. ([#259](https://github.com/ndunl075/hydra/pull/259))
- **A better first prompt:** a head's brief now includes the repository's shape and the gate commands it will be checked with. ([#261](https://github.com/ndunl075/hydra/pull/261))
- **Fairer reviews:** a review judges the change against its task, not every input imaginable. ([#264](https://github.com/ndunl075/hydra/pull/264))
- **Heads are never stuck for good:** a question nobody answers no longer blocks a head, and a head whose output goes silent is nudged, then failed instead of hanging. ([#275](https://github.com/ndunl075/hydra/pull/275))
- **Waiting on the provider is visible:** the canvas shows when a head is waiting on its provider. ([#272](https://github.com/ndunl075/hydra/pull/272))
- **Heads keep using the shell** after Claude Code denies a `cd` or loop command, instead of giving up on it. ([#268](https://github.com/ndunl075/hydra/pull/268))
- **Faster, safer `hydra_done`:** its steps are timed, git calls have timeouts, and the process scan runs once. ([#262](https://github.com/ndunl075/hydra/pull/262))
- **Screenshots** retry the browser connection briefly before giving up. ([#266](https://github.com/ndunl075/hydra/pull/266))

**Security:**
- **Heads and reviewers run with your sign-in only:** none of your personal instructions, memories, plugins, hooks or MCP servers reach them. ([#260](https://github.com/ndunl075/hydra/pull/260), [#277](https://github.com/ndunl075/hydra/pull/277))
- **CLI paths are machine settings:** a repository's own settings can't point Hydra at a different `claude` or `codex`. ([#270](https://github.com/ndunl075/hydra/pull/270))

**Updates:**
- **The Install and restart question** is a Hydra card like the rest of Hydra's notifications. ([#263](https://github.com/ndunl075/hydra/pull/263))
- **Updates no longer wait forever** on Hydra's MCP bridge to close. ([#265](https://github.com/ndunl075/hydra/pull/265))

**Benchmark:** larger fixtures, a review for the single agent, summaries across repeat runs, a fairer review loop, and a one-command SWE-bench Verified runner. See [how we benchmark](docs/Benchmark.md). ([#267](https://github.com/ndunl075/hydra/pull/267), [#273](https://github.com/ndunl075/hydra/pull/273), [#274](https://github.com/ndunl075/hydra/pull/274), [#276](https://github.com/ndunl075/hydra/pull/276), [#278](https://github.com/ndunl075/hydra/pull/278))

## 0.26.0 (2026-09-28)

- **The Agent Manager takes the whole window,** and switching back restores the Editor exactly as you left it. ([#257](https://github.com/ndunl075/hydra/pull/257))
- **The Agent Manager / Editor switch** in the title bar, and Hydra's own notification cards in the corner of the window. ([#253](https://github.com/ndunl075/hydra/pull/253))
- **Title bar:** a button to show or hide the agent side bar, and window controls that match. ([#256](https://github.com/ndunl075/hydra/pull/256))
- **One review per plan:** a plan's combined work is reviewed once by the other agent, instead of every job separately. ([#255](https://github.com/ndunl075/hydra/pull/255))
- **Benchmark:** a wider task where parallel work can pay off. ([#251](https://github.com/ndunl075/hydra/pull/251), [#254](https://github.com/ndunl075/hydra/pull/254))

## 0.25.0 (2026-09-28)

**Plans:**
- **Plans from the chat:** the lead can create and run a plan itself, with dependencies between jobs. ([#236](https://github.com/ndunl075/hydra/pull/236))
- **Scope contracts:** jobs declare what they'll change, and Hydra predicts conflicts between them. ([#237](https://github.com/ndunl075/hydra/pull/237))
- **The plan board:** the lead and a plan's jobs can post messages and share decisions. ([#238](https://github.com/ndunl075/hydra/pull/238))
- **Plans that adapt:** independent jobs keep going when one fails, and the lead can retry, edit or skip jobs. ([#239](https://github.com/ndunl075/hydra/pull/239))
- **Both providers as one pool:** a plan's job that hits its usage limit continues in the other provider. ([#240](https://github.com/ndunl075/hydra/pull/240))
- **Unattended plans** run with a budget and leave a report when they end. ([#241](https://github.com/ndunl075/hydra/pull/241))
- **Land it together:** jobs land one at a time on an integration branch, and the combined work must pass an integration gate before **Merge plan** is offered. ([#243](https://github.com/ndunl075/hydra/pull/243), [#245](https://github.com/ndunl075/hydra/pull/245))

**Scripts and CI:**
- **The `hydra` command** runs, waits on and reports plans from a script or CI job, and plans can live in the repository as `.hydra/plans/*.json`. ([#242](https://github.com/ndunl075/hydra/pull/242), [#244](https://github.com/ndunl075/hydra/pull/244))

**Getting started:**
- **First run:** Hydra connects the agents it finds, installs their extensions, and lands you in the Agent Manager. ([#248](https://github.com/ndunl075/hydra/pull/248))
- **One-line install** in PowerShell, checked against the release's `SHA256SUMS`. ([#235](https://github.com/ndunl075/hydra/pull/235))
- **claude-mem is opt-in:** off by default, turned on in **Settings → Connectors**. ([#234](https://github.com/ndunl075/hydra/pull/234))

**Benchmark:** the harness, heads' reported cost, and its first run. See [how we benchmark](docs/Benchmark.md). ([#246](https://github.com/ndunl075/hydra/pull/246), [#247](https://github.com/ndunl075/hydra/pull/247))

## 0.24.2 (2026-09-27)

- **Updates inside Hydra.** An installed Hydra checks for a new release 30 seconds after it starts, then daily, and offers **Update**, **Release notes** and **Skip this version**. **Update** downloads the installer, checks it against `SHA256SUMS`, asks once more, and installs it in place. Turn the check off with `hydra.updates.check`. ([#232](https://github.com/ndunl075/hydra/pull/232))

## 0.24.1 (2026-09-27)

- **Newer provider CLIs work:** sign-in, heads and usage limits accept newer Claude Code and Codex versions, not only the exact ones tested. ([#230](https://github.com/ndunl075/hydra/pull/230))
- **A clean uninstall:** it removes the Claude Code and Codex entries this install added and leaves another Hydra's alone. It asks before removing Hydra's own data; a silent uninstall keeps it unless you add `/HYDRAREMOVEDATA`. ([#229](https://github.com/ndunl075/hydra/pull/229))

## 0.24.0 (2026-09-27)

**Orchestration:**
- **Packs:** roles, gates, MCP servers and skills for one kind of work, turned on per project after review. Coding and Research ship built in. ([#211](https://github.com/ndunl075/hydra/pull/211))
- **Plan jobs can run as lanes you drive** ([#210](https://github.com/ndunl075/hydra/pull/210)), and, if you opt in, Hydra dispatches ready jobs to lanes, runs their gates and sends failures back ([#226](https://github.com/ndunl075/hydra/pull/226)).
- **One plain status for every job:** *Passed required gates*, *Some gates not run*, *No gates configured* or *Human override*. The first time, Hydra offers a starter test gate. ([#223](https://github.com/ndunl075/hydra/pull/223))
- **Show All Projects:** a read-only view across your Hydra windows. ([#225](https://github.com/ndunl075/hydra/pull/225))
- **Preview app** for each lane's dev server. ([#227](https://github.com/ndunl075/hydra/pull/227))

**Security:**
- **Gates:** a gate floor a head can't lower, reviews fenced as data, clean terminal input, and checks on git settings and hooks. ([#212](https://github.com/ndunl075/hydra/pull/212))
- **Heads stay in their worktree:** they can't write outside it, and their shell commands run in a sandbox. Lanes get light limits. ([#214](https://github.com/ndunl075/hydra/pull/214))
- **A published [threat model](docs/THREAT_MODEL.md),** and refused endpoint calls are logged. ([#215](https://github.com/ndunl075/hydra/pull/215))
- **Release checks:** each release has `SHA256SUMS` and a build-provenance attestation. ([#216](https://github.com/ndunl075/hydra/pull/216))
- **Pinned pack servers:** `npx` pack servers are pinned to exact versions and integrity hashes. ([#218](https://github.com/ndunl075/hydra/pull/218))
- **One redactor** masks secrets in logs, transcripts and gate evidence. ([#219](https://github.com/ndunl075/hydra/pull/219))
- **Stop All Agents** and **Resume Agents.** ([#220](https://github.com/ndunl075/hydra/pull/220))
- **An audit log** of denials, approvals and stops. ([#221](https://github.com/ndunl075/hydra/pull/221))

**Fixes:**
- Resume works without a conversation, role notes update live, and the packs folder is watched. ([#213](https://github.com/ndunl075/hydra/pull/213))
- Fixes found by walking through the Windows journey. ([#224](https://github.com/ndunl075/hydra/pull/224))

## 0.23.0 (2026-09-25, prerelease)

The first public build, under the MIT License: heads with a live Agents canvas, lanes, plans, gates, usage-limit handoff between providers, Hydra Settings with Connectors and MCP servers, and importing preferences from another editor.

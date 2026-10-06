<p align="center">
  <img src="./hydra-logo.png" alt="Hydra — three-headed hydra logo" width="160" />
</p>

<h1 align="center">Hydra</h1>

<p align="center">
  <b>A desktop editor for Claude Code and Codex, where one chat grows many heads.</b><br>
  Parallel agents in their own git worktrees, plans with dependencies, independent gates and reviews before anything counts as done, and one window to watch and merge it all.
</p>

<p align="center">
  <a href="https://github.com/ndunl075/hydra/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ndunl075/hydra?label=release"></a>
  <a href="https://github.com/ndunl075/hydra/actions/workflows/check.yml"><img alt="Check" src="https://github.com/ndunl075/hydra/actions/workflows/check.yml/badge.svg?branch=main"></a>
  <img alt="Platform: Windows 10/11 x64" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-2b2b2b">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2b2b2b"></a>
</p>

<p align="center">
  <a href="https://github.com/ndunl075/hydra/releases/latest/download/HydraSetup.exe"><b>Download Hydra IDE for Windows</b></a>
  · <a href="https://www.usefrontierdigital.com/hydra">Website</a>
  · <a href="docs/Heads.md">User guide</a>
  · <a href="CHANGELOG.md">Changelog</a>
  · <a href="docs/THREAT_MODEL.md">Security</a>
</p>

## What it is

Hydra is a full desktop code editor with an agent manager built in. You chat with one agent, Claude Code or Codex, in its official extension. That chat is the **lead**. When a task splits into independent pieces, the lead **grows heads**: separate agents, each in its own git worktree and branch, working at the same time. You don't have to ask; the lead decides when splitting is worth it.

Before a head's work counts as done, Hydra runs your project's **gates**: your own commands, screenshots of your app, and a read-only review by the *other* agent. No agent grades its own work. The lead then reviews and merges it, and you can open any diff yourself.

Bigger jobs become **plans**: jobs with dependencies that land one at a time on an integration branch and are checked together before anything reaches your branch. When you'd rather drive an agent yourself, open a **lane**: a real Claude Code or Codex terminal in its own worktree.

**Who it's for:** developers who already use Claude Code or Codex and want several agents working on one repository at once, isolated from each other, with checks they didn't write themselves.

### Hydra IDE or the Hydra app

Hydra comes two ways. Both run the same heads, plans, gates and lanes, and can be installed side by side.

- **Hydra IDE** is the full code editor described above, built on VS Code. Choose it if you want to edit code yourself in the same window. Its installer is `HydraSetup.exe`.
- **Hydra** (the app) is a lighter desktop app built around the chat: you chat with Claude Code or Codex directly, and Hydra's heads, plans, the Agents view and lanes are around it, without an editor. It's new in 0.28.0 and ships in every release as `HydraAppSetup.exe`, next to `HydraSetup.exe`. See the [app guide](docs/App.md).

A repository is driven by one of them at a time: whichever opens it first owns it, and the other runs no heads or plans there until it's closed in the first.

## Install

Windows 10 or 11, x64. Either:

- **Download** [`HydraAppSetup.exe`](https://github.com/ndunl075/hydra/releases/latest/download/HydraAppSetup.exe) for the Hydra app, or [`HydraSetup.exe`](https://github.com/ndunl075/hydra/releases/latest/download/HydraSetup.exe) for Hydra IDE, and run it, or
- **In PowerShell:**

  ```powershell
  irm https://www.usefrontierdigital.com/hydra/install.ps1 | iex
  ```

  This installs Hydra IDE (the app takes the `HYDRA_INSTALL_APP` variable below). It runs [`scripts/install.ps1`](scripts/install.ps1), which downloads the latest release, checks it against the release's `SHA256SUMS`, and installs it for your user only, with no admin prompt.

The installer isn't code-signed yet, so Windows SmartScreen may warn: choose **More info → Run anyway**. To check a download yourself, see [Checking an installer](docs/Releases.md#checking-an-installer).

`HydraSetup.exe` installs as **Hydra IDE**, the name on its Start Menu entry and desktop shortcut. Installed copies offer each new release in-app. Updating and uninstalling are covered in [Releases](docs/Releases.md#updating).

**The Hydra app:** `HydraAppSetup.exe` (app previews between releases are tagged `v<version>-app.<n>` on the [releases page](https://github.com/ndunl075/hydra/releases)), or run the same one-liner after `$env:HYDRA_INSTALL_APP = '1'` (and `Remove-Item Env:HYDRA_INSTALL_APP` after, so a later one-liner in that window installs Hydra IDE again). It installs as **Hydra**, also per user with no admin prompt, into its own folder. Its [updates](docs/App.md#updates) and [uninstalling](docs/App.md#uninstalling) are in the app guide.

### Requirements

- [Git](https://git-scm.com/).
- The [Claude Code](https://code.claude.com/docs/en/setup) and/or [Codex](https://developers.openai.com/codex/cli) CLI, installed and **signed in** with your own account. Hydra runs your CLIs as they are: it never asks for an API key, and never reads or copies their credentials.
- **Claude Code only?** A Claude Code head's shell (running tests and builds) uses Codex's Windows sandbox, so on Windows it needs the Codex CLI installed too. Without Codex, Claude Code heads still edit code and Hydra's gates still run your tests, but the heads can't run commands themselves; Hydra warns you the first time one starts that way.
- **One agent only?** A head's review gate is done by the other agent. With only one installed, the same agent reviews its own work, and the head's status says so.

## A short tour

1. **Open Hydra IDE.** On the first run it connects whichever of Claude Code and Codex it finds, installs their extensions, and opens a short setup. You can also connect them in **Hydra Settings → Connectors**.
2. **Open a git repository** (File → Open Folder) and trust it.
3. **Give the lead a task** in the Claude Code or Codex chat, one with independent parts. It starts heads, or a plan, when that's worth it.
4. **Watch them in the Agent Manager.** Press **Alt+Shift+A**, or use the **Agent Manager / Editor** switch in the title bar. Each head shows what it's doing, its gate results and one plain status: *Passed required gates*, *Some gates not run*, *No gates configured* or *Human override*.
5. **Review and merge.** The lead reviews each head's work and merges it. A plan offers **Merge plan** or **Open PR** only once its combined work has passed. The first time, Hydra offers a starter test gate for your project (when `package.json` has a `test` script; otherwise it points you to **Settings → Gates**).

New to it? **Hydra: Learn Heads, Lanes, Plans and Gates** opens a short walkthrough.

## What's inside

- **Heads:** parallel agents that grow out of one chat, each confined to its own worktree, and checked before they're accepted. [Heads →](docs/Heads.md)
- **Plans:** jobs with dependencies, from the chat or drafted on the canvas, run as heads or as lanes you drive. They keep going when one job fails, land on an integration branch, and pass an integration gate before you merge. Plans can also run unattended with a budget and leave a report. [Plans →](docs/Heads.md#plans)
- **Lanes:** agents you drive yourself, in a grid of real terminals, with merge, update, PR and a per-lane **Preview app** of your dev server. [Lanes →](docs/Heads.md#lanes)
- **Gates and reviews:** your commands, screenshots of your app, and a read-only review by the other agent, with the evidence one click away. [Gates →](docs/Heads.md#gates)
- **Packs:** roles, gates, MCP servers and skills for one kind of work (Coding and Research ship built in), turned on per project after you review them. [Packs →](docs/Heads.md#packs)
- **Usage-limit handoff:** when one agent hits its limit, continue in the other in the same worktree. [More →](docs/Heads.md#when-a-provider-hits-its-limit)
- **Control:** **Stop All Agents**, an audit log of every denial, approval and stop, and **Show All Projects** across your Hydra windows.
- **Scripts and CI:** the `hydra` command runs and waits on plans from a script, and plans can live in the repository as `.hydra/plans/*.json`. [The `hydra` command →](docs/Heads.md#the-hydra-command)
- **A full editor:** settings, keybindings and snippets can be imported from another editor, with Hydra Dark and Light themes. [Editor features →](docs/Features.md)

## Security

Heads run confined: they can't write outside their worktree, they get a trimmed environment, and they run with your sign-in only, without your personal plugins, hooks or MCP servers. Reviews are fenced as data, secrets are redacted from logs and evidence, and Hydra's local endpoint is loopback-only with a token per caller. The [threat model](docs/THREAT_MODEL.md) lists every control with the code and test that back it, and the risks accepted today. To report a problem privately, see [SECURITY.md](SECURITY.md).

## Docs

- [User guide](docs/Heads.md): heads, lanes, plans, gates, packs, the `hydra` command and troubleshooting.
- [The Hydra app](docs/App.md): installing, chats, Hydra in the app, updates, your data, and using it beside Hydra IDE.
- [Editor features](docs/Features.md): modes, Hydra Settings, appearance, settings import and provider checks.
- [Releases](docs/Releases.md): installing, updating, uninstalling, and how a release is built and checked.
- [Threat model](docs/THREAT_MODEL.md) and [security policy](SECURITY.md).
- [Benchmark](docs/Benchmark.md): how we benchmark Hydra's plans against one agent working alone.
- [Building from source](docs/Standalone_Build.md) and [contributing](CONTRIBUTING.md).

## Status

Hydra is early and moving fast. It's Windows-only for now and its installers aren't code-signed. Each release's changes are in the [changelog](CHANGELOG.md). Bug reports and ideas are welcome in [issues](https://github.com/ndunl075/hydra/issues).

## License

Hydra is released under the [MIT License](LICENSE). It builds on an MIT-licensed open-source editor and bundles third-party icons and fonts; their licence notices ship with the app.

# The Hydra app

**Hydra** is a desktop app for working with Claude Code and Codex. You chat with either one directly, and Hydra's heads, plans, gates and lanes work around that chat, as they do in the editor, without an editor around them. The editor is **Hydra IDE** ([user guide](Heads.md)). Both can be installed side by side.

The app is new in 0.28.0. It ships in every Hydra release as `HydraAppSetup.exe`, next to Hydra IDE's `HydraSetup.exe`; between releases, previews are tagged `v<version>-app.<n>`.

## Installing

Windows 10 or 11, x64, with [Git](https://git-scm.com/) and the [Claude Code](https://code.claude.com/docs/en/setup) and/or [Codex](https://developers.openai.com/codex/cli) CLI installed and signed in with your own account.

- **Download** [`HydraAppSetup.exe`](https://github.com/ndunl075/hydra/releases/latest/download/HydraAppSetup.exe) from the latest release on the [releases page](https://github.com/ndunl075/hydra/releases). App previews are tagged `v<version>-app.<n>`. Or:
- **In PowerShell:**

  ```powershell
  $env:HYDRA_INSTALL_APP = '1'; irm https://www.usefrontierdigital.com/hydra/install.ps1 | iex; Remove-Item Env:HYDRA_INSTALL_APP
  ```

  This installs the app from the latest full release, checked against its `SHA256SUMS-app` ([Installing](Releases.md#installing)). It doesn't install previews.

It installs for your user only, with no admin prompt, into `%LOCALAPPDATA%\Programs\Hydra App`, with a **Hydra** Start Menu entry (and a desktop shortcut if you choose one). The installer isn't code-signed yet, so Windows SmartScreen may warn: choose **More info → Run anyway**. To check a download, compare `Get-FileHash .\HydraAppSetup.exe -Algorithm SHA256` with the release's `SHA256SUMS-app`, and run `gh attestation verify HydraAppSetup.exe --repo ndunl075/hydra`.

## First run

- **Setup** checks that `claude` and `codex` are found and signed in, and offers each CLI's own sign-in when one isn't. Hydra never asks for an API key and never reads or copies your CLIs' credentials. Choose a different program for either in **Settings → Command-line tools**.
- **Open a project** (a folder) or **Clone a repo**. Before chats run in a folder, Hydra asks you to **trust** it: a chat runs Claude Code or Codex with the project's own settings, so its hooks, MCP servers and commands run on your computer with your permissions.
- **New chat** starts a chat with Claude Code or Codex in that project. Chats are saved and reopen where you left them. A chat gets a short name after its first message: Claude names a Claude chat, and Codex names a Codex chat on your own Codex login (one small `codex exec`), so a message goes only to the provider the chat already uses.
- **The branch bar** above the prompt shows the folder's repository and branch and the lines the branch changed against its default branch. **Create PR** (on a branch with a remote and something to propose) asks the chat's agent to commit, push and open the pull request with `gh`; the chat's pull request bar then takes over, with its CI.
- **The permission mode:** if Claude Code reports a different mode than the one you chose (Manual where Auto isn't offered on Haiku), a note under the prompt says so.

## Hydra in the app

Once a project has a chat, Hydra runs for it, as it does in an IDE window:

- **Heads and plans:** the chat can start heads and plans with Hydra's lead tools; each shows as a card in the chat and on the **Agents** view, with its gates, review and evidence. **Merge plan** and **Open PR** work as in the IDE.
- **Lanes:** a real Claude Code or Codex terminal in its own worktree, with **Diff**, **Merge**, **Run gates**, **Preview app** and **Open PR**.
- **Stop all** and **Resume**, and the audit log, from the Agents view.
- **Hydra Settings** (packs, gates, providers and the rest) opens in its own window. **Settings → Connectors** connects Hydra's tools to Claude Code and Codex.

The [user guide](Heads.md) covers heads, plans, gates, packs and lanes in detail; they behave the same here.

## Cloud chats

A Claude Code chat can run on claude.ai instead of your computer. Before its first message, set **Where** in the composer to **Cloud**; the first message then starts a Claude Code cloud session for the project, and the chat shows its title with **Open on claude.ai** and **Continue here**.

- **What goes up:** the folder's tracked files as they are on disk, uncommitted edits included. Untracked and ignored files stay on your computer. The project doesn't need a GitHub remote.
- **While it runs**, Claude Code doesn't report progress back to Hydra: follow it on claude.ai.
- **Continue here** opens the session's conversation in a terminal (`claude --teleport`), in a fresh worktree of the project on a new `hydra/cloud-…` branch. The cloud session's file changes stay in the cloud: its copy has no git remote to push to. Removing the chat leaves that worktree and branch for you to delete.
- It uses your Claude Code sign-in and plan, as `claude --cloud` does in a terminal. Codex chats run locally only for now.

## Updates

An installed **stable** app checks for a new release 30 seconds after it starts and then once a day, and offers **Update**, **Release notes**, **Skip this version** or **Later**. Update downloads `HydraAppSetup.exe`, checks it against the release's `SHA256SUMS-app`, and asks once more; Hydra then closes, installs the update into the same folder and reopens. Nothing is downloaded or installed without those clicks. **Settings → Updates** has **Check for updates** and turns the daily check off.

A **preview** never updates itself: install the next preview over it by hand, or the next release. A preview's **Settings → Updates** says so.

## Your data

- **The app's own data** (settings, chats, the window's state) is in `%APPDATA%\Hydra App`.
- **Hydra's storage** for heads, plans, ownership and discovery is shared with Hydra IDE: `%APPDATA%\Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager`.
- The app never touches Hydra IDE's own settings, extensions or profile.
- Uninstalling **Hydra IDE** and choosing to remove its data removes all of `%APPDATA%\Hydra`, the shared storage included, even while the app is installed. To keep the app's heads and plans, uninstall the IDE without removing its data.

## Using it beside Hydra IDE

The two install into separate folders, under separate names and registrations, with separate shortcuts; installing, updating or uninstalling one never touches the other's. They share Hydra's storage, so either one sees the heads and plans the other started.

A repository is driven by one of them at a time. Whichever opens it first owns it, and the other runs no heads or plans there: the app says Hydra IDE manages the project, and the IDE says the workspace is already managed in another window. Close it in the owner, then reopen the project in the app, or reload the IDE's window. The `hydra` command and Claude Code's or Codex's `hydra` tools reach whichever one owns the folder.

## Uninstalling

Uninstall **Hydra** from **Windows Settings → Apps → Installed apps**, or run `unins000.exe` in its install folder. Close Hydra first, and any Claude Code or Codex chat using Hydra's tools: the uninstaller refuses while the app's program is in use.

- It removes what this install wrote into Claude Code's and Codex's settings (its `hydra` MCP entry and related settings), and leaves anything another Hydra wrote.
- It asks whether to also remove Hydra's settings and chat history (default No). A silent uninstall removes them only with `/HYDRAREMOVEDATA`. That removes `%APPDATA%\Hydra App`, and the shared Hydra storage only when Hydra IDE isn't installed. Your projects and your Claude and Codex sign-ins are never touched.

## Troubleshooting

- **"Close Hydra … then run setup again":** the app, or a chat using Hydra's tools in Claude Code or Codex, is still running from the install folder. Close them and try again.
- **"The destination already exists without a matching Hydra installation record":** a folder is left where the app would install. Remove it, or choose another folder.
- **An update didn't install:** the helper's log is `%TEMP%\hydra-app-update.log`.
- **Uninstall cleanup:** what it removed is in `%TEMP%\hydra-uninstall.log`.

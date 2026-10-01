# Hydra's editor, in detail

The [README](../README.md) covers what Hydra is and how to start. This page lists the editor's own features. The agent features (heads, lanes, plans, gates, packs) are in the [user guide](Heads.md).

## Agent Manager and Editor

- **Switching:** press **Alt+Shift+A**, click the **Agent Manager / Editor** switch in the title bar, or use the status bar item. **Hydra: Switch Agent Manager / Editor** is in the Command Palette too.
- **The Agent Manager** takes the whole window: a live canvas of heads, plans and lanes. It's blank until a Claude Code or Codex chat starts heads, which grow out of that chat, show what they're working on and how they depend on each other, and leave once merged. See [the Agents view](Heads.md#the-agents-view).
- **The Editor** keeps files and diffs in the center, the Explorer on the left, terminals below, and the official Claude Code and Codex chats in the side bar on the right. The button next to the switch shows or hides that side bar (**Ctrl+Alt+B**).
- **Switching back** restores the Editor exactly as you left it, including diffs and split groups. Mode switches keep side bar choices and terminal processes.
- **The Hydra icon** in the activity bar lists lanes, heads and plans.
- **Hydra's notifications** show as Hydra-styled cards in the bottom-right corner. See [Hydra's notifications](Heads.md#hydras-notifications).

## Hydra Settings

**Hydra Settings** opens as a tab: a left nav with search, and pages of cards. Open it from the top of the title bar's gear menu, **Hydra: Open Settings**, or `Ctrl+Shift+,`. Its pages:

- **General:** editor settings and keyboard shortcuts, importing preferences from another editor, resetting dismissed prompts, **Chat location** (docked in the side bar, or as tabs), and the startup **Window layout** (Editor or Agents).
- **Connectors:** connect Claude Code and Codex to Hydra and see exactly what Hydra wrote to their user settings. The Claude row also has the optional, off-by-default claude-mem memory plugin (`hydra.claudeMem.enabled`), with a **Repair** button once it's on. See [Connecting Claude Code and Codex](Heads.md#connecting-claude-code-and-codex).
- **MCP servers:** list, add, test and remove your user-level MCP servers for Claude Code, Codex or both. Hydra keeps no copy of secrets, and never edits Codex servers it didn't add.
- **Heads:** heads at a time, default caps (minutes, turns, budget), and **Stop all heads**.
- **Gates** and **Packs:** see [Gates](Heads.md#gates) and [Packs](Heads.md#packs).
- **Appearance** (Dark or Light, icon theme) and **Docs**.

## Appearance

- **Themes:** fresh profiles start in **Hydra Dark**, without following the system's light theme. **Hydra Light** is in **Hydra Settings → Appearance**, the Agents view's settings control, and the theme picker.
- **Your choice wins:** opening Hydra never changes your theme. An explicit choice updates your user profile and turns off automatic dark/light switching; workspace overrides are kept, with an explanation.
- **Icons:** a file icon theme is bundled and on by default, sidebar file icons are drawn at 14px, and UI icons use the classic codicon designs.
- **The logo:** the empty editor shows a subtle, one-color Hydra mark that follows dark, light and high-contrast themes. The title bar's app icon is the Hydra logo.
- **Chat panels stay put:** the Claude Code and Codex chat panels can't be dragged into the editor, the Explorer or the panel, and other views can't be dropped into them. You can still reorder icons, or move a panel on purpose from its icon's right-click menu.
- **The editor's built-in chat** and inline suggestions are off by default (`chat.disableAIFeatures`); Hydra's agents are Claude Code and Codex.

## Importing preferences

**Hydra Settings → General → Import** previews settings, keybindings and snippets from another editor's user or profile folder, with a picker for custom folders.
- **Pick categories** before importing into the active Hydra profile.
- **Your current preferences win** on conflicts. Unavailable settings and themes, and credential preferences, are skipped.
- **Undo last import** restores the saved backup, unless newer edits would be overwritten.
- **Left alone:** the source profile, sign-in stores, extension binaries and conversations.

See [Settings import](Settings_Import.md).

## Provider usage limits

**Hydra: Provider Usage Limits** shows your account windows. Opening it is passive; refreshing is explicit and never submits a model turn. Missing fields stay unavailable, observations are timestamped, and stale data is labelled. See [provider usage limits](Provider_Quotas.md).

## Provider and worktree settings

- **Finding the CLIs:** Hydra searches `PATH`. Set **Hydra: Claude Path** or **Hydra: Codex Path** to an absolute path if needed (user settings only; a repository can't set them). A CLI being present doesn't prove it's signed in.
- **Where heads work:** heads run in sibling worktrees. **Hydra: Worktree Root** picks an absolute folder outside the repository, and **Hydra: Max Concurrent Helpers** caps how many heads run at once in a window. No secrets, ignored files or dependencies are copied. Worktrees isolate files and indexes; on their own they're not a security sandbox (see the [threat model](THREAT_MODEL.md) for what confines heads).
- **One window per repository:** one Hydra window owns each repository at a time. A second one shows an error and doesn't start heads.

## Provider checks

**Hydra: Check Default Provider Capabilities** inspects the configured CLI's version and public help. It's never triggered by startup, mode changes or refresh.
- **What it runs:** only `--version`, `--help` and, for Codex, `app-server --help`.
- **Limits:** eight seconds per call, and 256 KiB of output in all. A timeout, cancellation or excess output ends the probe's process tree.
- **Never sent:** a prompt, a sign-in or a model request.
- **What it can't show:** a recognised version or option doesn't prove sign-in, billing, streaming or resume support.

## Handoff workspaces

A Hydra handoff workspace is a generated `.code-workspace` that opens one exact worktree. It shows Hydra's handoff instructions without launching a provider or submitting a prompt: **Open Claude Code** or **Open Codex** opens that extension's chat, and **Copy task prompt** copies the task for you to paste. The official extension owns sign-in, the conversation, permissions and history. A missing or disabled extension shows an install search. Hydra can't observe or stop that conversation, and no transcript is copied.

# Security policy

## Reporting a vulnerability

Please report security problems privately. Don't open a public issue.

Use GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**, or [open a report directly](https://github.com/ndunl075/hydra/security/advisories/new). Only the maintainers can see it, and the fix is coordinated in a private security advisory.

Include:
- what an attacker could do, and what they need first (for example a malicious repository, a pack, or another local process);
- the Hydra version (**Help → About**) and Windows version;
- steps to reproduce, or a proof of concept.

Once a fix ships, the advisory is published and you're credited in it, unless you'd rather not be.

## Supported versions

Only the [latest release](https://github.com/ndunl075/hydra/releases/latest) gets security fixes. Installed copies offer each new release in-app; see [Updating](docs/Releases.md#updating).

## What's in scope

Hydra runs AI agents on your code, so the most useful reports cross one of the boundaries the [threat model](docs/THREAT_MODEL.md) describes:
- a head writing outside its worktree, or escaping its sandbox;
- a head or lane calling Hydra actions it shouldn't, or reaching another window's endpoint;
- a head or reviewer reaching your personal MCP servers, plugins or hooks;
- a gate's floor being lowered, or its evidence being forged;
- secrets reaching logs, evidence or another agent;
- a download or update installed without its checks.

The threat model also lists the risks Hydra accepts today. A report that one of those is exploitable in a way the threat model doesn't describe is still welcome.

Out of scope:
- problems in Claude Code, Codex or the upstream editor themselves (report those to their owners);
- attacks that need an administrator account on your machine.

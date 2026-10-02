# Contributing to Hydra

Thanks for helping. Bug reports and ideas go in [issues](https://github.com/ndunl075/hydra/issues). Security problems don't: see [SECURITY.md](SECURITY.md).

## How the code is laid out

- `src/`: Hydra's built-in extension. `src/core/` holds the logic (heads, lanes, plans, gates, packs, worktrees), kept free of editor APIs where it can be, so it's testable in plain Node.
- `src/host/`: the `Host` interface, everything the controller needs from the program it runs in, so the IDE and the Hydra app share one controller ([G2](docs/internal/hydra-app/G2-host-split.md)). `src/host/controller.ts` is the controller itself (the Agents view's state and messages, plans and the plan runner); `src/vscodeHost.ts` is the IDE's `Host`, and `src/extension.ts` forwards to the controller. Nothing under `src/core/` or `src/host/` imports `vscode` or `electron`; `tests/hostBoundary.test.ts` enforces it.
- `webview/`: the Agent Manager canvas, the lanes grid and other webview UI.
- `desktop/` and `scripts/desktop.mjs`: the standalone editor build, from a pinned upstream commit (`desktop/upstream.json`), and its Windows installer.
- `packs/` and `schemas/`: the built-in packs, and the JSON schemas for `.hydra/` files.
- `tests/`: unit and integration tests (`npm test`), and the smoke suite (`tests/smoke.ts`, run by `scripts/smoke.mjs`).
- `bench/` and `scripts/benchmark*.mjs`: the [benchmark](docs/Benchmark.md) fixtures and harness.
- `docs/`: the user guide ([Heads.md](docs/Heads.md)), [editor features](docs/Features.md), [threat model](docs/THREAT_MODEL.md), [releases](docs/Releases.md) and build guides. `docs/internal/` holds design plans, acceptance notes and status records, kept for history.

## Setup

This needs Node.js 22 and Git.

```powershell
npm ci
npm run check       # type-check
npm run build
npm test            # heads, real-Git worktrees, storage, gates, plans, handoff
npm run test:smoke  # end to end in an Extension Development Host
```

- **Trying a change:** press **F5** in this repository to launch an Extension Development Host. `npm run package` makes a development `.vsix`; it isn't the product.
- **`npm test`** builds every `tests/*.test.ts` and runs them with Node's test runner. A test must never make worktrees of this repository; the run fails if one is left behind.
- **The smoke suite** downloads a test host where none is installed. Its provider checks use local stand-in executables that make no model requests, so it never needs a signed-in provider. Failed fixtures are kept under `.test-build` for diagnosis.
- **From a Claude Code terminal,** unset `ELECTRON_RUN_AS_NODE` before the smoke suite, or the host starts as plain Node.

## Building the desktop app

`Hydra.exe` is the product: the editor built from source with Hydra's extension built in. Native Windows x64 builds need the toolchain in the [build guide](docs/Standalone_Build.md).

```powershell
npm ci
npm run desktop:build
npm run desktop:verify
npm run desktop:smoke
npm run desktop:installer   # HydraSetup.exe; see docs/Windows_Installer.md
```

The build lands under `.desktop/`. Hydra changes the upstream editor only through `scripts/desktop.mjs`, never through a `patches/` folder. The script refuses to build when the pinned upstream changes shape, so don't move `desktop/upstream.json`'s commit in a feature change. The installer is described in [Windows_Installer.md](docs/Windows_Installer.md), and how a release is published in [Releases.md](docs/Releases.md).

## Pull requests

- **Branch from `main`** with a prefix for the kind of change: `feat/`, `fix/`, `docs/`, `test/`, `ci/`, `chore/` or `bench/`. Releases are their own `release/<version>` pull requests that only bump the version.
- **One change per pull request,** small enough to review in one sitting.
- **Title:** a plain sentence saying what changes for the user, for example "Show when a head is waiting on its provider".
- **Description:** what changes and why, with a short list of the pieces. Name the tests that cover it, and any threat-model control (`HSEC-…`) it adds or changes.
- **CI runs the full suite** on every push and pull request: `check`, `build`, `npm test`, `test:smoke` and `package` (the **Check** workflow). Changes to the extension, the desktop build or the tests also run the **Windows desktop** workflow: the standalone build, its smoke, and the installer's install, upgrade and uninstall tests. Locally, run the tests that cover your change; let CI run the rest.
- **Update the docs in the same pull request.** User-visible behaviour goes in [docs/Heads.md](docs/Heads.md) or [docs/Features.md](docs/Features.md). A new security control or surface goes in the [threat model](docs/THREAT_MODEL.md), with the test that proves it. A user-facing change gets a line in the next release's [changelog](CHANGELOG.md) entry.
- **Tests:** add or change tests with the code. Tests that need a real provider CLI or sign-in don't belong in `npm test`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

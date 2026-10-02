// src/core is host-agnostic, but a few of its signatures name VS Code's global Thenable, a PromiseLike. The IDE gets
// it from @types/vscode; the app declares the same shape so it can type-check the core files it bundles.
interface Thenable<T> extends PromiseLike<T> {}

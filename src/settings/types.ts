import type { ImportCategory } from '../core/profileImport';
import type { PackService } from '../core/packs/service';
import type { Host } from '../host/host';

/** One row's search text: title and description shown left of a row's control. */
export interface SettingsRow {
  title: string;
  description: string;
}

/** Settings import (src/extensionImport.ts's SettingsImport in the IDE): what Settings → General uses of it. */
export interface SettingsImports {
  readonly available: boolean;
  status(): Promise<{ available: boolean; interrupted: boolean }>;
  choose(provider: 'vscode' | 'cursor' | 'folder'): Promise<object | undefined>;
  apply(token: string, categories: ImportCategory[]): Promise<number>;
  undo(): Promise<void>;
}

/** Shared state a page's html/handle needs. Grows as later phases add pages. */
export interface SettingsContext {
  /** The program Hydra runs in (src/host/host.ts): settings, commands, dialogs, opening things. */
  host: Host;
  imports: SettingsImports;
  post(message: unknown): Thenable<boolean>;
  /**
   * Packs (docs/internal/Packs_Plan.md, section 4): the Packs page calls `turnOn`/`allow`
   * directly here, never through a public command — a command any extension could
   * call would let a repository allow a pack by itself. Every other page only
   * reads it (or not at all).
   */
  packs: PackService;
}

/**
 * One page of Hydra Settings. The shell (src/settings/shell.ts) renders every
 * page's html into its own hidden section, composes their scripts, indexes
 * their rows for search, and routes webview messages to handle() in nav order
 * until one returns true.
 */
export interface SettingsPage {
  id: string;
  title: string;
  /** Row titles/descriptions indexed for search; also shown as an empty-state hint. */
  rows: SettingsRow[];
  /** Inner HTML for this page's <section data-page="id">. No <html>/<body>/nonce wrapper. */
  html(ctx: SettingsContext): string;
  /** Client-side JS, concatenated into the shared <script>. Runs once at load. */
  script?: string;
  /** Called after the webview signals ready, to push this page's initial state. */
  onReady?(ctx: SettingsContext): Promise<void>;
  /** Handle one webview message. Returns true when this page owned it. */
  handle?(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean>;
}

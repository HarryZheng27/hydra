import type { Provider } from './model';

/**
 * What a fresh head's first prompt adds beyond its brief and its dependencies' work: the shape of
 * the repository it's starting in and the project's own test command (helperService.ts,
 * helperPrompt). Measured need: without either, a head spent its first several turns on `git
 * ls-files`, `cat package.json` and reading the same handful of files — a few minutes each, paid
 * by every head running at the same time. Everything here is a plain, capped summary computed
 * from data Hydra already has; never file contents, so it can't grow the prompt open-ended, and
 * always deterministic, so the same inputs always give the same text.
 */

/** At most this many paths listed one per line; past that, or past `repoListingMaxChars`, the listing collapses to top-level directories with a file count each. */
export const repoListingMaxFiles = 200;
/** At most this many characters for the plain, one-path-per-line listing (whichever of the two limits is hit first). */
export const repoListingMaxChars = 6000;
/** At most this many directory lines in the collapsed listing; past that, the rest share one "…and N more" line, so a repository with unusually many top-level directories still renders a bounded prompt. */
export const repoListingMaxDirLines = 60;

/** A control character, a backslash or a double quote: none of these may reach the prompt unescaped (git itself quotes a path like this when it prints one). */
const unsafeNameChars = /[\u0000-\u001f\u007f\\"]/;
/** `name`, or, if it has a control character, a backslash or a double quote in it, `name` JSON-escaped in double quotes — the same shape git quotes an unusual path in — so a repository-controlled file name can't inject a line (or a newline) into a head's prompt. */
function safeName(name: string): string { return unsafeNameChars.test(name) ? JSON.stringify(name) : name; }

/**
 * The repository's tracked files, for a head's first prompt's "Repository" section: every path
 * when there are few enough to be worth reading, else collapsed to its top-level directories with
 * a file count each — so a head sees the shape of a large repository without spending a turn on
 * `git ls-files` or `ls` for it. `files` need not be sorted; this sorts them itself, so the same
 * set of files always renders the same way regardless of the order they were read in. A path with
 * an unusual character in it (safeName) is quoted rather than printed raw.
 */
export function repositoryListing(files: readonly string[]): string {
  if (!files.length) return 'No tracked files yet.';
  const sorted = [...files].sort();
  const header = `${sorted.length} tracked file${sorted.length === 1 ? '' : 's'}`;
  const full = sorted.map(safeName).join('\n');
  if (sorted.length <= repoListingMaxFiles && full.length <= repoListingMaxChars) return `${header}:\n${full}`;
  const counts = new Map<string, number>();
  for (const file of sorted) {
    const slash = file.indexOf('/');
    const dir = slash < 0 ? '(repository root)' : `${safeName(file.slice(0, slash))}/`;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const all = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([dir, count]) => `${dir} (${count} file${count === 1 ? '' : 's'})`);
  const lines = all.length > repoListingMaxDirLines ? [...all.slice(0, repoListingMaxDirLines), `…and ${all.length - repoListingMaxDirLines} more directories`] : all;
  return `${header}, too many to list one by one — by top-level directory:\n${lines.join('\n')}`;
}

/**
 * package.json's own `scripts.test`, or undefined when there is none, `package.json` isn't valid
 * JSON, or `scripts` or `scripts.test` isn't there. Pure: takes the file's text, never reads it
 * itself, so it needs no fixture on disk to test.
 */
export function parsePackageTestScript(raw: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') return undefined;
  const test = (scripts as Record<string, unknown>).test;
  return typeof test === 'string' && test.trim() ? test.trim() : undefined;
}

/** What headWorkingGuidance needs to know about this particular head, to word its bullets truthfully. */
export interface HeadWorkingGuidanceOptions {
  /** Claude and Codex heads have different tools (a Codex head has no Read/Grep/Glob; it works through its own shell). */
  provider: Provider;
  /** A Claude head can have no shell at all (Step 2, design 1); Codex heads always keep their own sandbox. */
  shellOff: boolean;
  /** Whether the project's gates include a command gate (gateCommandsBrief): only then does "Hydra runs the full gates after hydra_done" actually cover testing. */
  hasCommandGate: boolean;
}

/**
 * Plain working guidance every head hears once, as bullets in helperPrompt's "How to work:" list
 * (helperService.ts), tailored to what this particular head actually has: a Codex head has no
 * Read/Grep/Glob tools (it works through its own shell, so only the batching advice applies to
 * it); a Claude head with no shell at all can't batch shell commands, so it hears to use
 * Read/Grep/Glob instead, not alongside a shell. "Run only the tests your change touches" is
 * true only when a command gate actually runs the rest after hydra_done — with none configured
 * (gateCommandsBrief's package.json fallback), telling a head to skip its own tests would leave
 * nothing testing the change at all, so that line is left out. A generous timeout always applies.
 */
export function headWorkingGuidance(options: HeadWorkingGuidanceOptions): string[] {
  const lines: string[] = [];
  if (options.shellOff) lines.push('Your shell is off: read files with Read, Grep or Glob instead of a shell command.');
  else if (options.provider === 'claude') lines.push('Shell commands start slowly here (each one is its own sandboxed process): batch them instead of running many small ones, and prefer Read, Grep or Glob to `cat`, `ls` or `find`.');
  else lines.push('Shell commands start slowly here (each one is its own sandboxed process): batch them instead of running many small ones.');
  if (options.hasCommandGate) lines.push('Run only the tests your change touches. Hydra runs the project\'s full gates after hydra_done.');
  lines.push('Give a slow test command a generous timeout rather than retrying it after it times out.');
  return lines;
}

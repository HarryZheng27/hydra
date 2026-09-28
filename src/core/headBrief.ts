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

/**
 * The repository's tracked files, for a head's first prompt's "Repository" section: every path
 * when there are few enough to be worth reading, else collapsed to its top-level directories with
 * a file count each — so a head sees the shape of a large repository without spending a turn on
 * `git ls-files` or `ls` for it. `files` need not be sorted; this sorts them itself, so the same
 * set of files always renders the same way regardless of the order they were read in.
 */
export function repositoryListing(files: readonly string[]): string {
  if (!files.length) return 'No tracked files yet.';
  const sorted = [...files].sort();
  const header = `${sorted.length} tracked file${sorted.length === 1 ? '' : 's'}`;
  const full = sorted.join('\n');
  if (sorted.length <= repoListingMaxFiles && full.length <= repoListingMaxChars) return `${header}:\n${full}`;
  const counts = new Map<string, number>();
  for (const file of sorted) {
    const slash = file.indexOf('/');
    const dir = slash < 0 ? '(repository root)' : `${file.slice(0, slash)}/`;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const lines = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([dir, count]) => `${dir} (${count} file${count === 1 ? '' : 's'})`);
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

/**
 * Plain working guidance every head hears once, as bullets in helperPrompt's "How to work:" list
 * (helperService.ts): shell commands here start slowly (each one is its own sandboxed process,
 * Step 2), so batching them and reading with Read/Grep/Glob instead of `cat`/`ls`/`find` saves a
 * head its own turns; running only the tests its change touches leaves the full gates (which run
 * after hydra_done anyway) to check the rest; and a generous timeout beats retrying a slow test
 * command that only needed more time.
 */
export const headWorkingGuidance: readonly string[] = [
  'Shell commands start slowly here (each one is its own sandboxed process): batch them instead of running many small ones, and prefer Read, Grep or Glob to `cat`, `ls` or `find`.',
  'Run only the tests your change touches. Hydra runs the project\'s full gates after hydra_done.',
  'Give a slow test command a generous timeout rather than retrying it after it times out.',
];

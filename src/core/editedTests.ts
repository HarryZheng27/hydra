import { git, readOnlyGitTimeoutMs } from './git';

/**
 * Edited tests are evidence (docs/internal/Needs_You_Plan.md, "Phase 3"): a head can change the tests that
 * grade it, so the files that existed at the base commit, look like tests and were changed or deleted are
 * listed on the result, in View evidence and in the review gate's prompt. A flag, never a gate. New test
 * files aren't flagged: adding tests is normal.
 */
export const defaultTestPatterns: readonly string[] = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];
export const maxTestPatterns = 20;
export const maxTestPatternLength = 200;

const regexSpecials = /[\\^$.|+()[\]{}]/g;

/** A glob as a regular expression over a slash-separated path: a double star crosses folders (and "**" plus a slash may match nothing), a single star and "?" stay inside one name. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(regexSpecials, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Whether a repository-relative path (either slash) matches one of the patterns. */
export function matchesTestPattern(file: string, patterns: readonly string[] = defaultTestPatterns): boolean {
  const normal = file.split('\\').join('/').replace(/^\.\//, '');
  return patterns.some(pattern => globToRegExp(pattern.split('\\').join('/')).test(normal));
}

/** The files `git diff --name-status -z` reports as modified, deleted or type-changed (never added) that match the patterns. */
export function parseEditedTests(nameStatus: string, patterns: readonly string[] = defaultTestPatterns): string[] {
  const parts = nameStatus.split('\0');
  const files: string[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index]!, file = parts[index + 1]!;
    if (/^[MDT]/.test(status) && file && matchesTestPattern(file, patterns) && !files.includes(file)) files.push(file);
  }
  return files.sort();
}

/**
 * The existing test files changed or deleted between `base` and `to` (or the working tree, without `to`).
 * Undefined when git can't say: the flag is best effort and never stops anything.
 */
export async function editedTests(cwd: string, base: string, options: { to?: string; patterns?: readonly string[]; environment?: NodeJS.ProcessEnv } = {}): Promise<string[] | undefined> {
  try {
    const output = await git(cwd, ['diff', '--name-status', '-z', '--no-renames', '--diff-filter=MDT', base, ...options.to ? [options.to] : [], '--'], options.environment, readOnlyGitTimeoutMs);
    return parseEditedTests(output, options.patterns ?? defaultTestPatterns);
  } catch { return undefined; }
}

const shown = 10, longest = 120;
/** The note for a result: "Changed existing tests: a, b (and 3 more)." Undefined for none. Short enough for a plan result's note. */
export function editedTestsNote(files: readonly string[] | undefined): string | undefined {
  if (!files?.length) return undefined;
  const names = files.slice(0, shown).map(file => file.length > longest ? `${file.slice(0, longest - 1)}…` : file);
  return `Changed existing tests: ${names.join(', ')}${files.length > shown ? ` (and ${files.length - shown} more)` : ''}.`;
}

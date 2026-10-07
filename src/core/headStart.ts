import { git, gitRun, readOnlyGitTimeoutMs } from './git';
import { redactText } from './redact';

/**
 * What a head starts from (docs/internal/Gates_Plan.md, section 3).
 *
 * A head that depends on others builds on what they did: its worktree starts
 * from its dependency's result commit, or, with several, from one commit Hydra
 * makes that merges them all. That merge is worked out with `git merge-tree`
 * before any worktree exists, so dependencies that conflict fail the head before
 * it starts, naming the files. The head's brief also says what each dependency
 * did.
 */
/**
 * What one dependency handed on. `kind` says who did the work: a head, or a lane
 * that runs a plan job (docs/internal/Plan_Lanes_Plan.md, "Starting a lane job"); for a
 * lane, `id` is the lane's id and `summary` its Mark job done note or commit subjects.
 */
export interface DependencyResult {
  id: string; kind: 'head' | 'lane'; title: string; summary: string; commit: string; branch?: string; changedFiles: string[];
  /** What it landed on the plan's integration branch, as a capped, redacted diff (dependencyDiff): the real code, so a dependent needn't re-read it. */
  diff?: string;
}
/** "heads" while every dependency is a head, as before lanes could run plan jobs; "jobs" once any is a lane. */
export const dependencyNoun = (dependencies: readonly Pick<DependencyResult, 'kind'>[]): 'heads' | 'jobs' => dependencies.some(dependency => dependency.kind === 'lane') ? 'jobs' : 'heads';

export const maxDependencyBrief = 4096;
/** The most diff text a dependent's brief carries, all its dependencies together. */
export const maxDependencyDiff = 24 * 1024;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
/** Hydra's own commits carry Hydra's name, whatever the repository's identity is. */
export const hydraIdentity: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Hydra', GIT_AUTHOR_EMAIL: 'heads@hydra.invalid',
  GIT_COMMITTER_NAME: 'Hydra', GIT_COMMITTER_EMAIL: 'heads@hydra.invalid',
};

/** Thrown when the dependencies can't be merged; the head fails with this message. */
export class DependencyConflict extends Error {
  constructor(readonly files: string[], noun: 'heads' | 'jobs' = 'heads') { super(`The ${noun} it depends on conflict in ${files.join(', ')}; merge them first.`); }
}

/** Two commits merged in memory: the tree, or the files that conflict. Never touches a worktree or the index. Also O3's integration queue (integration.ts). */
export async function mergeTrees(repository: string, a: string, b: string): Promise<{ tree: string } | { conflicts: string[] }> {
  // merge-tree writes loose objects but never touches the index or HEAD, so a timeout is safe here.
  const result = await gitRun(repository, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], undefined, readOnlyGitTimeoutMs);
  const [tree, ...files] = result.stdout.split('\0');
  if (result.code === 0 && tree && sha.test(tree)) return { tree };
  if (result.code === 1 && tree && sha.test(tree)) return { conflicts: [...new Set(files.filter(Boolean))] };
  throw new Error(result.stderr.trim() || `git merge-tree exited with ${result.code}.`);
}

/**
 * The commit a dependent head starts from. One dependency (or several where one
 * already contains the others): its result commit. Several: one commit made by
 * Hydra whose parents are all of them. Throws DependencyConflict when they
 * conflict.
 */
export async function dependencyBase(repository: string, title: string, dependencies: readonly DependencyResult[]): Promise<string> {
  const commits = [...new Set(dependencies.map(dependency => dependency.commit))];
  const noun = dependencyNoun(dependencies);
  if (!commits.length || commits.some(commit => !sha.test(commit))) throw new Error(`A ${noun === 'heads' ? 'head' : 'job'} it depends on has no result commit.`);
  // A commit another dependency already contains adds nothing.
  const tips: string[] = [];
  for (const commit of commits) {
    let contained = false;
    for (const other of commits) {
      if (other === commit) continue;
      if ((await gitRun(repository, ['merge-base', '--is-ancestor', commit, other])).code === 0) { contained = true; break; }
    }
    if (!contained) tips.push(commit);
  }
  if (tips.length === 1) return tips[0]!;
  let merged = tips[0]!, tree = '';
  for (const next of tips.slice(1)) {
    const result = await mergeTrees(repository, merged, next);
    if ('conflicts' in result) throw new DependencyConflict(result.conflicts, noun);
    tree = result.tree;
    // A stepping stone so the next merge finds the right merge base; only the final commit is kept.
    merged = (await git(repository, ['commit-tree', tree, '-p', merged, '-p', next, '-m', 'Hydra: merging dependencies'], hydraIdentity)).trim();
  }
  const titles = dependencies.filter(dependency => tips.includes(dependency.commit)).map(dependency => `- ${dependency.title} (${dependency.commit.slice(0, 12)})`);
  const message = `Hydra: merge the ${noun} "${title}" depends on\n\n${titles.join('\n')}`;
  return (await git(repository, ['commit-tree', tree, ...tips.flatMap(tip => ['-p', tip]), '-m', message], hydraIdentity)).trim();
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

/**
 * "What the heads you depend on did:" for the brief: each one's title, summary, branch and changed files, 4 KB in all.
 * It says "the jobs" once any of them is a lane (docs/internal/Plan_Lanes_Plan.md, "Heads that depend on a lane job").
 */
export function dependencyBrief(dependencies: readonly DependencyResult[]): string {
  const header = `What the ${dependencyNoun(dependencies)} you depend on did (your worktree already has their work):`;
  const share = Math.floor((maxDependencyBrief - header.length) / Math.max(1, dependencies.length)) - 1;
  const entries = dependencies.map(dependency => {
    const files = dependency.changedFiles.length > 20 ? `${dependency.changedFiles.slice(0, 20).join(', ')} and ${dependency.changedFiles.length - 20} more` : dependency.changedFiles.join(', ');
    return clip([
      `- ${dependency.title}${dependency.branch ? ` (branch ${dependency.branch}, commit ${dependency.commit.slice(0, 12)})` : ` (commit ${dependency.commit.slice(0, 12)})`}: ${dependency.summary.trim()}`,
      ...(files ? [`  Changed files: ${files}`] : []),
    ].join('\n'), share);
  });
  const summary = clip([header, ...entries].join('\n'), maxDependencyBrief);
  const diffs = dependencies.filter(dependency => dependency.diff?.trim());
  if (!diffs.length) return summary;
  const sections = diffs.map(dependency => `### ${dependency.title}\n\`\`\`diff\n${dependency.diff!.trim()}\n\`\`\``);
  return `${summary}\n\nThe code they landed (their diff; your worktree already has it, so read it here before opening the files):\n\n${clip(sections.join('\n\n'), maxDependencyDiff + 200 * diffs.length)}`;
}

/** A file's chunk of a diff reads as interface: an exported or declared name, or a file named for types or an index. */
const interfaceLine = /^\+\s*(export\b|module\.exports|exports\.|(?:abstract\s+)?(?:interface|type|class|enum)\s+\w|public\b|pub\s)/m;
const interfacePath = /(^|\/)(index|types?|api|interfaces?|schema|models?|contracts?)\.[a-z]+$|\.d\.ts$/i;
export const isInterfaceChunk = (file: string, chunk: string): boolean => interfacePath.test(file) || interfaceLine.test(chunk);

/**
 * A unified diff cut to `max` characters, whole files at a time: files that define what others call (exports,
 * types, an index) first, then the rest in path order, each file's chunk kept whole or left out. What was left
 * out is named, so the head knows to read those files itself. Secrets are redacted the way brief content is.
 */
export function capDiff(raw: string, max: number, redact: (text: string) => string = redactText): string {
  const chunks = raw.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith('diff --git '));
  const entries = chunks.map(chunk => ({ file: /^diff --git a\/(.+?) b\//.exec(chunk)?.[1] ?? chunk.split('\n', 1)[0]!, chunk: redact(chunk.replace(/\r?\n$/, '')) }));
  const first = entries.filter(entry => isInterfaceChunk(entry.file, entry.chunk)), rest = entries.filter(entry => !first.includes(entry));
  const kept: string[] = [], cut: string[] = [];
  let used = 0;
  for (const entry of [...first, ...rest]) {
    if (used + entry.chunk.length + 1 <= max) { kept.push(entry.chunk); used += entry.chunk.length + 1; } else cut.push(entry.file);
  }
  if (cut.length) kept.push(`# Cut to fit ${Math.round(max / 1024)} KB: ${cut.length} file${cut.length === 1 ? '' : 's'} not shown: ${cut.slice(0, 20).join(', ')}${cut.length > 20 ? `, and ${cut.length - 20} more` : ''}. Read them in your worktree.`);
  return kept.join('\n');
}

/**
 * What `to` changed from `from`, for a dependent's brief (capDiff, `max` characters). Git's own diff drivers are off
 * (a head can commit attributes that name one), so only git itself reads the files. Undefined when git can't say.
 */
export async function dependencyDiff(repository: string, from: string, to: string, max: number): Promise<string | undefined> {
  if (!sha.test(from) || !sha.test(to) || max <= 0) return undefined;
  const result = await gitRun(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', from, to, '--'], undefined, readOnlyGitTimeoutMs);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  return capDiff(result.stdout, max) || undefined;
}

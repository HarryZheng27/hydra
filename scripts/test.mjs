import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
const names=(await readdir('tests')).filter(name=>name.endsWith('.test.ts')).sort();
await build({ entryPoints: names.map(name=>'tests/'+name), bundle: true, platform: 'node', format: 'cjs', outdir: '.test-build', outExtension: { '.js': '.cjs' } });
// A test must never make worktrees of the repository it runs in (they pile up beside it as <folder>.worktrees):
// the run fails, naming any that appeared, and leaves them for a person to look at.
const worktrees = () => { const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }); return listed.status === 0 ? listed.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9)) : undefined; };
const before = worktrees();
const result = spawnSync(process.execPath, ['--test', ...names.map(name=>'.test-build/'+name.replace(/\.ts$/,'.cjs')), 'tests/desktop.test.mjs', 'tests/desktopInstalledInventory.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
const after = worktrees();
const leaked = before && after ? after.filter(item => !before.includes(item)) : [];
if (leaked.length) {
  console.error(`\nThe tests left ${leaked.length} worktree(s) of this repository behind:\n${leaked.map(item => `  ${item}`).join('\n')}\nA test is using this repository instead of a temporary one. Remove them with git worktree remove once you've found it.`);
  process.exitCode = 1;
}

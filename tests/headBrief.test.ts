import test from 'node:test';
import assert from 'node:assert/strict';
import { headWorkingGuidance, parsePackageTestScript, repoListingMaxChars, repoListingMaxFiles, repositoryListing } from '../src/core/headBrief';

test('repositoryListing: every path when there are few enough, sorted regardless of input order', () => {
  assert.equal(repositoryListing([]), 'No tracked files yet.');
  assert.equal(repositoryListing(['src/b.ts', 'src/a.ts', 'README.md']), '3 tracked files:\nREADME.md\nsrc/a.ts\nsrc/b.ts');
  assert.equal(repositoryListing(['one.ts']), '1 tracked file:\none.ts');
});

test('repositoryListing: past repoListingMaxFiles, it collapses to top-level directories with a file count each', () => {
  const files = Array.from({ length: repoListingMaxFiles + 1 }, (_, index) => `src/file${index}.ts`);
  const listing = repositoryListing(files);
  assert.match(listing, /^\d+ tracked files, too many to list one by one — by top-level directory:\nsrc\/ \(\d+ files\)$/);
  assert.equal(listing, `${files.length} tracked files, too many to list one by one — by top-level directory:\nsrc/ (${files.length} files)`);
});

test('repositoryListing: past repoListingMaxChars with few files, it also collapses (one long path can\'t blow the budget open)', () => {
  const longPath = `deep/${'segment/'.repeat(800)}file.ts`;
  assert.ok(longPath.length > repoListingMaxChars);
  const listing = repositoryListing([longPath, 'README.md']);
  assert.match(listing, /too many to list one by one — by top-level directory:/);
  assert.match(listing, /deep\/ \(1 file\)/);
  assert.match(listing, /\(repository root\) \(1 file\)/);
});

test('repositoryListing: directories are grouped and sorted, root files under "(repository root)", one file each still says "file" not "files"', () => {
  const listing = repositoryListing(Array.from({ length: repoListingMaxFiles + 1 }, (_, index) => index === 0 ? 'root.md' : `dir${index % 3}/f${index}.ts`));
  const lines = listing.split('\n');
  assert.equal(lines[0], `${repoListingMaxFiles + 1} tracked files, too many to list one by one — by top-level directory:`);
  assert.deepEqual([...lines.slice(1)].sort(), [...lines.slice(1)], 'directory lines are already sorted');
  assert.ok(lines.some(line => line.startsWith('(repository root) (1 file)')));
});

test('parsePackageTestScript: package.json\'s scripts.test, or undefined when there is none', () => {
  assert.equal(parsePackageTestScript(JSON.stringify({ scripts: { test: 'node --test' } })), 'node --test');
  assert.equal(parsePackageTestScript(JSON.stringify({ scripts: { test: '  npm run jest  ' } })), 'npm run jest');
  assert.equal(parsePackageTestScript(JSON.stringify({ scripts: { build: 'tsc' } })), undefined, 'no test script');
  assert.equal(parsePackageTestScript(JSON.stringify({ scripts: { test: '' } })), undefined, 'a blank script is the same as none');
  assert.equal(parsePackageTestScript(JSON.stringify({})), undefined, 'no scripts at all');
  assert.equal(parsePackageTestScript(JSON.stringify({ scripts: { test: 7 } })), undefined, 'not a string');
  assert.equal(parsePackageTestScript('not json'), undefined);
  assert.equal(parsePackageTestScript('[]'), undefined, 'not an object');
});

test('headWorkingGuidance: a few short, plain lines about shells, running fewer tests, and timeouts', () => {
  assert.ok(headWorkingGuidance.length >= 2 && headWorkingGuidance.length <= 5);
  for (const line of headWorkingGuidance) assert.ok(line.length < 260, line);
  assert.ok(headWorkingGuidance.some(line => /Read|Grep|Glob/.test(line)));
  assert.ok(headWorkingGuidance.some(line => /hydra_done/.test(line)));
  assert.ok(headWorkingGuidance.some(line => /timeout/i.test(line)));
});

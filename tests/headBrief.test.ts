import test from 'node:test';
import assert from 'node:assert/strict';
import { headWorkingGuidance, parsePackageTestScript, repoListingMaxChars, repoListingMaxDirLines, repoListingMaxFiles, repositoryListing } from '../src/core/headBrief';

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

test('repositoryListing: past repoListingMaxDirLines, the rest of the directories share one "…and N more" line', () => {
  // 70 top-level directories, 3 files each: 210 files, past repoListingMaxFiles, so this collapses; 70 directory lines is past repoListingMaxDirLines.
  const files = Array.from({ length: 70 }, (_, dir) => Array.from({ length: 3 }, (_, file) => `dir${String(dir).padStart(2, '0')}/f${file}.ts`)).flat();
  const listing = repositoryListing(files);
  const lines = listing.split('\n');
  assert.equal(lines.length, 1 + repoListingMaxDirLines + 1, 'the header line, the capped directory lines, and one "more" line');
  for (const line of lines.slice(1, 1 + repoListingMaxDirLines)) assert.match(line, /^dir\d\d\/ \(3 files\)$/);
  assert.equal(lines.at(-1), '…and 10 more directories');
});

test('repositoryListing: a file name with a control character, a backslash or a double quote is quoted rather than printed raw, so it can\'t forge a prompt line', () => {
  assert.equal(repositoryListing(['normal.ts', 'weird\nname.ts']), '2 tracked files:\nnormal.ts\n"weird\\nname.ts"', 'sorted on the raw name ("n" < "w"), rendered with the newline escaped');
  assert.equal(repositoryListing(['a\\b.ts']), '1 tracked file:\n"a\\\\b.ts"');
  assert.equal(repositoryListing(['a"b.ts']), '1 tracked file:\n"a\\"b.ts"');
  assert.equal(repositoryListing(['tab\ttab.ts']), '1 tracked file:\n"tab\\ttab.ts"');
  // A directory name with an unsafe character is quoted too, in the collapsed listing.
  const files = Array.from({ length: repoListingMaxFiles + 1 }, (_, index) => `weird\nDir/f${index}.ts`);
  const listing = repositoryListing(files);
  assert.match(listing, /^"weird\\nDir"\/ \(\d+ files\)$/m);
  assert.doesNotMatch(listing, /\nweird\n/, 'the raw newline never reaches the rendered text outside its own escaped line');
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

test('headWorkingGuidance: a Claude head with a shell hears to batch shell commands and prefer Read/Grep/Glob', () => {
  const lines = headWorkingGuidance({ provider: 'claude', shellOff: false, hasCommandGate: true });
  assert.ok(lines.length >= 2 && lines.length <= 5);
  for (const line of lines) assert.ok(line.length < 260, line);
  assert.ok(lines.some(line => /batch them/.test(line) && /Read, Grep or Glob/.test(line)));
  assert.ok(lines.some(line => /hydra_done/.test(line)));
  assert.ok(lines.some(line => /timeout/i.test(line)));
});

test('headWorkingGuidance: a Claude head with a shell hears the command shapes its read block makes Claude Code deny, and to retry simpler', () => {
  // Measured: with blockReadsOutsideWorkingDirectories on, `cd <worktree> && … 2>&1 | tail`, `for` loops and
  // redirects to /tmp or "$TMPDIR/…" are denied under dontAsk; the same commands without `cd`, piped to tail, run.
  for (const hasCommandGate of [true, false]) {
    const text = headWorkingGuidance({ provider: 'claude', shellOff: false, hasCommandGate }).join('\n');
    assert.match(text, /already starts in your worktree: never `cd` into it/);
    assert.match(text, /`cd` with any redirect \(even `2>&1`\)/);
    assert.match(text, /`for`\/`while` loops/);
    assert.match(text, /`\/tmp` or `\$VAR` paths/);
    assert.match(text, /pipe output to `tail`/);
    assert.match(text, /If a shell command is denied, run it again in a simpler shape.*don't give up on the shell/);
  }
});

test('headWorkingGuidance: a Codex head has no Read/Grep/Glob tools, so only the batching advice applies to it', () => {
  const lines = headWorkingGuidance({ provider: 'codex', shellOff: false, hasCommandGate: true });
  assert.ok(lines.some(line => /batch them/.test(line)));
  assert.ok(!lines.some(line => /Read, Grep or Glob/.test(line)), 'Codex has no such tools');
  assert.ok(!lines.some(line => /`cd`|denied/.test(line)), 'Claude Code\'s shell checks don\'t apply to Codex');
});

test('headWorkingGuidance: a Claude head with no shell hears to use Read/Grep/Glob instead, not to batch a shell it doesn\'t have', () => {
  const lines = headWorkingGuidance({ provider: 'claude', shellOff: true, hasCommandGate: true });
  assert.ok(lines.some(line => /Read, Grep or Glob/.test(line)));
  assert.ok(!lines.some(line => /batch them/.test(line)), 'nothing to batch with no shell');
  assert.ok(!lines.some(line => /`cd`|simpler shape/.test(line)), 'no shell command shapes with no shell');
});

test('headWorkingGuidance: "run only the tests your change touches" only when a command gate actually runs the rest', () => {
  assert.ok(headWorkingGuidance({ provider: 'claude', shellOff: false, hasCommandGate: true }).some(line => /Run only the tests your change touches/.test(line)));
  assert.ok(!headWorkingGuidance({ provider: 'claude', shellOff: false, hasCommandGate: false }).some(line => /Run only the tests your change touches/.test(line)), 'nothing else would test the rest');
  // The timeout advice always applies, regardless of whether there's a command gate.
  assert.ok(headWorkingGuidance({ provider: 'claude', shellOff: false, hasCommandGate: false }).some(line => /timeout/i.test(line)));
});

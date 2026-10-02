// Builds every tests/*.test.ts and runs them with Node's test runner, as the root package does.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(appDir, '.test-build');
const names = (await readdir(path.join(appDir, 'tests'))).filter(name => name.endsWith('.test.ts')).sort();
await rm(out, { recursive: true, force: true });
await build({ entryPoints: names.map(name => path.join(appDir, 'tests', name)), bundle: true, platform: 'node', format: 'cjs', target: 'node22', outdir: out, outExtension: { '.js': '.cjs' }, external: ['electron'], define: { HYDRA_APP_VERSION: '"0.0.0-test"' }, logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...names.map(name => path.join(out, name.replace(/\.ts$/, '.cjs')))], { stdio: 'inherit', cwd: appDir });
process.exitCode = result.status ?? 1;

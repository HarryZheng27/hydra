import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupInstall, findClaudeCli } from './core/uninstallCleanup';

/**
 * dist/hydra-uninstall.cjs: the Windows uninstaller runs this with Hydra's own
 * executable as Node (desktop/hydra-uninstall.iss) before removing Hydra's files:
 *
 *   Hydra.exe <ext>\dist\hydra-uninstall.cjs --app <install folder> [--dry-run]
 *
 * It must never hold up or fail an uninstall: everything is logged to
 * %TEMP%\hydra-uninstall.log (paths and outcomes only, never environment
 * values), it always exits 0, and it stops itself after 20 seconds.
 */
const logFile = path.join(tmpdir(), 'hydra-uninstall.log');
const log = (line: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* logging is best effort */ } };
const finish = () => process.exit(0);

setTimeout(() => { log('stopped after 20 seconds'); finish(); }, 20_000);
process.on('uncaughtException', error => { log(`failed: ${error.message}`); finish(); });
process.on('unhandledRejection', error => { log(`failed: ${error instanceof Error ? error.message : String(error)}`); finish(); });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--app');
  const app = at >= 0 ? args[at + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  log(`uninstall cleanup${dryRun ? ' (dry run)' : ''} for ${app ?? '(no --app)'}`);
  if (!app) return;
  const claude = dryRun ? undefined : await findClaudeCli().catch(() => undefined);
  log(claude ? `Claude CLI: ${claude}` : 'no Claude CLI; ~/.claude.json is edited directly');
  const report = await cleanupInstall({ app, dryRun, claude, log });
  log(`done: ${JSON.stringify(report)}`);
}
main().catch(error => log(`failed: ${error instanceof Error ? error.message : String(error)}`)).finally(finish);

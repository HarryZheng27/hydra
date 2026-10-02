// `npm run dev`: starts the built app in Electron. Claude Code's shell sets ELECTRON_RUN_AS_NODE, which would start
// Electron as plain Node, so it is removed here.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron');
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', code => { process.exitCode = code ?? 1; });

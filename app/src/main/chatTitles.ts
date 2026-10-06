import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudEnvironment } from '../../../src/core/chat/cloud';
import { processLaunch, terminateProcessTree } from '../../../src/core/process';

/** What the agent is asked: Claude desktop's kind of name, in sentence case, from the chat's first message. */
export function titlePrompt(message: string): string {
  return [
    // A user's own standing instructions (a greeting, a sign-off) have no place in a sidebar name.
    'This is a naming task, not a conversation. Ignore any standing instruction about greeting or addressing anyone, tone or style.',
    'Name a chat in 2 to 6 words, the way a sidebar lists sessions: sentence case, no quotes, no trailing period, no emoji.',
    'Say what the work is about (for example "Products & Solutions page" or "Fix flaky onboarding test").',
    'Reply with the name only, and nothing else.',
    '',
    'The chat starts with this message:',
    message.slice(0, 4000),
  ].join('\n');
}

/** Claude's reply, made into a sidebar name: one line, no quotes or end punctuation, at most 60 characters. */
export function cleanTitle(reply: string): string | undefined {
  const line = reply.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? '';
  // eslint-disable-next-line no-control-regex
  const title = line.replace(/^(title|name)\s*:\s*/i, '').replace(/^["'“‘`*_#\s]+|["'”’`*_\s.!?:;,]+$/g, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 60 || title.split(' ').length > 10) return undefined;
  return title;
}

/**
 * A short name for a Claude chat, as Claude desktop gives its sessions: one `claude -p` call to Haiku, with nothing
 * of the user's own set-up (--safe-mode: no hooks, MCP servers, CLAUDE.md, plugins or skills), no tools, nothing
 * saved, in an empty folder of Hydra's own. Only the chat's first message goes, to the provider the chat already
 * uses. Anything wrong (no reply in 30 seconds, an error, an odd reply) leaves the first-line title as it was.
 */
export function claudeTitle(executable: string, message: string, timeoutMs = 30_000): Promise<string | undefined> {
  const folder = path.join(os.tmpdir(), 'hydra-chat-titles');
  try { fs.mkdirSync(folder, { recursive: true }); } catch { return Promise.resolve(undefined); }
  return new Promise(resolve => {
    let done = false, output = '';
    const args = ['-p', '--safe-mode', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'text'];
    const child = spawn(executable, args, { cwd: folder, env: cloudEnvironment(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (title: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(title);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.on('error', () => finish(undefined));
    child.on('close', code => finish(code === 0 ? cleanTitle(output) : undefined));
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 4096) finish(undefined); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(titlePrompt(message));
  });
}

/**
 * A short name for a Codex chat from Codex itself: one `codex exec` call on the user's own Codex login, so the message
 * goes only to the provider the chat already uses and never to Anthropic. It runs ephemeral and read-only in an empty
 * folder of Hydra's own, without the user's config.toml (so no MCP servers, hooks or custom model) or exec policy
 * rules, at low reasoning effort, and its last message is read from a file Hydra names. Anything wrong (no reply in 60
 * seconds, an error, an odd reply) leaves the first-line title as it was.
 */
export function codexTitle(executable: string, message: string, timeoutMs = 60_000): Promise<string | undefined> {
  const parent = path.join(os.tmpdir(), 'hydra-chat-titles');
  let folder: string;
  try { fs.mkdirSync(parent, { recursive: true }); folder = fs.mkdtempSync(path.join(parent, 'codex-')); } catch { return Promise.resolve(undefined); }
  const reply = path.join(folder, 'name.txt');
  const cleanup = () => { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* the temp folder's own cleanup */ } };
  return new Promise(resolve => {
    let done = false;
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never',
      '-c', 'model_reasoning_effort="low"', '-C', folder, '-o', reply, '-'];
    const launch = processLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, { cwd: folder, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Codex fails when its output goes to the null device, so both are pipes, read and dropped.
    child.stdout.resume(); child.stderr.resume();
    const finish = (title: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A `.cmd` shim runs codex under another process, so the whole tree goes, and then the folder it ran in.
      const gone = child.exitCode === null && child.pid ? terminateProcessTree(child.pid).catch(() => undefined) : Promise.resolve();
      void gone.then(cleanup);
      resolve(title);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.on('error', () => finish(undefined));
    child.on('close', code => {
      let text = '';
      if (code === 0) { try { text = fs.readFileSync(reply, 'utf8').slice(0, 4096); } catch { /* no reply */ } }
      finish(code === 0 ? cleanTitle(text) : undefined);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(titlePrompt(message));
  });
}

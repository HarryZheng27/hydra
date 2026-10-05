import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudEnvironment } from '../../../src/core/chat/cloud';

/** What Claude is asked: Claude desktop's kind of name, in sentence case, from the chat's first message. */
export function titlePrompt(message: string): string {
  return [
    'Name a chat in 2 to 6 words, the way a sidebar lists sessions: sentence case, no quotes, no trailing period, no emoji.',
    'Say what the work is about (for example "Products & Solutions page" or "Fix flaky onboarding test").',
    'Reply with the name only.',
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

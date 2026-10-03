import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '../src/core/chat/events';
import { nodeLaunch } from '../src/core/chat/launch';
import type { ChatProcess, Launch } from '../src/core/chat/session';

/**
 * Running the app's chat logic against G1's recordings (tests/fixtures/app/<provider>/): the replay stand-in plays
 * the CLI, and a Harness collects the session's events and the stand-in's own record of what the host sent.
 */
const root = path.join(__dirname, '..');
const replay = path.join(root, 'tests', 'fixtures', 'app', 'standins', 'replay.mjs');
export const fixtureFile = (scenario: string, provider: 'claude' | 'codex' = 'claude') => path.join(root, 'tests', 'fixtures', 'app', provider, `${scenario}.jsonl`);

export type Rec = { dir: string; line?: string; text?: string };
/** The fixture's records, split into parts at its "args:" notes (one per process the live check started). */
export function parts(scenario: string, provider: 'claude' | 'codex' = 'claude'): Array<{ args: string; records: Rec[] }> {
  const records = fs.readFileSync(fixtureFile(scenario, provider), 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(line => JSON.parse(line) as Rec);
  const out: Array<{ args: string; records: Rec[] }> = [];
  // Claude's fixtures mark each process with an "args:" note; Codex's begin each with the host's initialize request.
  const marked = records.some(record => record.dir === 'note' && record.text!.startsWith('args:'));
  for (const record of records) {
    const initialize = record.dir === 'send' && (() => { try { return JSON.parse(record.line!).method === 'initialize'; } catch { return false; } })();
    if (marked ? record.dir === 'note' && record.text!.startsWith('args:') : initialize) out.push({ args: record.text ?? '', records: [] });
    if (out.length && (record.dir === 'send' || record.dir === 'recv')) out.at(-1)!.records.push(record);
  }
  return out;
}

export class Harness {
  readonly events: ChatEvent[] = [];
  readonly processes: ChatProcess[] = [];
  private waiters: Array<() => void> = [];
  readonly state = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-chat-standin-'));
  readonly cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-chat-cwd-'));
  readonly launch: Launch;
  constructor(scenario: string, provider: 'claude' | 'codex' = 'claude') {
    const inner = nodeLaunch({ ...process.env, HYDRA_STANDIN_FIXTURE: fixtureFile(scenario, provider), HYDRA_STANDIN_STATE: this.state }, (_exe, args) => ({ executable: process.execPath, args: [replay, ...args] }));
    this.launch = (executable, args, cwd, handlers) => { const child = inner(executable, args, cwd, handlers); this.processes.push(child); return child; };
  }
  emit = (events: ChatEvent[]) => { this.events.push(...events); for (const waiter of this.waiters.splice(0)) waiter(); };
  async until<T>(find: () => T | undefined, what: string, ms = 20000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found !== undefined && found !== false) return found;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Stand-in errors: ${this.errors() || 'none'}. Last events: ${JSON.stringify(this.events.slice(-4))}`);
      await new Promise<void>(resolve => { this.waiters.push(resolve); setTimeout(resolve, 200); });
    }
  }
  of<T extends ChatEvent['type']>(type: T) { return this.events.filter((event): event is Extract<ChatEvent, { type: T }> => event.type === type); }
  errors() { try { return fs.readFileSync(path.join(this.state, 'errors.log'), 'utf8'); } catch { return ''; } }
  consumed() { try { return fs.readFileSync(path.join(this.state, 'consumed.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }
  calls() { try { return fs.readFileSync(path.join(this.state, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { index: number; args: string[] }); } catch { return []; } }
  /** Ends the stand-ins, then removes their folders (Windows keeps a process's working folder busy until it exits). */
  async cleanup() {
    for (const p of this.processes) p.kill();
    for (const dir of [this.state, this.cwd]) {
      for (let attempt = 0; ; attempt++) {
        try { await fs.promises.rm(dir, { recursive: true, force: true }); break; }
        catch (error) { if (attempt >= 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
      }
    }
  }
}

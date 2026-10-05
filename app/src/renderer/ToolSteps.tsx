import { useState } from 'react';
import type { ChatItem } from './chatModel';
import { Icon } from './Icon';

type Tool = ChatItem & { kind: 'tool' };

const field = (input: unknown, name: string): string => {
  const value = (input as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(v => typeof v === 'string').join(' ') : '';
};
const base = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file;
const clip = (text: string, max = 80) => { const line = text.split('\n')[0]!.trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/** What a step did, in a few words: its own description when it gave one (Claude's Bash does), else the verb and its object. */
export function stepLabel(tool: Tool): string {
  const { name, input } = tool;
  const description = field(input, 'description');
  switch (name) {
    case 'Bash': case 'Shell': case 'PowerShell': return description || `Ran ${clip(field(input, 'command'), 60)}`;
    case 'Read': return `Read ${base(field(input, 'file_path'))}`;
    case 'Edit': case 'MultiEdit': return `Edited ${base(field(input, 'file_path'))}`;
    case 'Write': return `Wrote ${base(field(input, 'file_path'))}`;
    case 'NotebookEdit': return `Edited ${base(field(input, 'notebook_path'))}`;
    case 'Edit files': return `Edited ${(input as { files?: unknown[] })?.files?.length ?? 0} files`;
    case 'Grep': return `Searched for ${clip(field(input, 'pattern'), 50)}`;
    case 'Glob': return `Found ${clip(field(input, 'pattern'), 50)}`;
    case 'WebFetch': { try { return `Fetched ${new URL(field(input, 'url')).host}`; } catch { return 'Fetched a page'; } }
    case 'WebSearch': case 'Web search': return `Searched the web for ${clip(field(input, 'query'), 50)}`;
    case 'TodoWrite': return 'Updated the to-do list';
    case 'Task': case 'Agent': return description || 'Ran an agent';
    default: return description || name.replace(/^mcp__/, '').replace(/__/g, ' / ');
  }
}

type Sort = 'command' | 'read' | 'edit' | 'search' | 'other';
const sortOf = (name: string): Sort => ['Bash', 'Shell', 'PowerShell'].includes(name) ? 'command' : name === 'Read' ? 'read'
  : ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Edit files'].includes(name) ? 'edit' : ['Grep', 'Glob', 'WebSearch', 'Web search'].includes(name) ? 'search' : 'other';
const phrase: Record<Sort, (n: number) => string> = {
  command: n => `ran ${n} command${n > 1 ? 's' : ''}`, read: n => `read ${n} file${n > 1 ? 's' : ''}`, edit: n => `edited ${n} file${n > 1 ? 's' : ''}`,
  search: n => `searched ${n} time${n > 1 ? 's' : ''}`, other: n => `used ${n} tool${n > 1 ? 's' : ''}`,
};

/** A group's line: one step's own label, or the counts ("Ran 2 commands, read 3 files"). */
export function groupLabel(tools: readonly Tool[]): string {
  if (tools.length === 1) return stepLabel(tools[0]!);
  const counts = new Map<Sort, number>();
  for (const tool of tools) counts.set(sortOf(tool.name), (counts.get(sortOf(tool.name)) ?? 0) + 1);
  const text = [...counts].map(([sort, n]) => phrase[sort](n)).join(', ');
  return text[0]!.toUpperCase() + text.slice(1);
}

const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };

/** One step, opened: its label, then what it was given and what came back. Everything in it is text. */
function Step({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const running = tool.output === undefined;
  return (
    <li className={`step ${tool.isError ? 'failed' : ''}`}>
      <button className="step-line" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className={`step-label ${running ? 'running' : ''}`}>{stepLabel(tool)}</span>
        {tool.isError && <span className="tool-state failed">failed</span>}
        <Icon name={open ? 'chevronDown' : 'chevron'} />
      </button>
      {open && <div className="step-body">
        <pre className="code"><code>{pretty(tool.input)}</code></pre>
        {!running && <pre className={`code output ${tool.isError ? 'error' : ''}`}><code>{tool.output || '(no output)'}</code></pre>}
      </div>}
    </li>
  );
}

/**
 * Claude desktop's collapsed tool steps: back-to-back calls fold into one grey line ("Watch CI for PR 332 ›", or
 * "Ran 2 commands, read 3 files ›"); clicking it lists each step, and each step opens to its input and output.
 */
export function ToolSteps({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some(tool => tool.output === undefined);
  const failed = tools.some(tool => tool.isError);
  return (
    <div className={`steps ${open ? 'open' : ''}`} data-tools={tools.map(tool => tool.name).join(',')}>
      <button className="steps-line" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className={`steps-label ${running ? 'running' : ''}`}>{running ? stepLabel(tools[tools.length - 1]!) : groupLabel(tools)}</span>
        {failed && !running && <span className="tool-state failed">failed</span>}
        <Icon name={open ? 'chevronDown' : 'chevron'} />
      </button>
      {open && <ul className="step-list">{tools.map(tool => <Step key={tool.key} tool={tool} />)}</ul>}
    </div>
  );
}

/**
 * Claude desktop's "N running tasks": commands Claude Code started in the background. One ends when a later step or
 * reply names its ID as finished or stopped, or when a turn the user didn't start (Claude Code's own notice that a task
 * ended) finishes. Those started before the chat was reopened ended with the process.
 */
export function runningTasks(events: readonly import('../shared/ipc').ChatEvent[], settledBefore = 0): number {
  const background = new Set<string>();
  const running: string[] = [];
  let userTurn = false;
  events.forEach((event, index) => {
    if (event.type === 'user') userTurn = true;
    else if (event.type === 'tool-call' && (event.input as { run_in_background?: unknown })?.run_in_background === true) background.add(event.id);
    else if (event.type === 'tool-result' && background.has(event.id)) {
      const id = /running in background with ID: ?([A-Za-z0-9_-]+)/.exec(event.output)?.[1];
      if (id && index >= settledBefore) running.push(id);
    } else if (event.type === 'tool-result' || event.type === 'text') {
      const text = event.type === 'text' ? event.delta : event.output;
      for (const id of [...running]) if (text.includes(id) && /complete|exit|stopp|kill|finish|fail/i.test(text)) running.splice(running.indexOf(id), 1);
    } else if (event.type === 'done') {
      if (!userTurn && running.length) running.shift();
      userTurn = false;
    }
  });
  return running.length;
}

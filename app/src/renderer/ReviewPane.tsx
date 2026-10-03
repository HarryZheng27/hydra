import { useEffect, useRef, useState } from 'react';
import type { ReviewFile, ReviewResult } from '../shared/ipc';

/**
 * The review pane: the chat folder's working tree against HEAD, read-only, in Monaco's diff editor (G1 proved it under
 * the app's CSP). Monaco's worker is created through a Trusted Types policy that allows only the app's own worker file.
 */
type Monaco = typeof import('monaco-editor/editor/editor.api.js');
let loading: Promise<Monaco> | undefined;
/** Monaco, loaded the first time a diff is shown (it is bundled; this only delays running it). */
function loadMonaco(): Promise<Monaco> {
  loading ??= import('monaco-editor/editor/editor.api.js').then(monaco => {
    const workerPolicy = (globalThis as { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): unknown } } }).trustedTypes?.createPolicy('hydraWorker', {
      createScriptURL: url => {
        if (url !== 'app://hydra/editor.worker.js') throw new Error(`Hydra doesn't load that worker: ${url}`);
        return url;
      },
    });
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: (_id: string, label: string) => new Worker((workerPolicy ? workerPolicy.createScriptURL('app://hydra/editor.worker.js') : 'app://hydra/editor.worker.js') as string, { name: label }),
    };
    return monaco;
  });
  return loading;
}

const language = (file: string): string => {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const known: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'cpp', yml: 'yaml', yaml: 'yaml', sh: 'shell', ps1: 'powershell', sql: 'sql', xml: 'xml' };
  return known[ext] ?? 'plaintext';
};
const statusLabel: Record<ReviewFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', untracked: 'U', changed: 'T' };

function DiffView({ file }: { file: ReviewFile }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined as void;
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
    const dark = document.documentElement.dataset.theme !== 'light';
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: true, theme: dark ? 'vs-dark' : 'vs',
      minimap: { enabled: false }, scrollBeyondLastLine: false, renderOverviewRuler: false, contextmenu: false, links: false,
    });
    const original = monaco.editor.createModel(file.original, language(file.path));
    const modified = monaco.editor.createModel(file.modified, language(file.path));
    editor.setModel({ original, modified });
      cleanup = () => { editor.dispose(); original.dispose(); modified.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [file]);
  return <div ref={host} className="diff-host" data-file={file.path} />;
}

export function ReviewPane({ chatId }: { chatId: string }) {
  const [result, setResult] = useState<ReviewResult>();
  const [selected, setSelected] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const load = () => {
    setProblem(undefined);
    window.hydra.reviewDiff(chatId).then(next => { setResult(next); setSelected(current => (current && next.files.some(f => f.path === current) ? current : next.files[0]?.path)); }, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [chatId]);
  const file = result?.files.find(f => f.path === selected);
  return (
    <section className="review" aria-label="Review changes">
      <div className="review-bar">
        <strong>Changes</strong>
        <span className="review-count">{result ? `${result.files.length}${result.truncated ? '+' : ''} file${result.files.length === 1 ? '' : 's'}` : 'Loading…'}</span>
        <button onClick={load}>Refresh</button>
      </div>
      {problem && <div className="banner error" role="alert">{problem}</div>}
      {result?.error && <div className="banner warning">{result.error}</div>}
      {result && !result.error && !result.files.length && <p className="hint review-empty">No changes against HEAD.</p>}
      {result && result.files.length > 0 && (
        <div className="review-body">
          <ul className="review-files">
            {result.files.map(f => (
              <li key={f.path}>
                <button className={f.path === selected ? 'selected' : ''} onClick={() => setSelected(f.path)} title={f.path}>
                  <span className={`status ${f.status}`}>{statusLabel[f.status]}</span><span className="review-path">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="review-diff">
            {file && (
              <>
                <div className="review-file-bar">
                  <span className="path" title={file.path}>{file.path}</span>
                  <button onClick={() => void window.hydra.openReviewFile(chatId, file.path).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))}>Open in editor</button>
                </div>
                {file.skipped ? <p className="hint">Not shown: {file.skipped}.</p> : <DiffView key={file.path} file={file} />}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

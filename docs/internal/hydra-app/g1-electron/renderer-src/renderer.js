// S4 item 4: Monaco diff editor + xterm.js in a sandboxed renderer under a strict CSP.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const spike = (window.__spike = { violations: [], steps: [], done: false });
document.addEventListener('securitypolicyviolation', e => {
  spike.violations.push({ where: 'page', directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile, line: e.lineNumber });
});
window.addEventListener('error', e => spike.steps.push({ error: String(e.message) }));

// Monaco's editor worker, served from our own origin as a classic script (worker-src 'self').
// With Trusted Types enforced, new Worker() needs a TrustedScriptURL, so the app owns one tiny policy that only
// allows its own worker files.
const workerPolicy = globalThis.trustedTypes?.createPolicy('hydraWorker', {
  createScriptURL: url => {
    if (!/^app:\/\/hydra\/[a-z.]+\.worker\.js$/.test(url)) throw new Error('worker URL not allowed: ' + url);
    return url;
  },
});
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    spike.steps.push({ worker: label });
    const url = 'app://hydra/editor.worker.js';
    return new Worker(workerPolicy ? workerPolicy.createScriptURL(url) : url, { name: label });
  },
};

const original = 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nconst x = 1;\n';
const modified = 'export function add(a: number, b: number): number {\n  // sum\n  return a + b;\n}\n\nconst x = 2;\n';
const diff = monaco.editor.createDiffEditor(document.getElementById('diff'), {
  readOnly: true, originalEditable: false, automaticLayout: false, renderSideBySide: true, theme: 'vs-dark', minimap: { enabled: false },
});
diff.setModel({
  original: monaco.editor.createModel(original, 'typescript'),
  modified: monaco.editor.createModel(modified, 'typescript'),
});
diff.layout({ width: 1200, height: 480 });

const term = new Terminal({ cols: 100, rows: 12, theme: { background: '#101010' } });
term.open(document.getElementById('term'));
term.write('\x1b[32mhello from xterm.js\x1b[0m in a sandboxed renderer\r\n$ ');
spike.steps.push({ xterm: 'opened' });

diff.onDidUpdateDiff(() => {
  const changes = diff.getLineChanges() || [];
  spike.steps.push({ diffUpdated: changes.length });
  spike.lineChanges = changes.length;
  spike.done = true;
});

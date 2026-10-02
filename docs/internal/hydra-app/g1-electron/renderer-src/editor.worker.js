// Monaco's editor worker entry (self-initialising editor.worker.js), bundled to a classic script.
self.addEventListener('securitypolicyviolation', e => {
  console.error(`Content Security Policy violation in worker: ${e.effectiveDirective} ${e.blockedURI}`);
});
import 'monaco-editor/editor/editor.worker.js';

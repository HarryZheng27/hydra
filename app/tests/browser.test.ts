import assert from 'node:assert/strict';
import test from 'node:test';
import { browserUrl } from '../src/main/browserUrl';
import { parseCall } from '../src/shared/ipc';

test('the browser panel loads http and https only, without credentials; a bare host gets https, a local one http', () => {
  assert.equal(browserUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(browserUrl('127.0.0.1:5173/app'), 'http://127.0.0.1:5173/app');
  assert.equal(browserUrl('github.com/ndunl075/hydra/pull/330'), 'https://github.com/ndunl075/hydra/pull/330');
  assert.equal(browserUrl('https://claude.ai/code/session_01ApFs1X7hjubWFrUBiN4Bht?from=cli&m=0'), 'https://claude.ai/code/session_01ApFs1X7hjubWFrUBiN4Bht?from=cli&m=0');
  for (const refused of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'app://hydra/index.html', 'data:text/html,hi', 'https://user:pw@example.com', 'chrome://settings', 'two words', '', 'x'.repeat(3000)]) {
    assert.equal(browserUrl(refused), undefined, refused);
  }
  assert.equal(parseCall({ channel: 'browser.bounds', payload: { x: -1, y: 0, width: 10, height: 10 } }).ok, false);
  assert.equal(parseCall({ channel: 'browser.open', payload: { url: 'https://example.com', extra: 1 } }).ok, false);
});

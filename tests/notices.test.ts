import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotices, toastText, type NoticeHost, type NoticeKind } from '../src/core/notices';

/** A host that records what reached the workbench toasts and what fell back to the editor's own messages. */
function host(options: { desktop: boolean; choice?: string; failShow?: boolean }) {
  const executed: { command: string; args: unknown[] }[] = [];
  const natives: { kind: NoticeKind; message: string; actions: string[] }[] = [];
  let pendingShow: ((choice: string | undefined) => void) | undefined;
  const fake: NoticeHost = {
    hasDesktopNotices: async () => options.desktop,
    execute: async <T>(command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      if (command !== 'hydra.desktop.notice.show') return undefined;
      if (options.failShow) throw new Error('workbench refused');
      const request = args[0] as { progress?: unknown };
      if (request.progress) return await new Promise<T | undefined>(resolve => { pendingShow = choice => resolve(choice as T | undefined); });
      return options.choice as T | undefined;
    },
    native: async (kind, message, actions) => { natives.push({ kind, message, actions }); return actions[0]; },
    nativeConfirm: async (message, detail, action) => { natives.push({ kind: 'warning', message: `${message} | ${detail}`, actions: [action] }); return options.choice ?? action; },
    nativeProgress: async (_options, task) => await task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }),
  };
  return { fake, executed, natives, press: (choice: string | undefined) => pendingShow?.(choice) };
}

test('toast text drops a leading "Hydra: ", since the toast already says Hydra', () => {
  assert.equal(toastText('Hydra: the preview didn\'t start.'), 'The preview didn\'t start.');
  assert.equal(toastText('Lane a is ready.'), 'Lane a is ready.');
  assert.equal(toastText('Hydra: '), 'Hydra: ');
});

test('in the desktop app a message is a Hydra toast, and the action pressed comes back', async () => {
  const { fake, executed, natives } = host({ desktop: true, choice: 'Show lane' });
  const notices = createNotices(fake);
  assert.equal(await notices.warning('Hydra: lane a failed.', 'Show lane'), 'Show lane');
  assert.equal(natives.length, 0);
  const request = executed[0]!.args[0] as { id: string; kind: string; message: string; actions: string[] };
  assert.equal(executed[0]!.command, 'hydra.desktop.notice.show');
  assert.equal(request.kind, 'warning');
  assert.equal(request.message, 'Lane a failed.');
  assert.deepEqual(request.actions, ['Show lane']);
  assert.match(request.id, /^[\w.:-]{1,64}$/);
});

test('a choice the notice did not offer is treated as dismissed', async () => {
  const { fake } = host({ desktop: true, choice: 'Something else' });
  assert.equal(await createNotices(fake).info('Ready.', 'Open'), undefined);
});

test('outside the desktop app, or when the workbench refuses, messages fall back to the editor, unchanged', async () => {
  const plain = host({ desktop: false });
  assert.equal(await createNotices(plain.fake).error('Hydra: broke.', 'Retry'), 'Retry');
  assert.deepEqual(plain.natives, [{ kind: 'error', message: 'Hydra: broke.', actions: ['Retry'] }]);
  assert.equal(plain.executed.length, 0);
  const refused = host({ desktop: true, failShow: true });
  await createNotices(refused.fake).info('Hello.');
  assert.deepEqual(refused.natives, [{ kind: 'info', message: 'Hello.', actions: [] }]);
});

test('progress shows a sticky toast, reports message and percent, closes when done, and Cancel cancels', async () => {
  const { fake, executed, press } = host({ desktop: true });
  const notices = createNotices(fake);
  let cancelled = false;
  const result = await notices.withProgress({ title: 'Downloading Hydra 1.0…', cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => { cancelled = true; });
    progress.report({ increment: 40, message: '4 of 10 MB' });
    progress.report({ increment: 80 });
    press('Cancel');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(token.isCancellationRequested, true);
    return 'file';
  });
  assert.equal(result, 'file');
  assert.equal(cancelled, true);
  const show = executed.find(call => call.command === 'hydra.desktop.notice.show')!.args[0] as { id: string; progress: unknown; sticky: boolean; actions: string[] };
  assert.equal(show.progress, true);
  assert.equal(show.sticky, true);
  assert.deepEqual(show.actions, ['Cancel']);
  const updates = executed.filter(call => call.command === 'hydra.desktop.notice.update').map(call => call.args[1]);
  assert.deepEqual(updates, [{ detail: '4 of 10 MB', progress: 40 }, { progress: 100 }]);
  assert.deepEqual(executed.at(-1), { command: 'hydra.desktop.notice.close', args: [show.id] });
});

test('dismissing a cancellable progress toast cancels its task; a finished task closing its toast does not', async () => {
  const { fake, press } = host({ desktop: true });
  let cancelled = false;
  await createNotices(fake).withProgress({ title: 'Downloading…', cancellable: true }, async (_progress, token) => {
    token.onCancellationRequested(() => { cancelled = true; });
    press(undefined);
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(cancelled, true);
  const plain = host({ desktop: true });
  let plainCancelled = false;
  await createNotices(plain.fake).withProgress({ title: 'Starting…' }, async (_progress, token) => {
    token.onCancellationRequested(() => { plainCancelled = true; });
    plain.press(undefined);
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(plainCancelled, false, 'a task that cannot be cancelled keeps going');
});

test('progress falls back to the editor when the workbench refuses its toast', async () => {
  const refused = host({ desktop: true, failShow: true });
  assert.equal(await createNotices(refused.fake).withProgress({ title: 'Starting…' }, async () => 7), 7);
  assert.ok(!refused.executed.some(call => call.command === 'hydra.desktop.notice.close'));
});

test('progress closes its toast even when the task fails', async () => {
  const { fake, executed } = host({ desktop: true });
  await assert.rejects(createNotices(fake).withProgress({ title: 'Starting lane a…' }, async () => { throw new Error('no'); }), /no/);
  assert.equal(executed.at(-1)!.command, 'hydra.desktop.notice.close');
  assert.deepEqual((executed[0]!.args[0] as { actions: string[] }).actions, []);
});

test('confirm: in the desktop app a warning card that waits for an answer, with the detail; elsewhere the editor\'s modal', async () => {
  const yes = host({ desktop: true, choice: 'Install and restart' });
  assert.equal(await createNotices(yes.fake).confirm('Install Hydra 1.0?', 'Hydra will close and reopen.', 'Install and restart'), 'Install and restart');
  const request = yes.executed[0]!.args[0] as { kind: string; message: string; detail: string; actions: string[]; sticky: boolean };
  assert.deepEqual([request.kind, request.message, request.detail, request.actions, request.sticky], ['warning', 'Install Hydra 1.0?', 'Hydra will close and reopen.', ['Install and restart', 'Not now'], true]);
  assert.equal(yes.natives.length, 0);
  const notNow = host({ desktop: true, choice: 'Not now' });
  assert.equal(await createNotices(notNow.fake).confirm('Install Hydra 1.0?', 'x', 'Install and restart'), undefined);
  const dismissed = host({ desktop: true });
  assert.equal(await createNotices(dismissed.fake).confirm('Install Hydra 1.0?', 'x', 'Install and restart'), undefined, 'closing the card is not a yes');
  const plain = host({ desktop: false });
  assert.equal(await createNotices(plain.fake).confirm('Install Hydra 1.0?', 'Hydra will close and reopen.', 'Install and restart'), 'Install and restart');
  assert.deepEqual(plain.natives, [{ kind: 'warning', message: 'Install Hydra 1.0? | Hydra will close and reopen.', actions: ['Install and restart'] }]);
  const refused = host({ desktop: true, failShow: true });
  await createNotices(refused.fake).confirm('Install Hydra 1.0?', 'x', 'Install and restart');
  assert.equal(refused.natives.length, 1, 'a refused card falls back to the dialog');
});

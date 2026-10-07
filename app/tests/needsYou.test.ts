import test from 'node:test';
import assert from 'node:assert/strict';
import { PutOffs, putOffKey } from '../../src/core/needsYouList';
import type { NeedsYouItem } from '../../src/core/needsYou';
import { chatFacts, inProject, isChatItem, needsYouItems, readChatPutOffs } from '../src/renderer/needsYou';
import type { ChatRecord, HydraTreeMessage, Project } from '../src/shared/ipc';

const NOW = 1_000_000_000;
const minute = 60_000;
const projects: Project[] = [{ id: 'p1', name: 'Hydra', path: 'C:\\work\\hydra', trustedAt: '2026-01-01T00:00:00Z' }, { id: 'p2', name: 'Site', path: 'C:\\work\\site', trustedAt: '2026-01-01T00:00:00Z' }];
const chat = (id: string, title: string, cwd: string, extra: Partial<ChatRecord> = {}): ChatRecord => ({ id, title, cwd, provider: 'claude', createdAt: new Date(NOW - 10 * minute).toISOString(), updatedAt: new Date(NOW - minute).toISOString(), ...extra }) as ChatRecord;
const item = (kind: NeedsYouItem['kind'], sourceId: string, since: number, tier: NeedsYouItem['tier']): NeedsYouItem => ({ id: `${kind}:controller-key:${sourceId}`, kind, tier, projectId: 'controller-key', projectName: '', title: sourceId, sourceId, since });
const tree = (projectId: string, needsYou: NeedsYouItem[]): HydraTreeMessage => ({ projectId, heads: [], plans: [], owned: true, needsYou });

test('a project\'s items take the window\'s project id and name, and chats are added from their dots', () => {
  const trees = { p1: tree('p1', [item('lane-waiting', 'lane1', NOW - 5 * minute, 'decision'), item('head-question', 'head1', NOW - 9 * minute, 'clock')]) };
  const chats = [chat('c1', 'Fix login', 'c:\\work\\HYDRA'), chat('c2', 'Docs', 'C:\\work\\site'), chat('c3', 'Quiet', 'C:\\work\\hydra'), chat('c4', 'Archived', 'C:\\work\\hydra', { archivedAt: new Date(NOW).toISOString() })];
  const items = needsYouItems({ projects, trees, chats, statuses: { c1: 'needs', c2: 'unread', c3: 'working', c4: 'needs' }, chatPutOffs: new PutOffs(), now: NOW });
  assert.deepEqual(items.map(entry => [entry.kind, entry.sourceId, entry.projectId, entry.projectName]), [
    ['head-question', 'head1', 'p1', 'Hydra'],
    ['lane-waiting', 'lane1', 'p1', 'Hydra'],
    ['chat-needs', 'c1', 'p1', 'Hydra'],
    ['chat-unread', 'c2', 'p2', 'Site'],
  ]);
  assert.equal(items[0]!.id, 'head-question:p1:head1');
  assert.ok(isChatItem(items[2]!) && !isChatItem(items[0]!));
});

test('a chat outside every project is still listed, with no project', () => {
  const facts = chatFacts([chat('c1', 'Loose', 'C:\\elsewhere')], { c1: 'needs' }, projects);
  assert.deepEqual(facts.map(entry => [entry.projectId, entry.chats?.map(row => row.id)]), [['', ['c1']]]);
});

test('a chat that was put off leaves the list, and comes back at its time', () => {
  const chats = [chat('c1', 'Fix login', 'C:\\work\\hydra')];
  const statuses = { c1: 'needs' as const };
  const putOffs = new PutOffs();
  putOffs.putOff('chat-needs:c1', NOW + 60 * minute);
  const args = { projects, trees: {}, chats, statuses, chatPutOffs: putOffs };
  assert.equal(needsYouItems({ ...args, now: NOW }).length, 0);
  assert.equal(needsYouItems({ ...args, now: NOW + 61 * minute }).length, 1);
  // The put-off is by kind and source, whichever project id the window knows it by.
  assert.equal(putOffKey(inProject(item('chat-needs', 'c1', NOW, 'decision'), projects[1]!)), 'chat-needs:c1');
});

test('the window\'s chat put-offs are read from local storage, and a missing or broken one is none', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  try {
    assert.equal(readChatPutOffs(NOW).size, 0);
    store.set('hydra.needsYou.putOff.v1.chats', JSON.stringify([{ id: 'chat-needs:c1', until: NOW + minute }]));
    assert.equal(readChatPutOffs(NOW).size, 1);
    store.set('hydra.needsYou.putOff.v1.chats', '{broken');
    assert.equal(readChatPutOffs(NOW).size, 0);
  } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
});

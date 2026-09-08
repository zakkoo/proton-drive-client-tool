import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IllegalJournalTransitionError, JournalRepo } from './journal.ts';
import { ConflictRepo, CursorRepo, QuarantineRepo, ScanRepo, SnapshotRepo } from './misc.ts';
import { StateStore } from './store.ts';

let dir: string;
let store: StateStore;
let t = 1000;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-journal-'));
  store = StateStore.open(path.join(dir, 'state.db'), { now: () => (t += 1) });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('JournalRepo', () => {
  const input = { op: 'upload', relPath: 'a.txt', previousRelPath: null, nodeUid: null, intended: { sha1: 'x' }, preState: { local: { ino: 1 } } };

  it('follows planned -> in_progress -> completed with fingerprints and outcome preserved', () => {
    const j = new JournalRepo(store);
    const e = j.plan(input);
    expect(e.status).toBe('planned');
    expect(e.preState).toEqual({ local: { ino: 1 } });
    const started = j.start(e.id);
    expect(started.status).toBe('in_progress');
    expect(started.attempt).toBe(1);
    const done = j.complete(e.id, { revisionUid: 'r1' });
    expect(done.status).toBe('completed');
    expect(done.outcome).toEqual({ revisionUid: 'r1' });
    expect(done.updatedAt).toBeGreaterThan(e.createdAt);
  });

  it('rejects illegal transitions', () => {
    const j = new JournalRepo(store);
    const e = j.plan(input);
    expect(() => j.complete(e.id, {})).toThrow(IllegalJournalTransitionError); // planned -> completed
    expect(() => j.fail(e.id, 'x')).toThrow(IllegalJournalTransitionError); // planned -> failed
    j.start(e.id);
    expect(() => j.start(e.id)).toThrow(IllegalJournalTransitionError); // in_progress -> in_progress
    j.fail(e.id, 'network');
    for (const fn of [() => j.start(e.id), () => j.complete(e.id, {}), () => j.abandon(e.id, 'r'), () => j.fail(e.id, 'again')]) {
      expect(fn).toThrow(IllegalJournalTransitionError);
    }
    expect(j.get(e.id)).toMatchObject({ status: 'failed', error: 'network', attempt: 1 });
    const p = j.plan(input);
    expect(j.abandon(p.id, 'plan discarded').status).toBe('abandoned'); // planned -> abandoned allowed
  });

  it('lists unresolved entries in order and prunes only terminal ones', () => {
    const j = new JournalRepo(store);
    const a = j.plan({ ...input, relPath: 'a' });
    const b = j.plan({ ...input, relPath: 'b' });
    const c = j.plan({ ...input, relPath: 'c' });
    j.start(b.id);
    j.start(c.id);
    j.complete(c.id, {});
    expect(j.unresolved().map((e) => e.relPath)).toEqual(['a', 'b']);
    expect(j.byStatus('in_progress').map((e) => e.id)).toEqual([b.id]);
    expect(j.prune(t + 1)).toBe(1);
    expect(j.unresolved()).toHaveLength(2);
    expect(a.id).toBeLessThan(b.id);
  });
});

describe('misc repositories', () => {
  it('cursors persist per scope and act as an event cursor store', async () => {
    const c = new CursorRepo(store);
    expect(await c.get('s1')).toBeNull();
    await c.set('s1', '42');
    expect(await c.getLatestEventId('s1')).toBe('42');
    await c.set('s1', '43');
    expect(await c.get('s1')).toBe('43');
    c.clear('s1');
    expect(await c.get('s1')).toBeNull();
  });

  it('records scan completion times', () => {
    const s = new ScanRepo(store);
    expect(s.lastCompleted('local')).toBeNull();
    s.markCompleted('local', 5);
    expect(s.lastCompleted('local')).toBe(5);
  });

  it('quarantine tracks open items by path or node uid and releases them', () => {
    const q = new QuarantineRepo(store);
    const e = q.add({ relPath: 'bad.bin', nodeUid: 'n9', reason: 'digest_mismatch', details: { expected: 'a', actual: 'b' } });
    expect(q.isQuarantined('bad.bin', null)).toBe(true);
    expect(q.isQuarantined(null, 'n9')).toBe(true);
    expect(q.isQuarantined('other', 'n1')).toBe(false);
    expect(q.open().map((x) => x.id)).toEqual([e.id]);
    q.release(e.id);
    expect(q.isQuarantined('bad.bin', 'n9')).toBe(false);
    expect(q.open()).toEqual([]);
  });

  it('conflicts are listed while open and carry both versions', () => {
    const c = new ConflictRepo(store);
    const e = c.add({ relPath: 'doc.md', nodeUid: 'n1', kind: 'content', local: { sha1: 'l' }, remote: { sha1: 'r' } });
    expect(c.openForPath('doc.md')?.id).toBe(e.id);
    expect(c.open()[0]?.local).toEqual({ sha1: 'l' });
    c.resolve(e.id, 'keep_both');
    expect(c.open()).toEqual([]);
    expect(c.get(e.id).resolution).toBe('keep_both');
  });

  it('snapshots are replaced wholesale and read back', () => {
    const s = new SnapshotRepo(store);
    s.replaceLocal([{ relPath: 'a', kind: 'file', dev: 1, ino: 2, size: 3, mtimeMs: 4.5, sha1: null }]);
    s.replaceLocal([{ relPath: 'b', kind: 'dir', dev: 1, ino: 3, size: 0, mtimeMs: 1, sha1: null }]);
    expect(s.local().map((r) => r.relPath)).toEqual(['b']);
    s.replaceRemote([
      { nodeUid: 'n1', parentUid: null, name: 'root', nameStatus: 'ok', type: 'folder', isTrashed: false, revisionUid: null, claimedSha1: null, claimedSize: null, claimedMtimeMs: null, serverMtimeMs: 1, degraded: false, json: '{}' },
    ]);
    s.upsertRemote({ nodeUid: 'n2', parentUid: 'n1', name: 'f', nameStatus: 'ok', type: 'file', isTrashed: true, revisionUid: 'r', claimedSha1: 'x', claimedSize: 9, claimedMtimeMs: 2, serverMtimeMs: 3, degraded: true, json: '{}' });
    expect(s.remote().map((r) => `${r.nodeUid}:${String(r.isTrashed)}:${String(r.degraded)}`)).toEqual(['n1:false:false', 'n2:true:true']);
    s.removeRemote('n1');
    expect(s.remote()).toHaveLength(1);
  });
});

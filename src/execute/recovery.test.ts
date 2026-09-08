import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Operation } from '../reconcile/types.js';
import { sha1Hex } from '../testing/fakeRemote.js';
import { SyncHarness } from '../testing/harness.js';
import { tempDir } from './localWrite.js';

let h: SyncHarness;
beforeEach(() => {
  h = SyncHarness.create();
});
afterEach(() => {
  h.dispose();
});

/** Journal an operation as in_progress, as if the process died right after starting it. */
function inProgress(op: Operation): number {
  const entry = h.journal.plan({ op: op.kind, relPath: 'relPath' in op ? op.relPath : op.to, previousRelPath: 'from' in op ? op.from : null, nodeUid: 'remoteUid' in op ? (op.remoteUid ?? null) : null, intended: op, preState: {} });
  h.journal.start(entry.id);
  return entry.id;
}

describe('recoverJournal', () => {
  it('crash after upload but before completion: completes the entry from the remote state without re-uploading', async () => {
    h.write('u.txt', 'U');
    const uploaded = h.fake.seedFile(h.remoteRootUid, 'u.txt', 'U'); // the upload landed
    const st = (await import('node:fs')).statSync(path.join(h.root, 'u.txt'));
    inProgress({ id: 'x', kind: 'upload', relPath: 'u.txt', mode: 'new', remoteUid: undefined, expectedLocal: { dev: st.dev, ino: st.ino, size: 1, mtimeMs: st.mtimeMs, sha1: sha1Hex('U') }, expectedRemote: undefined, evidence: [] });
    h.reopen();
    const report = await h.recover();
    expect(report).toMatchObject({ completed: 1, failed: 0, abandoned: 0 });
    expect(h.baseline.byPath('u.txt')?.nodeUid).toBe(uploaded.uid);
    expect(h.journal.unresolved()).toEqual([]);
    expect(h.fake.calls.filter((c) => c.op === 'upload')).toHaveLength(0);
    const plan = await h.plan();
    expect(plan.operations).toEqual([]);
    h.assertBaselineConsistent();
  });

  it('crash during download: temp file removed, entry failed, download replanned', async () => {
    const node = h.fake.seedFile(h.remoteRootUid, 'd.txt', 'D');
    mkdirSync(tempDir(h.root), { recursive: true });
    writeFileSync(path.join(tempDir(h.root), 'download-partial'), 'partial');
    inProgress({ id: 'x', kind: 'download', relPath: 'd.txt', remoteUid: node.uid, expectedRemote: { uid: node.uid, parentUid: node.parentUid, name: node.name, revisionUid: node.revisionUid, sha1: node.claimedSha1 }, expectedLocal: undefined, evidence: [] });
    h.reopen();
    const report = await h.recover();
    expect(report).toMatchObject({ completed: 0, failed: 1, abandoned: 0, tempFilesRemoved: 1 });
    expect(readdirSync(tempDir(h.root))).toEqual([]);
    expect(h.journal.byStatus('failed')).toHaveLength(1);
    const plan = await h.plan();
    expect(plan.operations.map((o) => o.kind)).toEqual(['download']);
  });

  it('crash after a completed download but before commit: completes from the local content', async () => {
    const node = h.fake.seedFile(h.remoteRootUid, 'd.txt', 'D');
    h.write('d.txt', 'D'); // the download landed
    inProgress({ id: 'x', kind: 'download', relPath: 'd.txt', remoteUid: node.uid, expectedRemote: { uid: node.uid, parentUid: node.parentUid, name: node.name, revisionUid: node.revisionUid, sha1: node.claimedSha1 }, expectedLocal: undefined, evidence: [] });
    h.reopen();
    expect(await h.recover()).toMatchObject({ completed: 1 });
    expect(h.baseline.byPath('d.txt')?.remoteSha1).toBe(sha1Hex('D'));
    h.assertBaselineConsistent();
  });

  it('unknown outcome: entry abandoned, item quarantined, nothing deleted', async () => {
    h.write('a.txt', 'A');
    const node = h.fake.seedFile(h.remoteRootUid, 'a.txt', 'A');
    await h.settle();
    // A local move whose source and destination are both absent now.
    rmSync(path.join(h.root, 'a.txt'));
    inProgress({ id: 'x', kind: 'move_local', from: 'a.txt', to: 'b.txt', remoteUid: node.uid, expectedLocal: { dev: 1, ino: 1, size: 1, mtimeMs: 1 }, evidence: [] });
    h.reopen();
    const report = await h.recover();
    expect(report).toMatchObject({ abandoned: 1 });
    expect(h.quarantine.open().map((q) => q.reason)).toEqual(['unknown_outcome']);
    expect(h.fake.trashedUids()).toEqual([]);
    expect(h.recycledContents()).toEqual([]);
    const plan = await h.plan();
    expect(plan.operations).toEqual([]);
  });

  it('move already performed locally is completed; trash already performed remotely is completed; planned-but-never-started is abandoned', async () => {
    h.write('m.txt', 'M');
    h.write('t.txt', 'T');
    const m = h.fake.seedFile(h.remoteRootUid, 'm.txt', 'M');
    const t = h.fake.seedFile(h.remoteRootUid, 't.txt', 'T');
    await h.settle();
    const row = h.baseline.byPath('m.txt');
    if (row === null) throw new Error('missing baseline');
    // The remote was renamed (that is what a move_local follows); the local rename happened, then the process died.
    await h.fake.rename(m.uid, 'moved.txt');
    renameSync(path.join(h.root, 'm.txt'), path.join(h.root, 'moved.txt'));
    inProgress({ id: 'x', kind: 'move_local', from: 'm.txt', to: 'moved.txt', remoteUid: m.uid, expectedLocal: { dev: row.localDev, ino: row.localIno, size: row.localSize, mtimeMs: row.localMtimeMs }, evidence: [] });
    // The local copy was deleted (which is why a trash was planned); the remote trash happened, then the process died.
    rmSync(path.join(h.root, 't.txt'));
    await h.fake.trash([t.uid]);
    inProgress({ id: 'y', kind: 'trash_remote', remoteUid: t.uid, relPath: 't.txt', itemKind: 'file', expectedRemote: { uid: t.uid, parentUid: t.parentUid, name: t.name }, evidence: [] });
    h.journal.plan({ op: 'upload', relPath: 'never.txt', previousRelPath: null, nodeUid: null, intended: { kind: 'upload' }, preState: {} });
    h.reopen();
    const report = await h.recover();
    expect(report).toMatchObject({ completed: 2, abandoned: 1, failed: 0 });
    expect(h.baseline.byPath('moved.txt')?.nodeUid).toBe(m.uid);
    expect(h.baseline.byPath('m.txt')).toBeNull();
    expect(h.baseline.byPath('t.txt')).toBeNull();
    expect(h.journal.unresolved()).toEqual([]);
    const plan = await h.plan();
    expect(plan.operations.map((o) => o.kind)).toEqual([]);
    h.assertBaselineConsistent();
  });
});

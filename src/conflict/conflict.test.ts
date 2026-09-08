import { renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Plan } from '../reconcile/types.js';
import { ConflictRepo } from '../state/misc.ts';
import { SyncHarness } from '../testing/harness.js';
import { ConflictHandler } from './handler.js';
import { conflictName, isConflictCopy, uniqueConflictPath } from './naming.js';

let h: SyncHarness;
let handler: ConflictHandler;
let clock: number;

beforeEach(() => {
  h = SyncHarness.create();
  clock = Date.UTC(2026, 8, 7, 21, 55, 0);
  handler = new ConflictHandler({
    root: h.root,
    remote: h.fake,
    store: h.store,
    baseline: h.baseline,
    journal: h.journal,
    conflicts: new ConflictRepo(h.store),
    audit: h.audit,
    machine: 'laptop',
    now: () => new Date((clock += 60_000)),
  });
});
afterEach(() => {
  h.dispose();
});

/** Full cycle including conflict handling, repeated until stable. */
async function settleWithConflicts(max = 6): Promise<Plan> {
  let plan = await h.plan();
  for (let i = 0; i < max && (plan.operations.length > 0 || plan.conflicts.length > 0); i++) {
    await handler.handleNew(plan.conflicts);
    await h.execute(plan);
    plan = await h.plan();
  }
  return plan;
}

function sameOnBothSides(): void {
  expect([...h.localFiles().entries()].sort()).toEqual([...h.remoteFiles().entries()].sort());
}

describe('conflict naming', () => {
  it('is deterministic, keeps the extension, and never collides', () => {
    const at = new Date('2026-09-07T21:55:00Z');
    expect(conflictName('report.pdf', 'laptop', at)).toBe('report.conflict-laptop-20260907T215500.pdf');
    expect(conflictName('Makefile', 'laptop', at)).toBe('Makefile.conflict-laptop-20260907T215500');
    expect(conflictName('.env', 'laptop', at)).toBe('.env.conflict-laptop-20260907T215500');
    const taken = new Set(['docs/a.conflict-laptop-20260907T215500.txt', 'docs/a.conflict-laptop-20260907T215500 (1).txt']);
    expect(uniqueConflictPath('docs/a.txt', 'laptop', at, (p) => taken.has(p))).toBe('docs/a.conflict-laptop-20260907T215500 (2).txt');
    expect(isConflictCopy('x/report.conflict-laptop-20260907T215500.pdf')).toBe(true);
    expect(isConflictCopy('x/report.pdf')).toBe(false);
  });
});

describe('content conflicts', () => {
  it('keeps both versions: remote at the original path, local as a conflict copy, both present on both sides', async () => {
    h.write('doc.md', 'base');
    await h.settle();
    h.write('doc.md', 'local edit');
    const uid = h.remotePathToUid('doc.md') ?? '';
    h.fake.seedRevision(uid, 'remote edit');
    const first = await h.plan();
    expect(first.conflicts.map((c) => c.kind)).toEqual(['content']);
    const plan = await settleWithConflicts();
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    const local = h.localFiles();
    expect(local.get('doc.md')).toBe('remote edit');
    const copies = [...local.keys()].filter(isConflictCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^doc\.conflict-laptop-\d{8}T\d{6}\.md$/);
    expect(local.get(copies[0] ?? '')).toBe('local edit');
    sameOnBothSides();
    h.assertBaselineConsistent();
    const inbox = new ConflictRepo(h.store).open();
    expect(inbox.map((c) => `${c.kind}:${c.relPath}`)).toEqual(['content:doc.md']);
    expect(h.recycledContents()).toEqual([]);
    expect(h.fake.trashedUids()).toEqual([]);
  });

  it('a second conflict on the same path creates a distinct copy and replaces nothing', async () => {
    h.write('doc.md', 'v0');
    await h.settle();
    h.write('doc.md', 'L1');
    h.fake.seedRevision(h.remotePathToUid('doc.md') ?? '', 'R1');
    await settleWithConflicts();
    h.write('doc.md', 'L2');
    h.fake.seedRevision(h.remotePathToUid('doc.md') ?? '', 'R2');
    await settleWithConflicts();
    const local = h.localFiles();
    const copies = [...local.keys()].filter(isConflictCopy).sort();
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((c) => local.get(c)))).toEqual(new Set(['L1', 'L2']));
    expect(local.get('doc.md')).toBe('R2');
    sameOnBothSides();
  });

  it('files created independently on both sides with different content are handled the same way', async () => {
    h.write('new.txt', 'mine');
    h.fake.seedFile(h.remoteRootUid, 'new.txt', 'theirs');
    const first = await h.plan();
    expect(first.conflicts.map((c) => c.kind)).toEqual(['create_create']);
    await settleWithConflicts();
    const local = h.localFiles();
    expect(local.get('new.txt')).toBe('theirs');
    expect([...local.values()].sort()).toEqual(['mine', 'theirs']);
    sameOnBothSides();
  });
});

describe('delete versus edit', () => {
  it('deleted remotely, edited locally: the edit is re-uploaded and listed in the inbox', async () => {
    h.write('keep.txt', 'v1');
    await h.settle();
    await h.fake.trash([h.remotePathToUid('keep.txt') ?? '']);
    h.write('keep.txt', 'v2 edited');
    const plan = await settleWithConflicts();
    expect(plan.operations).toEqual([]);
    expect(h.remoteFiles().get('keep.txt')).toBe('v2 edited');
    expect(h.localFiles().get('keep.txt')).toBe('v2 edited');
    expect(new ConflictRepo(h.store).open().map((c) => c.kind)).toEqual(['delete_vs_edit']);
    h.assertBaselineConsistent();
  });

  it('deleted locally, edited remotely: the remote version is downloaded again', async () => {
    h.write('keep.txt', 'v1');
    await h.settle();
    rmSync(path.join(h.root, 'keep.txt'));
    h.fake.seedRevision(h.remotePathToUid('keep.txt') ?? '', 'v2 remote');
    await settleWithConflicts();
    expect(h.localFiles().get('keep.txt')).toBe('v2 remote');
    expect(h.fake.trashedUids()).toEqual([]);
    sameOnBothSides();
  });

  it('a file created inside a remotely deleted folder brings the folder back; nothing is deleted', async () => {
    h.write('proj/a.txt', 'A');
    await h.settle();
    await h.fake.trash([h.remotePathToUid('proj') ?? '']);
    h.write('proj/new.txt', 'N');
    await settleWithConflicts();
    expect(h.remoteFiles().get('proj/new.txt')).toBe('N');
    expect(h.remoteFiles().get('proj/a.txt')).toBe('A');
    expect(h.recycledContents()).toEqual([]);
    sameOnBothSides();
  });
});

describe('divergent moves', () => {
  it('are surfaced with both destinations and nothing moves until the user decides; keep_remote moves the local copy', async () => {
    h.write('f.txt', 'F');
    await h.settle();
    renameSync(path.join(h.root, 'f.txt'), path.join(h.root, 'local-name.txt'));
    await h.fake.rename(h.remotePathToUid('f.txt') ?? '', 'remote-name.txt');
    const plan = await h.plan();
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts[0]).toMatchObject({ kind: 'divergent_move', localPath: 'local-name.txt', remotePath: 'remote-name.txt' });
    const [entry] = await handler.handleNew(plan.conflicts);
    if (entry === undefined) throw new Error('no entry');
    expect(entry.local).toEqual({ path: 'local-name.txt' });
    expect(entry.remote).toEqual({ path: 'remote-name.txt' });
    // Still blocked, still no operations.
    expect((await h.plan()).operations).toEqual([]);
    const ops = await handler.resolve(entry.id, 'keep_remote');
    expect(ops.map((o) => o.kind)).toEqual(['move_local']);
    await h.execute({ ...plan, operations: ops });
    await settleWithConflicts();
    expect([...h.localFiles().keys()]).toEqual(['remote-name.txt']);
    sameOnBothSides();
    h.assertBaselineConsistent();
  });

  it('keep_local moves the remote node; keep_both keeps two independent files', async () => {
    h.write('f.txt', 'F');
    h.write('g.txt', 'G');
    await h.settle();
    renameSync(path.join(h.root, 'f.txt'), path.join(h.root, 'lf.txt'));
    await h.fake.rename(h.remotePathToUid('f.txt') ?? '', 'rf.txt');
    renameSync(path.join(h.root, 'g.txt'), path.join(h.root, 'lg.txt'));
    await h.fake.rename(h.remotePathToUid('g.txt') ?? '', 'rg.txt');
    const plan = await h.plan();
    const entries = await handler.handleNew(plan.conflicts);
    const f = entries.find((e) => e.relPath === 'f.txt');
    const g = entries.find((e) => e.relPath === 'g.txt');
    if (f === undefined || g === undefined) throw new Error('entries');
    const opsF = await handler.resolve(f.id, 'keep_local');
    expect(opsF.map((o) => o.kind)).toEqual(['move_remote']);
    await h.execute({ ...plan, operations: opsF });
    await handler.resolve(g.id, 'keep_both');
    await settleWithConflicts();
    const local = h.localFiles();
    expect([...local.keys()].sort()).toEqual(['lf.txt', 'lg.txt', 'rg.txt']);
    sameOnBothSides();
    h.assertBaselineConsistent();
  });
});

describe('inbox resolution of content conflicts', () => {
  async function contentConflict(): Promise<{ id: number; copy: string }> {
    h.write('doc.md', 'base');
    await h.settle();
    h.write('doc.md', 'local edit');
    h.fake.seedRevision(h.remotePathToUid('doc.md') ?? '', 'remote edit');
    await settleWithConflicts();
    const entry = new ConflictRepo(h.store).open()[0];
    if (entry === undefined) throw new Error('no conflict');
    const copy = (entry.local as { path: string }).path;
    return { id: entry.id, copy };
  }

  it('keep_remote recycles the local conflict copy and trashes its remote twin', async () => {
    const { id, copy } = await contentConflict();
    const ops = await handler.resolve(id, 'keep_remote');
    expect(ops.map((o) => o.kind).sort()).toEqual(['recycle_local', 'trash_remote']);
    await h.execute({ operations: ops } as Plan);
    await settleWithConflicts();
    expect([...h.localFiles().keys()]).toEqual(['doc.md']);
    expect(h.localFiles().get('doc.md')).toBe('remote edit');
    expect(h.recycledContents()).toEqual(['local edit']);
    expect(h.remoteTrashedContents()).toEqual(['local edit']);
    expect(h.localFiles().has(copy)).toBe(false);
    expect(new ConflictRepo(h.store).open()).toEqual([]);
    sameOnBothSides();
  });

  it('keep_local replaces the original with the local version (old version recycled and trashed, never deleted)', async () => {
    const { id } = await contentConflict();
    const ops = await handler.resolve(id, 'keep_local');
    expect(ops.map((o) => o.kind)).toEqual(['recycle_local', 'trash_remote', 'move_remote', 'move_local']);
    await h.execute({ operations: ops } as Plan);
    await settleWithConflicts();
    expect([...h.localFiles().entries()]).toEqual([['doc.md', 'local edit']]);
    expect(h.recycledContents()).toEqual(['remote edit']);
    expect(h.remoteTrashedContents()).toEqual(['remote edit']);
    sameOnBothSides();
    h.assertBaselineConsistent();
  });

  it('keep_both leaves both files synced as independent items', async () => {
    const { id, copy } = await contentConflict();
    const ops = await handler.resolve(id, 'keep_both');
    expect(ops).toEqual([]);
    await settleWithConflicts();
    expect(h.localFiles().size).toBe(2);
    expect(h.localFiles().has(copy)).toBe(true);
    expect(new ConflictRepo(h.store).open()).toEqual([]);
    await expect(handler.resolve(id, 'keep_both')).rejects.toThrow(/already resolved/);
    sameOnBothSides();
  });
});

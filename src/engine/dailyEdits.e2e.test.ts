import { mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineHarness } from '../testing/engineHarness.js';

/**
 * End-to-end scenarios against the fakes: the whole engine (watcher, feed,
 * reconciler, safety gate, executor, conflict handler) with a real temp
 * directory and the in-memory remote.
 */

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  h.assertNoUserContentLost();
  await h.dispose();
});

function sameSides(): void {
  expect([...h.localFiles().entries()].sort()).toEqual([...h.remoteFiles().entries()].sort());
}

describe('end-to-end scenarios', () => {
  it('rename storm: many quick renames converge to the final names without data loss', async () => {
    for (let i = 0; i < 20; i++) h.write(`storm/f${String(i)}.txt`, `content ${String(i)}`);
    await h.start();
    await h.waitForConvergence();
    // Rename every file several times in quick succession.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) {
        const from = path.join(h.root, 'storm', round === 0 ? `f${String(i)}.txt` : `r${String(round - 1)}-${String(i)}.txt`);
        renameSync(from, path.join(h.root, 'storm', `r${String(round)}-${String(i)}.txt`));
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    await h.waitForConvergence(15_000);
    sameSides();
    const names = [...h.localFiles().keys()].sort();
    expect(names).toHaveLength(20);
    expect(names.every((n) => /^storm\/r2-\d+\.txt$/.test(n))).toBe(true);
    for (let i = 0; i < 20; i++) expect(h.remoteFiles().get(`storm/r2-${String(i)}.txt`)).toBe(`content ${String(i)}`);
    // Renames were moves, not re-uploads: the remote still has 20 file nodes and nothing in the trash.
    expect(h.fake.trashedUids()).toEqual([]);
    expect(h.fake.allNodes().filter((n) => n.type === 'file')).toHaveLength(20);
  });

  it('folder move with 1000 files is a single remote move and no re-transfer', async () => {
    for (let i = 0; i < 1000; i++) h.write(`big/${String(Math.floor(i / 50))}/file-${String(i)}.txt`, `payload ${String(i)}`);
    await h.start();
    await h.waitForConvergence(60_000);
    const uploadsBefore = h.fake.calls.filter((c) => c.op === 'upload').length;
    expect(uploadsBefore).toBe(1000);
    renameSync(path.join(h.root, 'big'), path.join(h.root, 'moved'));
    await h.waitForConvergence(60_000);
    sameSides();
    expect(h.localFiles().size).toBe(1000);
    expect([...h.remoteFiles().keys()].every((k) => k.startsWith('moved/'))).toBe(true);
    expect(h.fake.calls.filter((c) => c.op === 'upload').length).toBe(uploadsBefore);
    expect(h.fake.calls.filter((c) => c.op === 'download')).toHaveLength(0);
    expect(h.fake.trashedUids()).toEqual([]);
  }, 180_000);

  it('offline edits on both sides while stopped are merged on restart: one-sided changes propagate, same-file edits become conflicts', async () => {
    h.write('a.txt', 'A');
    h.write('b.txt', 'B');
    h.write('c.txt', 'C');
    await h.start();
    await h.waitForConvergence();
    await h.bundle?.engine.stop();
    // "Offline": local edits a and deletes b; remote edits c and creates d; both edit e... (e does not exist yet) -> both edit a differently.
    h.write('a.txt', 'A local');
    rmSync(path.join(h.root, 'b.txt'));
    h.fake.seedRevision(h.remotePathToUid('a.txt') ?? '', 'A remote');
    h.fake.seedRevision(h.remotePathToUid('c.txt') ?? '', 'C2');
    h.fake.seedFile(h.remoteRootUid, 'd.txt', 'D');
    await h.restart();
    await h.waitForConvergence(15_000);
    const local = h.localFiles();
    expect(local.get('c.txt')).toBe('C2');
    expect(local.get('d.txt')).toBe('D');
    expect(local.has('b.txt')).toBe(false);
    expect(h.fake.trashedUids()).toHaveLength(1); // b trashed remotely
    // a: conflict -> both versions kept.
    expect(local.get('a.txt')).toBe('A remote');
    expect([...local.keys()].filter((k) => k.includes('.conflict-'))).toHaveLength(1);
    expect([...local.values()]).toContain('A local');
    sameSides();
    expect(h.bundle?.controlTarget.listConflicts().map((c) => c.kind)).toEqual(['content']);
  });

  it('clock skew: a file whose mtime jumps backwards or far forwards without content change is not re-transferred', async () => {
    h.write('skew.txt', 'same content');
    await h.start();
    await h.waitForConvergence();
    const transfersBefore = h.fake.calls.filter((c) => c.op === 'upload' || c.op === 'download').length;
    const past = new Date('2001-01-01T00:00:00Z');
    utimesSync(path.join(h.root, 'skew.txt'), past, past);
    await new Promise((r) => setTimeout(r, 500));
    await h.bundle?.engine.syncNow();
    await h.waitForConvergence();
    const future = new Date('2040-01-01T00:00:00Z');
    utimesSync(path.join(h.root, 'skew.txt'), future, future);
    await new Promise((r) => setTimeout(r, 500));
    await h.bundle?.engine.syncNow();
    await h.waitForConvergence();
    expect(h.fake.calls.filter((c) => c.op === 'upload' || c.op === 'download').length).toBe(transfersBefore);
    expect(h.remoteFiles().get('skew.txt')).toBe('same content');
  });

  it('case collision: remote siblings differing only by case are blocked, everything else syncs', async () => {
    h.fake.seedFile(h.remoteRootUid, 'Readme.md', 'upper');
    h.fake.seedFile(h.remoteRootUid, 'readme.md', 'lower');
    h.fake.seedFile(h.remoteRootUid, 'other.txt', 'ok');
    await h.start();
    await h.waitFor(['idle', 'attention']);
    for (let i = 0; i < 50 && !h.localFiles().has('other.txt'); i++) await new Promise((r) => setTimeout(r, 30));
    expect(h.localFiles().get('other.txt')).toBe('ok');
    expect(h.localFiles().has('Readme.md')).toBe(false);
    expect(h.localFiles().has('readme.md')).toBe(false);
    const blocked = h.audit.readAll().entries.filter((e) => e.op === 'blocked' && e.message.includes('case'));
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(h.fake.trashedUids()).toEqual([]);
  });

  it('changes made remotely by another client (create, edit, rename, folder move, trash) arrive through the event feed', async () => {
    h.write('mine.txt', 'M');
    await h.start();
    await h.waitForConvergence();
    const folder = h.fake.seedFolder(h.remoteRootUid, 'cli-made');
    h.fake.seedFile(folder.uid, 'x.txt', 'X');
    await h.waitForConvergence();
    expect(h.localFiles().get('cli-made/x.txt')).toBe('X');
    h.fake.seedRevision(h.remotePathToUid('cli-made/x.txt') ?? '', 'X2');
    await h.waitForConvergence();
    expect(h.localFiles().get('cli-made/x.txt')).toBe('X2');
    await h.fake.rename(h.remotePathToUid('cli-made/x.txt') ?? '', 'y.txt');
    await h.waitForConvergence();
    expect(h.localFiles().has('cli-made/y.txt')).toBe(true);
    await h.fake.rename(folder.uid, 'renamed-folder');
    await h.waitForConvergence();
    expect(h.localFiles().get('renamed-folder/y.txt')).toBe('X2');
    await h.fake.trash([h.remotePathToUid('renamed-folder/y.txt') ?? '']);
    await h.waitForConvergence();
    expect(h.localFiles().has('renamed-folder/y.txt')).toBe(false);
    // Recycled: the previous local version of x.txt (replaced by X2) and the trashed y.txt.
    expect(h.bundle?.recycle.list().filter((r) => r.kind === 'file').map((r) => r.relPath).sort()).toEqual(['cli-made/x.txt', 'renamed-folder/y.txt']);
    sameSides();
    // The original local file was never touched.
    expect(h.localFiles().get('mine.txt')).toBe('M');
    expect(readdirSync(path.join(h.root, '.proton-sync', 'tmp'))).toEqual([]);
  });

  it('a live edit of the same file on both sides while running becomes a conflict, not an overwrite', async () => {
    h.write('shared.txt', 'original');
    await h.start();
    await h.waitForConvergence();

    // Edit the same file on both sides at once, while the engine is running.
    h.write('shared.txt', 'local edit');
    h.fake.seedRevision(h.remotePathToUid('shared.txt') ?? '', 'remote edit');
    await h.bundle?.engine.syncNow();
    await h.waitForConvergence(15_000);

    // Neither edit silently overwrote the other: one stays at the path, the other is kept beside it.
    const local = h.localFiles();
    const values = [...local.values()];
    expect(values, 'the local edit must survive').toContain('local edit');
    expect(values, 'the remote edit must survive').toContain('remote edit');
    expect([...local.keys()].filter((k) => k.includes('.conflict-')), 'a conflict copy is kept').toHaveLength(1);
    expect(h.bundle?.controlTarget.listConflicts().map((c) => c.kind)).toEqual(['content']);
    expect(h.fake.trashedUids()).toEqual([]);
    sameSides();
  });

  it('a nested tree created while running, then partially deleted locally, converges with recycled nothing and trashed exactly the deleted files', async () => {
    await h.start();
    await h.waitFor(['idle']);
    mkdirSync(path.join(h.root, 'tree', 'a', 'b'), { recursive: true });
    writeFileSync(path.join(h.root, 'tree', 'a', 'b', 'deep.txt'), 'deep');
    writeFileSync(path.join(h.root, 'tree', 'a', 'mid.txt'), 'mid');
    writeFileSync(path.join(h.root, 'tree', 'top.txt'), 'top');
    await h.waitForConvergence();
    expect(h.remoteFiles().size).toBe(3);
    rmSync(path.join(h.root, 'tree', 'a'), { recursive: true });
    await h.waitForConvergence();
    expect([...h.remoteFiles().keys()]).toEqual(['tree/top.txt']);
    expect(h.fake.trashedUids().length).toBeGreaterThanOrEqual(1);
    expect(h.bundle?.recycle.list()).toEqual([]);
  });
});

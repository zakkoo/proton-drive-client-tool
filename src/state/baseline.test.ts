import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BaselineRepo, type BaselineRow } from './baseline.ts';
import { StateStore } from './store.ts';

let dir: string;
let file: string;
let store: StateStore | null;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-baseline-'));
  file = path.join(dir, 'state.db');
  store = StateStore.open(file);
});
afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<BaselineRow> & { relPath: string; nodeUid: string }): BaselineRow {
  return {
    kind: 'file',
    localDev: 1,
    localIno: 100,
    localSize: 10,
    localMtimeMs: 1000,
    localSha1: 'a'.repeat(40),
    parentUid: 'root',
    remoteName: path.basename(over.relPath),
    revisionUid: 'rev-1',
    remoteSha1: 'a'.repeat(40),
    syncedAt: 1,
    ...over,
  };
}

describe('BaselineRepo', () => {
  it('upserts and looks up the same record by path, inode and node uid', () => {
    if (store === null) throw new Error('store');
    const repo = new BaselineRepo(store);
    repo.upsert(row({ relPath: 'docs/a.txt', nodeUid: 'n1', localIno: 42 }));
    const byPath = repo.byPath('docs/a.txt');
    expect(byPath?.nodeUid).toBe('n1');
    expect(repo.byNodeUid('n1')).toEqual(byPath);
    expect(repo.byInode(1, 42)).toEqual([byPath]);
    expect(repo.byPath('missing')).toBeNull();
    expect(repo.count()).toBe(1);
  });

  it('counts files and folders separately, and the two totals add up to count()', () => {
    if (store === null) throw new Error('store');
    const repo = new BaselineRepo(store);
    repo.upsert(row({ relPath: 'src', nodeUid: 'd1', kind: 'dir' }));
    repo.upsert(row({ relPath: 'src/a.txt', nodeUid: 'f1', parentUid: 'd1' }));
    repo.upsert(row({ relPath: 'b.txt', nodeUid: 'f2' }));
    const kinds = repo.countByKind();
    expect(kinds).toEqual({ file: 2, dir: 1 });
    expect(kinds.file + kinds.dir).toBe(repo.count());
    expect(repo.filePaths()).toEqual(['b.txt', 'src/a.txt']);
  });

  it('never links one identity to two rows: replacing a path or a node uid removes the stale row', () => {
    if (store === null) throw new Error('store');
    const repo = new BaselineRepo(store);
    repo.upsert(row({ relPath: 'a.txt', nodeUid: 'n1' }));
    // Same node uid now lives at a different path (remote rename observed).
    repo.upsert(row({ relPath: 'b.txt', nodeUid: 'n1' }));
    expect(repo.byPath('a.txt')).toBeNull();
    expect(repo.byNodeUid('n1')?.relPath).toBe('b.txt');
    // Same path now maps to a different node (replaced remotely).
    repo.upsert(row({ relPath: 'b.txt', nodeUid: 'n2' }));
    expect(repo.byNodeUid('n1')).toBeNull();
    expect(repo.byPath('b.txt')?.nodeUid).toBe('n2');
    expect(repo.count()).toBe(1);
  });

  it('renames a directory subtree atomically and removes subtrees', () => {
    if (store === null) throw new Error('store');
    const repo = new BaselineRepo(store);
    repo.upsert(row({ relPath: 'src', nodeUid: 'd1', kind: 'dir' }));
    repo.upsert(row({ relPath: 'src/a.txt', nodeUid: 'f1', parentUid: 'd1' }));
    repo.upsert(row({ relPath: 'src/deep', nodeUid: 'd2', kind: 'dir', parentUid: 'd1' }));
    repo.upsert(row({ relPath: 'src/deep/b.txt', nodeUid: 'f2', parentUid: 'd2' }));
    repo.upsert(row({ relPath: 'srcfile.txt', nodeUid: 'f3' })); // shares the prefix but is not inside
    repo.rename('src', 'lib');
    expect(repo.all().map((r) => r.relPath)).toEqual(['lib', 'lib/a.txt', 'lib/deep', 'lib/deep/b.txt', 'srcfile.txt']);
    expect(repo.byNodeUid('f2')?.relPath).toBe('lib/deep/b.txt');
    expect(repo.removeSubtree('lib/deep')).toBe(2);
    expect(repo.all().map((r) => r.relPath)).toEqual(['lib', 'lib/a.txt', 'srcfile.txt']);
  });
});

describe('BaselineRepo under crash injection (separate process killed mid-write)', () => {
  const child = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'crashChild.ts');
  const OLD = row({ relPath: 'victim.txt', nodeUid: 'victim', localSize: 10, localMtimeMs: 1000, localSha1: 'o'.repeat(40), revisionUid: 'rev-old', remoteSha1: 'o'.repeat(40) });

  function runChild(mode: string): string {
    if (store === null) throw new Error('store');
    new BaselineRepo(store).upsert(OLD);
    store.close(); // release the lock for the child
    store = null;
    const result = spawnSync(process.execPath, [child, file, mode], { encoding: 'utf8', timeout: 20_000 });
    // SIGKILL is the expected end of the child in both modes.
    expect(result.signal).toBe('SIGKILL');
    if (existsSync(`${file}.lock`)) unlinkSync(`${file}.lock`);
    store = StateStore.open(file);
    return result.stdout;
  }

  function victim(): BaselineRow | null {
    if (store === null) throw new Error('store');
    return new BaselineRepo(store).byPath('victim.txt');
  }

  it('killed inside the transaction: the old row is intact in every column', () => {
    const out = runChild('kill-mid-transaction');
    expect(out).toContain('killing mid-transaction');
    expect(victim()).toEqual(OLD);
  });

  it('killed right after commit: the new row is complete in every column', () => {
    const out = runChild('kill-after-commit');
    expect(out).toContain('committed');
    const v = victim();
    expect(v).toMatchObject({ localSize: 999, localMtimeMs: 999_999, localSha1: 'new-sha1-new-sha1-new-sha1-new-sha1-new0', revisionUid: 'rev-new' });
  });
});

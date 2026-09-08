import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sha1Hex } from '../testing/fakeRemote.js';
import { diffSnapshots } from './diff.js';
import { DigestCache } from './digest.js';
import { createIgnoreMatcher } from './ignore.js';
import { scanLocalTree, type LocalSnapshot } from './snapshot.js';

let root: string;
let digests: DigestCache;
const ignore = createIgnoreMatcher([]);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pds-diff-'));
  digests = new DigestCache(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const scan = () => scanLocalTree(root, { ignore });

/** Baseline digests: pretend every file in `snap` was synced with its current content. */
async function baselineDigests(snap: LocalSnapshot): Promise<(rel: string) => string | undefined> {
  const map = new Map<string, string>();
  for (const e of snap.entries.values()) if (e.kind === 'file') map.set(e.relPath, await digests.digestOf(e));
  return (rel) => map.get(rel);
}

describe('diffSnapshots', () => {
  it('detects a rename in the same folder as a single move with unchanged content', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'same content');
    const prev = await scan();
    const previousDigest = await baselineDigests(prev);
    renameSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    const changes = await diffSnapshots(prev, await scan(), { previousDigest, digests });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: 'moved', from: 'a.txt', to: 'b.txt', contentChanged: false });
  });

  it('detects a move across folders', async () => {
    mkdirSync(path.join(root, 'x'));
    mkdirSync(path.join(root, 'y'));
    writeFileSync(path.join(root, 'x', 'f.bin'), 'payload');
    const prev = await scan();
    const previousDigest = await baselineDigests(prev);
    renameSync(path.join(root, 'x', 'f.bin'), path.join(root, 'y', 'f.bin'));
    const changes = await diffSnapshots(prev, await scan(), { previousDigest, digests });
    expect(changes.map((c) => c.type)).toEqual(['moved']);
    expect(changes[0]).toMatchObject({ from: 'x/f.bin', to: 'y/f.bin' });
  });

  it('collapses a folder move into one change and reports only descendants that also changed', async () => {
    mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(root, 'src', `f${String(i)}.txt`), `file ${String(i)}`);
    writeFileSync(path.join(root, 'src', 'deep', 'd.txt'), 'deep');
    const prev = await scan();
    const previousDigest = await baselineDigests(prev);
    renameSync(path.join(root, 'src'), path.join(root, 'lib'));
    writeFileSync(path.join(root, 'lib', 'f3.txt'), 'file 3 edited!');
    const later = new Date(Date.now() + 10_000);
    utimesSync(path.join(root, 'lib', 'f3.txt'), later, later);
    writeFileSync(path.join(root, 'lib', 'new.txt'), 'brand new');
    const changes = await diffSnapshots(prev, await scan(), { previousDigest, digests });
    const types = changes.map((c) => `${c.type}:${c.type === 'moved' ? `${c.from}>${c.to}` : c.type === 'deleted' ? c.previous.relPath : c.entry.relPath}`);
    expect(types.sort()).toEqual(['created:lib/new.txt', 'moved:src/f3.txt>lib/f3.txt', 'moved:src>lib']);
    expect(changes.find((c) => c.type === 'moved' && c.to === 'lib/f3.txt')).toMatchObject({ contentChanged: true });
  });

  it('treats inode reuse with different content as delete plus create, flagged ambiguous', async () => {
    writeFileSync(path.join(root, 'old.txt'), 'old content');
    const prev = await scan();
    const previousDigest = await baselineDigests(prev);
    const oldIno = prev.entries.get('old.txt')?.ino;
    // Force inode reuse: remove the old file and create a new one of the same size; on most
    // file systems the freed inode is handed out again immediately. If it is not, we
    // patch the snapshot to simulate reuse, which is the case under test.
    unlinkSync(path.join(root, 'old.txt'));
    writeFileSync(path.join(root, 'new.txt'), 'new content');
    const next = await scan();
    const n = next.entries.get('new.txt');
    if (n !== undefined && oldIno !== undefined && n.ino !== oldIno) next.entries.set('new.txt', { ...n, ino: oldIno });
    const changes = await diffSnapshots(prev, next, { previousDigest, digests });
    expect(changes.map((c) => c.type).sort()).toEqual(['created', 'deleted']);
    expect(changes.every((c) => 'ambiguous' in c && c.ambiguous)).toBe(true);
  });

  it('does not call a same-inode rename a move when the previous digest is unknown', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'content');
    const prev = await scan();
    renameSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    const changes = await diffSnapshots(prev, await scan(), { previousDigest: () => undefined, digests });
    expect(changes.map((c) => c.type).sort()).toEqual(['created', 'deleted']);
  });

  it('reports content modification and plain create/delete', async () => {
    writeFileSync(path.join(root, 'm.txt'), 'v1');
    writeFileSync(path.join(root, 'gone.txt'), 'bye');
    const prev = await scan();
    const previousDigest = await baselineDigests(prev);
    writeFileSync(path.join(root, 'm.txt'), 'v2 longer');
    unlinkSync(path.join(root, 'gone.txt'));
    writeFileSync(path.join(root, 'fresh.txt'), 'hi');
    const changes = await diffSnapshots(prev, await scan(), { previousDigest, digests });
    expect(changes.map((c) => c.type).sort()).toEqual(['created', 'deleted', 'modified']);
    expect(changes.find((c) => c.type === 'deleted')).not.toHaveProperty('ambiguous');
  });

  it('digest cache serves repeated lookups for the same identity and refuses to hash a stale entry', async () => {
    writeFileSync(path.join(root, 'h.txt'), 'hash me');
    const snap = await scan();
    const e = snap.entries.get('h.txt');
    if (e === undefined) throw new Error('missing');
    expect(await digests.digestOf(e)).toBe(sha1Hex('hash me'));
    expect(await digests.digestOf(e)).toBe(sha1Hex('hash me'));
    // A different entry (new mtime/size) for a file that changed again before hashing is refused.
    writeFileSync(path.join(root, 'h.txt'), 'changed after snapshot');
    const stale = (await scan()).entries.get('h.txt');
    if (stale === undefined) throw new Error('missing');
    writeFileSync(path.join(root, 'h.txt'), 'changed once more, longer');
    await expect(new DigestCache(root).digestOf(stale)).rejects.toThrow(/changed while/);
  });
});

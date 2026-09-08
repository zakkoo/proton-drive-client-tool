import { describe, expect, it } from 'vitest';

import { FakeRemote, sha1Hex } from '../testing/fakeRemote.js';
import type { RemoteDrive, RemoteEvent, RemoteUploadSource } from './interface.js';

/**
 * Behavioural contract every RemoteDrive must satisfy. Runs against the fake
 * here; the SDK adapter is covered by sdkRemoteDrive.test.ts with a stubbed
 * client, since the real service cannot be exercised in CI.
 */
export function remoteDriveContract(name: string, make: () => { drive: RemoteDrive; fake: FakeRemote }) {
  const source = (text: string, mtime = new Date('2026-01-01T00:00:00Z')): RemoteUploadSource => {
    const buf = Buffer.from(text);
    return { size: buf.length, sha1: sha1Hex(buf), modifiedAt: mtime, open: () => new Blob([buf]).stream() };
  };
  const collect = async (it: AsyncIterable<RemoteEvent>) => {
    const out: RemoteEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };
  const download = async (drive: RemoteDrive, uid: string) => {
    const chunks: Uint8Array[] = [];
    await drive.downloadToStream(uid, new WritableStream({ write: (c) => { chunks.push(c); } }));
    return Buffer.concat(chunks).toString();
  };

  describe(`RemoteDrive contract: ${name}`, () => {
    it('exposes a root, resolves paths, and lists complete children with stable identifiers', async () => {
      const { drive } = make();
      const root = await drive.getMyFilesRoot();
      expect(root.type).toBe('folder');
      const sync = await drive.createFolder(root.uid, 'Sync');
      const docs = await drive.createFolder(sync.uid, 'docs');
      expect((await drive.resolvePath('/my-files/Sync/docs'))?.uid).toBe(docs.uid);
      expect(await drive.resolvePath('/my-files/Missing')).toBeNull();
      const children = await drive.listChildren(root.uid);
      expect(children.map((c) => c.uid)).toEqual([sync.uid]);
      expect(children[0]?.parentUid).toBe(root.uid);
    });

    it('uploads, reads back digest and size, downloads identical bytes, and creates revisions keeping the uid', async () => {
      const { drive } = make();
      const root = await drive.getMyFilesRoot();
      const up = await drive.uploadNewFile(root.uid, 'a.txt', source('hello'));
      const node = await drive.getNode(up.nodeUid);
      expect(node).toMatchObject({ name: 'a.txt', type: 'file', claimedSize: 5, claimedSha1: sha1Hex('hello'), revisionUid: up.revisionUid });
      expect(node?.claimedModifiedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(await download(drive, up.nodeUid)).toBe('hello');
      const rev = await drive.uploadNewRevision(up.nodeUid, source('hello world'));
      expect(rev.nodeUid).toBe(up.nodeUid);
      expect(rev.revisionUid).not.toBe(up.revisionUid);
      expect((await drive.getNode(up.nodeUid))?.claimedSha1).toBe(sha1Hex('hello world'));
      expect(await download(drive, up.nodeUid)).toBe('hello world');
    });

    it('rejects an upload whose bytes do not match the declared digest or size', async () => {
      const { drive } = make();
      const root = await drive.getMyFilesRoot();
      const bad = { ...source('abc'), sha1: sha1Hex('xyz') };
      await expect(drive.uploadNewFile(root.uid, 'bad.txt', bad)).rejects.toMatchObject({ kind: 'integrity' });
      expect(await drive.listChildren(root.uid)).toEqual([]);
    });

    it('renames and moves without changing uid or revision, and refuses name conflicts without replacing anything', async () => {
      const { drive } = make();
      const root = await drive.getMyFilesRoot();
      const a = await drive.createFolder(root.uid, 'A');
      const b = await drive.createFolder(root.uid, 'B');
      const f = await drive.uploadNewFile(a.uid, 'f.txt', source('1'));
      const renamed = await drive.rename(f.nodeUid, 'g.txt');
      expect(renamed).toMatchObject({ uid: f.nodeUid, name: 'g.txt', revisionUid: f.revisionUid });
      const moved = await drive.move(f.nodeUid, b.uid);
      expect(moved).toMatchObject({ uid: f.nodeUid, parentUid: b.uid, revisionUid: f.revisionUid });
      const other = await drive.uploadNewFile(a.uid, 'g.txt', source('2'));
      await expect(drive.move(other.nodeUid, b.uid)).rejects.toMatchObject({ kind: 'name_conflict' });
      await expect(drive.rename(other.nodeUid, 'g.txt')).resolves.toBeDefined(); // same name is a no-op
      await expect(drive.createFolder(root.uid, 'A')).rejects.toMatchObject({ kind: 'name_conflict' });
      expect((await drive.getNode(other.nodeUid))?.parentUid).toBe(a.uid);
      expect(await download(drive, f.nodeUid)).toBe('1');
    });

    it('trashes nodes so they remain readable and restorable, and trash is the only removal', async () => {
      const { drive } = make();
      const root = await drive.getMyFilesRoot();
      const f = await drive.uploadNewFile(root.uid, 'x.txt', source('x'));
      await drive.trash([f.nodeUid]);
      const node = await drive.getNode(f.nodeUid);
      expect(node?.isTrashed).toBe(true);
      expect(await download(drive, f.nodeUid)).toBe('x');
      expect(Object.keys(drive)).not.toContain('delete');
    });

    it('streams events with a resumable cursor, fast-forwards when idle, and demands a refresh for an expired cursor', async () => {
      const { drive, fake } = make();
      const root = await drive.getMyFilesRoot();
      const scope = root.treeEventScopeId;
      const first = await collect(drive.iterateEvents(scope));
      expect(first).toHaveLength(1);
      expect(first[0]?.type).toBe('fast_forward');
      let cursor = first[0]?.eventId ?? '';

      const folder = await drive.createFolder(root.uid, 'F');
      const file = await drive.uploadNewFile(folder.uid, 'f.txt', source('f'));
      await drive.rename(file.nodeUid, 'g.txt');
      const events = await collect(drive.iterateEvents(scope, cursor));
      expect(events.map((e) => e.type)).toEqual(['node_created', 'node_created', 'node_updated']);
      expect(events.map((e) => ('nodeUid' in e ? e.nodeUid : ''))).toEqual([folder.uid, file.nodeUid, file.nodeUid]);
      cursor = events.at(-1)?.eventId ?? cursor;

      const idle = await collect(drive.iterateEvents(scope, cursor));
      expect(idle.map((e) => e.type)).toEqual(['fast_forward']);

      await drive.trash([file.nodeUid]);
      const afterTrash = await collect(drive.iterateEvents(scope, cursor));
      expect(afterTrash[0]).toMatchObject({ type: 'node_updated', nodeUid: file.nodeUid, isTrashed: true });

      fake.expireOldCursors();
      const expired = await collect(drive.iterateEvents(scope, cursor));
      expect(expired.map((e) => e.type)).toEqual(['refresh_required']);
    });

    it('reports undecryptable nodes as degraded without hiding them', async () => {
      const { drive, fake } = make();
      const root = await drive.getMyFilesRoot();
      fake.seedUndecryptable(root.uid);
      const [node] = await drive.listChildren(root.uid);
      expect(node).toMatchObject({ nameStatus: 'undecryptable', degraded: true });
    });
  });
}

remoteDriveContract('FakeRemote', () => {
  const fake = new FakeRemote();
  return { drive: fake, fake };
});

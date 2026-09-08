import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeRemote, sha1Hex } from '../testing/fakeRemote.js';
import { downloadVerified, sha1File, uploadVerified } from './transfer.js';

let dir: string;
let fake: FakeRemote;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-transfer-'));
  fake = new FakeRemote();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('downloadVerified', () => {
  it('writes to the temp path and reports a verified digest when it matches the claim', async () => {
    const node = fake.seedFile(fake.rootUid, 'a.bin', 'payload-bytes');
    const tmp = path.join(dir, 'tmp-1');
    const result = await downloadVerified(fake, node, tmp);
    expect(result).toEqual({ sha1: sha1Hex('payload-bytes'), size: 13, verifiedAgainstClaim: true });
    expect(readFileSync(tmp, 'utf8')).toBe('payload-bytes');
  });

  it('discards the temp file and fails with an integrity error on digest mismatch', async () => {
    const node = fake.seedFile(fake.rootUid, 'a.bin', 'payload-bytes');
    fake.injectFault('download', { kind: 'corrupt_download' });
    const tmp = path.join(dir, 'tmp-2');
    await expect(downloadVerified(fake, node, tmp)).rejects.toMatchObject({ kind: 'integrity' });
    expect(existsSync(tmp)).toBe(false);
  });

  it('flags a download without a remote digest claim as unverified but keeps the content', async () => {
    const node = fake.seedFile(fake.rootUid, 'legacy.bin', 'old-client', { claimedSha1: null });
    const tmp = path.join(dir, 'tmp-3');
    const result = await downloadVerified(fake, node, tmp);
    expect(result.verifiedAgainstClaim).toBe(false);
    expect(result.sha1).toBe(sha1Hex('old-client'));
    expect(existsSync(tmp)).toBe(true);
  });

  it('removes the temp file and surfaces a retryable error when the transfer is interrupted', async () => {
    const node = fake.seedFile(fake.rootUid, 'a.bin', 'payload');
    fake.injectFault('download', { kind: 'connection' });
    const tmp = path.join(dir, 'tmp-4');
    await expect(downloadVerified(fake, node, tmp)).rejects.toMatchObject({ kind: 'connection', retryable: true });
    expect(existsSync(tmp)).toBe(false);
  });

  it('refuses to overwrite an existing temp path and refuses folders and Proton documents', async () => {
    const node = fake.seedFile(fake.rootUid, 'a.bin', 'payload');
    const tmp = path.join(dir, 'exists');
    writeFileSync(tmp, 'do not touch');
    await expect(downloadVerified(fake, node, tmp)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(tmp, 'utf8')).toBe('do not touch');
    const folder = fake.seedFolder(fake.rootUid, 'd');
    await expect(downloadVerified(fake, folder, path.join(dir, 'tmp-5'))).rejects.toMatchObject({ kind: 'validation' });
    await expect(downloadVerified(fake, { ...node, isProtonDocument: true }, path.join(dir, 'tmp-6'))).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('uploadVerified', () => {
  it('uploads a new file with mtime and digest and confirms the remote revision', async () => {
    const file = path.join(dir, 'up.txt');
    writeFileSync(file, 'upload me');
    const mtime = new Date('2026-04-01T12:00:00Z');
    utimesSync(file, mtime, mtime);
    const result = await uploadVerified(fake, { kind: 'new', parentUid: fake.rootUid, name: 'up.txt' }, file);
    expect(result.sha1).toBe(sha1Hex('upload me'));
    expect(result.size).toBe(9);
    const node = fake.record(result.nodeUid);
    expect(node?.claimedSha1).toBe(result.sha1);
    expect(node?.claimedModifiedAt?.toISOString()).toBe(mtime.toISOString());
    expect(fake.contentOf(result.nodeUid)?.toString()).toBe('upload me');
  });

  it('uploads a new revision preserving the node uid', async () => {
    const existing = fake.seedFile(fake.rootUid, 'r.txt', 'v1');
    const file = path.join(dir, 'r.txt');
    writeFileSync(file, 'v2');
    const result = await uploadVerified(fake, { kind: 'revision', nodeUid: existing.uid }, file);
    expect(result.nodeUid).toBe(existing.uid);
    expect(result.revisionUid).not.toBe(existing.revisionUid);
    expect(fake.contentOf(existing.uid)?.toString()).toBe('v2');
  });

  it('fails post-upload verification when the remote reports a different digest', async () => {
    const file = path.join(dir, 'm.txt');
    writeFileSync(file, 'mismatch');
    fake.injectFault('upload', { kind: 'mismatch_upload' });
    await expect(uploadVerified(fake, { kind: 'new', parentUid: fake.rootUid, name: 'm.txt' }, file)).rejects.toMatchObject({ kind: 'integrity' });
  });

  it('surfaces an interrupted upload as retryable without creating a node', async () => {
    const file = path.join(dir, 'i.txt');
    writeFileSync(file, 'interrupted');
    fake.injectFault('upload', { kind: 'connection' });
    await expect(uploadVerified(fake, { kind: 'new', parentUid: fake.rootUid, name: 'i.txt' }, file)).rejects.toMatchObject({ kind: 'connection', retryable: true });
    expect(fake.allNodes().filter((n) => n.name === 'i.txt')).toEqual([]);
  });

  it('reports an unknown outcome as retryable even though the server committed (caller must re-read before retrying)', async () => {
    const file = path.join(dir, 'u.txt');
    writeFileSync(file, 'unknown');
    fake.injectFault('upload', { kind: 'unknown_outcome' });
    await expect(uploadVerified(fake, { kind: 'new', parentUid: fake.rootUid, name: 'u.txt' }, file)).rejects.toMatchObject({ kind: 'connection', retryable: true });
    expect(fake.allNodes().filter((n) => n.name === 'u.txt')).toHaveLength(1);
  });

  it('rejects the upload when the local file changed while it was being sent', async () => {
    const file = path.join(dir, 'c.txt');
    writeFileSync(file, 'original');
    fake.beforeUploadCommit = () => {
      writeFileSync(file, 'changed!!');
      const later = new Date(Date.now() + 5000);
      utimesSync(file, later, later);
      return Promise.resolve();
    };
    await expect(uploadVerified(fake, { kind: 'new', parentUid: fake.rootUid, name: 'c.txt' }, file)).rejects.toMatchObject({ kind: 'validation', retryable: true });
  });

  it('sha1File streams the digest and size', async () => {
    const file = path.join(dir, 'h.bin');
    writeFileSync(file, Buffer.alloc(200_000, 7));
    const { sha1, size } = await sha1File(file);
    expect(size).toBe(200_000);
    expect(sha1).toBe(sha1Hex(Buffer.alloc(200_000, 7)));
  });
});

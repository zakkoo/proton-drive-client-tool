import { describe, expect, it } from 'vitest';
import {
  ConnectionError,
  DriveEventType,
  IntegrityError,
  MemberRole,
  NodeType,
  NodeWithSameNameExistsValidationError,
  RateLimitedError,
  RevisionState,
  ServerError,
  ValidationError,
  type NodeEntity,
  type NodeResult,
} from '@protontech/drive-sdk';

import { createLogger, silentSink } from './proton/logger.js';
import { RemoteError } from './interface.js';
import { SdkRemoteDrive, toRemoteError, toRemoteEvent, toRemoteNode, type SdkClient } from './sdkRemoteDrive.js';

const author = { ok: true as const, value: 'me@proton.test' };

function entity(over: Omit<Partial<NodeEntity>, 'parentUid'> & { uid: string; parentUid?: string | undefined }): NodeEntity {
  return {
    parentUid: 'root',
    name: { ok: true, value: over.uid },
    keyAuthor: author,
    nameAuthor: author,
    directRole: MemberRole.Admin,
    ownedBy: {},
    type: NodeType.File,
    isShared: false,
    isSharedByUrl: false,
    creationTime: new Date('2026-01-01T00:00:00Z'),
    modificationTime: new Date('2026-01-02T00:00:00Z'),
    treeEventScopeId: 'scope-a',
    ...over,
  } as NodeEntity;
}

function stub(over: Partial<SdkClient> = {}): SdkClient {
  const notImpl = (name: string) => () => {
    throw new Error(`${name} not stubbed`);
  };
  return {
    getMyFilesRootFolder: notImpl('getMyFilesRootFolder'),
    getNode: notImpl('getNode'),
    iterateFolderChildren: notImpl('iterateFolderChildren'),
    iterateNodes: notImpl('iterateNodes'),
    getFileDownloader: notImpl('getFileDownloader'),
    getFileUploader: notImpl('getFileUploader'),
    getFileRevisionUploader: notImpl('getFileRevisionUploader'),
    createFolder: notImpl('createFolder'),
    renameNode: notImpl('renameNode'),
    moveNodes: notImpl('moveNodes'),
    trashNodes: notImpl('trashNodes'),
    iterateEvents: notImpl('iterateEvents'),
    ...over,
  };
}

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) {
    await Promise.resolve();
    yield i;
  }
}

describe('toRemoteNode', () => {
  it('maps a healthy file with revision digest', () => {
    const n = toRemoteNode(
      entity({
        uid: 'f1',
        name: { ok: true, value: 'report.pdf' },
        mediaType: 'application/pdf',
        activeRevision: {
          uid: 'rev1',
          state: RevisionState.Active,
          creationTime: new Date(),
          contentAuthor: author,
          storageSize: 10,
          isImported: false,
          claimedSize: 8,
          claimedModificationTime: new Date('2026-01-03T00:00:00Z'),
          claimedDigests: { sha1: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', sha1Verified: true },
        },
      }),
    );
    expect(n).toMatchObject({
      uid: 'f1',
      parentUid: 'root',
      name: 'report.pdf',
      nameStatus: 'ok',
      type: 'file',
      isProtonDocument: false,
      isTrashed: false,
      claimedSize: 8,
      revisionUid: 'rev1',
      claimedSha1: 'abcdef0123456789abcdef0123456789abcdef01',
      sha1Verified: true,
      degraded: false,
    });
    expect(n.claimedModifiedAt?.toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });

  it('flags undecryptable and invalid names, trashed nodes, folders and Proton documents', () => {
    const bad = toRemoteNode(entity({ uid: 'x', name: { ok: false, error: new Error('cannot decrypt') } }));
    expect(bad.nameStatus).toBe('undecryptable');
    expect(bad.degraded).toBe(true);
    expect(bad.errors.join(' ')).toContain('cannot decrypt');
    const invalid = toRemoteNode(entity({ uid: 'y', name: { ok: false, error: { name: 'bad?name', error: 'invalid chars' } } }));
    expect(invalid).toMatchObject({ name: 'bad?name', nameStatus: 'invalid', degraded: true });
    const trashed = toRemoteNode(entity({ uid: 't', trashTime: new Date() }));
    expect(trashed.isTrashed).toBe(true);
    const folder = toRemoteNode(entity({ uid: 'd', type: NodeType.Folder, folder: { isImported: false, claimedModificationTime: new Date('2026-02-01T00:00:00Z') } }));
    expect(folder.type).toBe('folder');
    expect(folder.claimedModifiedAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    const doc = toRemoteNode(entity({ uid: 'p', mediaType: 'application/vnd.proton.doc' }));
    expect(doc.isProtonDocument).toBe(true);
    expect(toRemoteNode(entity({ uid: 'a', type: NodeType.Album })).type).toBe('other');
  });
});

describe('toRemoteEvent', () => {
  it('maps every SDK event type', () => {
    const base = { treeEventScopeId: 's', eventId: '7' };
    expect(toRemoteEvent({ ...base, type: DriveEventType.NodeCreated, nodeUid: 'n', parentNodeUid: 'p', isTrashed: false, isShared: false })).toEqual({
      type: 'node_created', nodeUid: 'n', parentUid: 'p', isTrashed: false, eventId: '7', scopeId: 's',
    });
    expect(toRemoteEvent({ ...base, type: DriveEventType.NodeUpdated, nodeUid: 'n', isTrashed: true, isShared: false })).toMatchObject({ type: 'node_updated', isTrashed: true, parentUid: undefined });
    expect(toRemoteEvent({ ...base, type: DriveEventType.NodeDeleted, nodeUid: 'n' })).toMatchObject({ type: 'node_deleted', nodeUid: 'n' });
    expect(toRemoteEvent({ ...base, type: DriveEventType.TreeRefresh }).type).toBe('refresh_required');
    expect(toRemoteEvent({ ...base, type: DriveEventType.FastForward }).type).toBe('fast_forward');
    expect(toRemoteEvent({ ...base, type: DriveEventType.TreeRemove, eventId: 'none' }).type).toBe('scope_removed');
  });
});

describe('toRemoteError', () => {
  it('classifies SDK errors with the right kind and retryability', () => {
    const cases: [unknown, string, boolean][] = [
      [new NodeWithSameNameExistsValidationError('exists', 2500, 'other-uid'), 'name_conflict', false],
      [new ValidationError('bad name'), 'validation', false],
      [new RateLimitedError('slow down'), 'rate_limited', true],
      [Object.assign(new ServerError('unauthorized'), { statusCode: 401 }), 'auth', false],
      [Object.assign(new ServerError('gone'), { statusCode: 404 }), 'not_found', false],
      [Object.assign(new ServerError('boom'), { statusCode: 502 }), 'server', true],
      [new ConnectionError('offline'), 'connection', true],
      [new IntegrityError('hash mismatch'), 'integrity', false],
      [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'connection', true],
      [new Error('weird'), 'unknown', false],
    ];
    for (const [error, kind, retryable] of cases) {
      const mapped = toRemoteError(error, 'ctx');
      expect(mapped).toBeInstanceOf(RemoteError);
      expect(mapped.kind, String(error)).toBe(kind);
      expect(mapped.retryable, String(error)).toBe(retryable);
      expect(mapped.message.startsWith('ctx:')).toBe(true);
    }
    const conflict = toRemoteError(new NodeWithSameNameExistsValidationError('exists', 2500, 'other-uid'), 'x');
    expect(conflict.details).toMatchObject({ existingNodeUid: 'other-uid' });
  });
});

describe('SdkRemoteDrive', () => {
  const logger = createLogger('t', silentSink);

  it('resolves paths by walking children, honouring escaped slashes and rejecting other sections', async () => {
    const root = entity({ uid: 'root', parentUid: undefined, type: NodeType.Folder, name: { ok: true, value: 'root' } });
    const sync = entity({ uid: 'sync', type: NodeType.Folder, name: { ok: true, value: 'Sync' } });
    const odd = entity({ uid: 'odd', parentUid: 'sync', type: NodeType.Folder, name: { ok: true, value: 'a/b' } });
    const trashedTwin = entity({ uid: 'twin', type: NodeType.Folder, name: { ok: true, value: 'Sync' }, trashTime: new Date() });
    const drive = new SdkRemoteDrive(
      stub({
        getMyFilesRootFolder: () => Promise.resolve(root),
        iterateFolderChildren: (parent) => gen(parent === 'root' ? [sync, trashedTwin] : parent === 'sync' ? [odd] : []),
      }),
      logger,
    );
    expect((await drive.resolvePath('/my-files'))?.uid).toBe('root');
    expect((await drive.resolvePath('/my-files/Sync'))?.uid).toBe('sync');
    expect((await drive.resolvePath('/my-files/Sync/a\\/b'))?.uid).toBe('odd');
    expect(await drive.resolvePath('/my-files/Nope')).toBeNull();
    await expect(drive.resolvePath('/shared-with-me/x')).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('returns null for a missing node and rethrows other failures; listing never returns partial results', async () => {
    const drive = new SdkRemoteDrive(
      stub({
        getNode: (uid) => Promise.reject(uid === 'missing' ? Object.assign(new ServerError('nf'), { statusCode: 404 }) : new ConnectionError('offline')),
        iterateFolderChildren: async function* () {
          await Promise.resolve();
          yield entity({ uid: 'c1' });
          throw new ConnectionError('dropped');
        },
      }),
      logger,
    );
    expect(await drive.getNode('missing')).toBeNull();
    await expect(drive.getNode('other')).rejects.toMatchObject({ kind: 'connection', retryable: true });
    await expect(drive.listChildren('root')).rejects.toMatchObject({ kind: 'connection' });
  });

  it('surfaces per-node failures from move and trash, and trashes without ever deleting', async () => {
    const results: NodeResult[] = [{ uid: 'a', ok: true }, { uid: 'b', ok: false, error: new NodeWithSameNameExistsValidationError('dup', 2500) }];
    let trashed: string[] = [];
    const drive = new SdkRemoteDrive(
      stub({
        moveNodes: () => gen(results),
        trashNodes: (uids) => {
          trashed = uids;
          return gen(uids.map((uid) => ({ uid, ok: true as const })));
        },
        getNode: (uid) => Promise.resolve(entity({ uid })),
      }),
      logger,
    );
    await expect(drive.move('b', 'p')).rejects.toMatchObject({ kind: 'name_conflict' });
    await drive.trash(['x', 'y']);
    expect(trashed).toEqual(['x', 'y']);
    await drive.trash([]);
  });

  it('passes upload metadata with size, sha1 and mtime and returns the new revision', async () => {
    let seen: unknown;
    const drive = new SdkRemoteDrive(
      stub({
        getFileUploader: (_parent, _name, metadata) => {
          seen = metadata;
          return Promise.resolve({
            uploadFromStream: () => Promise.resolve({ pause: () => undefined, resume: () => undefined, completion: () => Promise.resolve({ nodeUid: 'new', nodeRevisionUid: 'rev' }) }),
            uploadFromFile: () => Promise.reject(new Error('unused')),
          });
        },
      }),
      logger,
    );
    const mtime = new Date('2026-03-01T00:00:00Z');
    const result = await drive.uploadNewFile('p', 'f.bin', { size: 3, sha1: 'aaa', modifiedAt: mtime, open: () => new ReadableStream() });
    expect(result).toEqual({ nodeUid: 'new', revisionUid: 'rev' });
    expect(seen).toEqual({ mediaType: 'application/octet-stream', expectedSize: 3, expectedSha1: 'aaa', modificationTime: mtime });
  });
});

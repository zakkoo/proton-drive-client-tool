/**
 * Conversions from the store, the local snapshot and the remote listing into
 * the reconciler's plain input types.
 */
import type { DigestProvider } from '../local/digest.js';
import type { LocalSnapshot } from '../local/snapshot.js';
import type { BaselineItem, LocalItem, LocalView, RemoteItem, RemoteView } from '../reconcile/types.js';
import type { RemoteDrive, RemoteNode } from '../remote/interface.js';
import type { BaselineRow } from '../state/baseline.ts';

export function baselineRowToItem(row: BaselineRow): BaselineItem {
  return {
    relPath: row.relPath,
    kind: row.kind,
    syncedAt: row.syncedAt,
    local: { dev: row.localDev, ino: row.localIno, size: row.localSize, mtimeMs: row.localMtimeMs, sha1: row.localSha1 },
    remote: { uid: row.nodeUid, parentUid: row.parentUid, name: row.remoteName, revisionUid: row.revisionUid, sha1: row.remoteSha1 },
  };
}

export function remoteNodeToItem(node: RemoteNode): RemoteItem {
  return {
    uid: node.uid,
    parentUid: node.parentUid,
    name: node.name,
    kind: node.type === 'file' ? 'file' : node.type === 'folder' ? 'dir' : 'other',
    nameStatus: node.nameStatus,
    isTrashed: node.isTrashed,
    isProtonDocument: node.isProtonDocument,
    revisionUid: node.revisionUid,
    sha1: node.claimedSha1,
    size: node.claimedSize,
    mtimeMs: node.claimedModifiedAt?.getTime(),
  };
}

/**
 * Local view from a snapshot. Digests are attached for the files named in
 * `needDigest` (those whose stat differs from the baseline, or that have no
 * baseline), so the reconciler can decide by content.
 */
export async function localViewFromSnapshot(snapshot: LocalSnapshot, digests: DigestProvider, needDigest: (relPath: string) => boolean, available = true): Promise<LocalView> {
  const items = new Map<string, LocalItem>();
  for (const e of snapshot.entries.values()) {
    let sha1: string | undefined;
    if (e.kind === 'file' && needDigest(e.relPath)) {
      try {
        sha1 = await digests.digestOf(e);
      } catch {
        sha1 = undefined; // changed while hashing: the reconciler treats it conservatively
      }
    }
    items.set(e.relPath, { relPath: e.relPath, kind: e.kind, dev: e.dev, ino: e.ino, size: e.size, mtimeMs: e.mtimeMs, ...(sha1 !== undefined ? { sha1 } : {}) });
  }
  return { items, complete: snapshot.complete, available, asOf: snapshot.scannedAt };
}

/** Full remote listing under the sync root (root included). Throws instead of returning partial data. */
export async function listRemoteTree(remote: RemoteDrive, rootUid: string, signal?: AbortSignal): Promise<RemoteNode[]> {
  const root = await remote.getNode(rootUid);
  if (root === null) throw new Error(`remote root ${rootUid} not found`);
  const out: RemoteNode[] = [root];
  const queue: RemoteNode[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    for (const child of await remote.listChildren(dir.uid, signal)) {
      out.push(child);
      if (child.type === 'folder' && !child.isTrashed && child.nameStatus === 'ok') queue.push(child);
    }
  }
  return out;
}

export function remoteViewFromNodes(nodes: RemoteNode[], rootUid: string, complete = true, available = true, asOf?: number): RemoteView {
  const items = new Map<string, RemoteItem>();
  for (const n of nodes) items.set(n.uid, remoteNodeToItem(n));
  return { items, rootUid, complete, available, ...(asOf !== undefined ? { asOf } : {}) };
}

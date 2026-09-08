/**
 * Baseline repository: the last known synced state of every item.
 */
import type { StateStore } from './store.ts';

export interface BaselineRow {
  relPath: string;
  kind: 'file' | 'dir';
  localDev: number;
  localIno: number;
  localSize: number;
  localMtimeMs: number;
  /** Null for directories or when the digest was never computed. */
  localSha1: string | null;
  nodeUid: string;
  parentUid: string | null;
  remoteName: string;
  revisionUid: string | null;
  remoteSha1: string | null;
  syncedAt: number;
}

interface DbRow {
  rel_path: string;
  kind: 'file' | 'dir';
  local_dev: number;
  local_ino: number;
  local_size: number;
  local_mtime_ms: number;
  local_sha1: string | null;
  node_uid: string;
  parent_uid: string | null;
  remote_name: string;
  revision_uid: string | null;
  remote_sha1: string | null;
  synced_at: number;
}

function fromDb(r: DbRow): BaselineRow {
  return {
    relPath: r.rel_path,
    kind: r.kind,
    localDev: r.local_dev,
    localIno: r.local_ino,
    localSize: r.local_size,
    localMtimeMs: r.local_mtime_ms,
    localSha1: r.local_sha1,
    nodeUid: r.node_uid,
    parentUid: r.parent_uid,
    remoteName: r.remote_name,
    revisionUid: r.revision_uid,
    remoteSha1: r.remote_sha1,
    syncedAt: r.synced_at,
  };
}

const COLUMNS = 'rel_path, kind, local_dev, local_ino, local_size, local_mtime_ms, local_sha1, node_uid, parent_uid, remote_name, revision_uid, remote_sha1, synced_at';

export class BaselineRepo {
  private readonly store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  count(): number {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM baseline').get() as { n: number };
    return row.n;
  }

  all(): BaselineRow[] {
    return (this.store.db.prepare(`SELECT ${COLUMNS} FROM baseline ORDER BY rel_path`).all() as unknown as DbRow[]).map(fromDb);
  }

  byPath(relPath: string): BaselineRow | null {
    const row = this.store.db.prepare(`SELECT ${COLUMNS} FROM baseline WHERE rel_path = ?`).get(relPath) as DbRow | undefined;
    return row === undefined ? null : fromDb(row);
  }

  byNodeUid(nodeUid: string): BaselineRow | null {
    const row = this.store.db.prepare(`SELECT ${COLUMNS} FROM baseline WHERE node_uid = ?`).get(nodeUid) as DbRow | undefined;
    return row === undefined ? null : fromDb(row);
  }

  /** Inode identity may be shared by several paths (hard links); all matches are returned. */
  byInode(dev: number, ino: number): BaselineRow[] {
    return (this.store.db.prepare(`SELECT ${COLUMNS} FROM baseline WHERE local_dev = ? AND local_ino = ? ORDER BY rel_path`).all(dev, ino) as unknown as DbRow[]).map(fromDb);
  }

  /**
   * Insert or replace the row for an item. Both the path and the node uid are
   * unique; a stale row holding either key for a different item is removed in
   * the same transaction so the store never links one identity to two rows.
   */
  upsert(row: BaselineRow): void {
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM baseline WHERE node_uid = ? AND rel_path <> ?').run(row.nodeUid, row.relPath);
      this.store.db
        .prepare(`INSERT OR REPLACE INTO baseline (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.relPath,
          row.kind,
          row.localDev,
          row.localIno,
          row.localSize,
          row.localMtimeMs,
          row.localSha1,
          row.nodeUid,
          row.parentUid,
          row.remoteName,
          row.revisionUid,
          row.remoteSha1,
          row.syncedAt,
        );
    });
  }

  /** Move a row (and, for directories, every descendant) to a new path atomically. */
  rename(fromRelPath: string, toRelPath: string): void {
    this.store.transaction(() => {
      const prefix = `${fromRelPath}/`;
      const rows = this.store.db.prepare(`SELECT ${COLUMNS} FROM baseline WHERE rel_path = ? OR substr(rel_path, 1, ?) = ?`).all(fromRelPath, prefix.length, prefix) as unknown as DbRow[];
      // Delete first (descending so children go before parents) to avoid transient key collisions.
      for (const r of rows) this.store.db.prepare('DELETE FROM baseline WHERE rel_path = ?').run(r.rel_path);
      for (const r of rows) {
        const newPath = r.rel_path === fromRelPath ? toRelPath : `${toRelPath}/${r.rel_path.slice(prefix.length)}`;
        this.store.db
          .prepare(`INSERT INTO baseline (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newPath, r.kind, r.local_dev, r.local_ino, r.local_size, r.local_mtime_ms, r.local_sha1, r.node_uid, r.parent_uid, r.remote_name, r.revision_uid, r.remote_sha1, r.synced_at);
      }
    });
  }

  remove(relPath: string): void {
    this.store.db.prepare('DELETE FROM baseline WHERE rel_path = ?').run(relPath);
  }

  removeByNodeUid(nodeUid: string): void {
    this.store.db.prepare('DELETE FROM baseline WHERE node_uid = ?').run(nodeUid);
  }

  /** Remove a directory row and everything under it. */
  removeSubtree(relPath: string): number {
    const prefix = `${relPath}/`;
    const result = this.store.db.prepare('DELETE FROM baseline WHERE rel_path = ? OR substr(rel_path, 1, ?) = ?').run(relPath, prefix.length, prefix);
    return Number(result.changes);
  }

  clear(): void {
    this.store.db.exec('DELETE FROM baseline');
  }
}

/**
 * Smaller repositories: event cursors, scan timestamps, quarantine, conflicts,
 * and persisted snapshots.
 */
import type { StateStore } from './store.ts';

export class CursorRepo {
  private readonly store: StateStore;
  constructor(store: StateStore) {
    this.store = store;
  }
  get(scopeId: string): Promise<string | null> {
    const row = this.store.db.prepare('SELECT event_id FROM cursors WHERE scope_id = ?').get(scopeId) as { event_id: string } | undefined;
    return Promise.resolve(row === undefined ? null : row.event_id);
  }
  set(scopeId: string, eventId: string): Promise<void> {
    this.store.db.prepare('INSERT OR REPLACE INTO cursors (scope_id, event_id, updated_at) VALUES (?, ?, ?)').run(scopeId, eventId, this.store.now());
    return Promise.resolve();
  }
  /** SDK-facing accessor (LatestEventIdProvider). */
  getLatestEventId(scopeId: string): Promise<string | null> {
    return this.get(scopeId);
  }
  clear(scopeId: string): void {
    this.store.db.prepare('DELETE FROM cursors WHERE scope_id = ?').run(scopeId);
  }
}

export class ScanRepo {
  private readonly store: StateStore;
  constructor(store: StateStore) {
    this.store = store;
  }
  lastCompleted(kind: 'local' | 'remote'): number | null {
    const row = this.store.db.prepare('SELECT completed_at FROM scans WHERE kind = ?').get(kind) as { completed_at: number } | undefined;
    return row === undefined ? null : row.completed_at;
  }
  markCompleted(kind: 'local' | 'remote', at: number = this.store.now()): void {
    this.store.db.prepare('INSERT OR REPLACE INTO scans (kind, completed_at) VALUES (?, ?)').run(kind, at);
  }
}

export interface QuarantineEntry {
  id: number;
  relPath: string | null;
  nodeUid: string | null;
  reason: string;
  details: unknown;
  createdAt: number;
  releasedAt: number | null;
}

interface QuarantineRow {
  id: number;
  rel_path: string | null;
  node_uid: string | null;
  reason: string;
  details: string;
  created_at: number;
  released_at: number | null;
}

export class QuarantineRepo {
  private readonly store: StateStore;
  constructor(store: StateStore) {
    this.store = store;
  }
  add(entry: { relPath: string | null; nodeUid: string | null; reason: string; details: unknown }): QuarantineEntry {
    const result = this.store.db
      .prepare('INSERT INTO quarantine (rel_path, node_uid, reason, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(entry.relPath, entry.nodeUid, entry.reason, JSON.stringify(entry.details ?? null), this.store.now());
    return this.get(Number(result.lastInsertRowid));
  }
  get(id: number): QuarantineEntry {
    const row = this.store.db.prepare('SELECT * FROM quarantine WHERE id = ?').get(id) as QuarantineRow | undefined;
    if (row === undefined) throw new Error(`Quarantine entry ${String(id)} not found`);
    return toQuarantine(row);
  }
  open(): QuarantineEntry[] {
    return (this.store.db.prepare('SELECT * FROM quarantine WHERE released_at IS NULL ORDER BY id').all() as unknown as QuarantineRow[]).map(toQuarantine);
  }
  isQuarantined(relPath: string | null, nodeUid: string | null): boolean {
    const row = this.store.db
      .prepare('SELECT id FROM quarantine WHERE released_at IS NULL AND ((rel_path IS NOT NULL AND rel_path = ?) OR (node_uid IS NOT NULL AND node_uid = ?)) LIMIT 1')
      .get(relPath, nodeUid);
    return row !== undefined;
  }
  release(id: number): QuarantineEntry {
    this.store.db.prepare('UPDATE quarantine SET released_at = ? WHERE id = ? AND released_at IS NULL').run(this.store.now(), id);
    return this.get(id);
  }
}

function toQuarantine(r: QuarantineRow): QuarantineEntry {
  return {
    id: r.id,
    relPath: r.rel_path,
    nodeUid: r.node_uid,
    reason: r.reason,
    details: JSON.parse(r.details) as unknown,
    createdAt: r.created_at,
    releasedAt: r.released_at,
  };
}

export interface ConflictEntry {
  id: number;
  relPath: string;
  nodeUid: string | null;
  kind: string;
  local: unknown;
  remote: unknown;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

interface ConflictRow {
  id: number;
  rel_path: string;
  node_uid: string | null;
  kind: string;
  local: string;
  remote: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

export class ConflictRepo {
  private readonly store: StateStore;
  constructor(store: StateStore) {
    this.store = store;
  }
  add(entry: { relPath: string; nodeUid: string | null; kind: string; local: unknown; remote: unknown }): ConflictEntry {
    const result = this.store.db
      .prepare('INSERT INTO conflicts (rel_path, node_uid, kind, local, remote, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.relPath, entry.nodeUid, entry.kind, JSON.stringify(entry.local ?? null), JSON.stringify(entry.remote ?? null), this.store.now());
    return this.get(Number(result.lastInsertRowid));
  }
  get(id: number): ConflictEntry {
    const row = this.store.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as ConflictRow | undefined;
    if (row === undefined) throw new Error(`Conflict ${String(id)} not found`);
    return toConflict(row);
  }
  open(): ConflictEntry[] {
    return (this.store.db.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY id').all() as unknown as ConflictRow[]).map(toConflict);
  }
  openForPath(relPath: string): ConflictEntry | null {
    const row = this.store.db.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL AND rel_path = ? ORDER BY id DESC LIMIT 1').get(relPath) as ConflictRow | undefined;
    return row === undefined ? null : toConflict(row);
  }
  resolve(id: number, resolution: string): ConflictEntry {
    this.store.db.prepare('UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL').run(this.store.now(), resolution, id);
    return this.get(id);
  }
}

function toConflict(r: ConflictRow): ConflictEntry {
  return {
    id: r.id,
    relPath: r.rel_path,
    nodeUid: r.node_uid,
    kind: r.kind,
    local: JSON.parse(r.local) as unknown,
    remote: JSON.parse(r.remote) as unknown,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  };
}

export interface LocalNodeRow {
  relPath: string;
  kind: 'file' | 'dir';
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha1: string | null;
}

export interface RemoteNodeRow {
  nodeUid: string;
  parentUid: string | null;
  name: string;
  nameStatus: string;
  type: string;
  isTrashed: boolean;
  revisionUid: string | null;
  claimedSha1: string | null;
  claimedSize: number | null;
  claimedMtimeMs: number | null;
  serverMtimeMs: number;
  degraded: boolean;
  /** Full serialised RemoteNode for fields not indexed here. */
  json: string;
}

/** Persisted latest snapshots of both sides, replaced wholesale in one transaction. */
export class SnapshotRepo {
  private readonly store: StateStore;
  constructor(store: StateStore) {
    this.store = store;
  }

  replaceLocal(rows: Iterable<LocalNodeRow>): void {
    this.store.transaction(() => {
      this.store.db.exec('DELETE FROM local_nodes');
      const insert = this.store.db.prepare('INSERT INTO local_nodes (rel_path, kind, dev, ino, size, mtime_ms, sha1) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) insert.run(r.relPath, r.kind, r.dev, r.ino, r.size, r.mtimeMs, r.sha1);
    });
  }

  local(): LocalNodeRow[] {
    return (this.store.db.prepare('SELECT * FROM local_nodes ORDER BY rel_path').all() as { rel_path: string; kind: 'file' | 'dir'; dev: number; ino: number; size: number; mtime_ms: number; sha1: string | null }[]).map((r) => ({
      relPath: r.rel_path,
      kind: r.kind,
      dev: r.dev,
      ino: r.ino,
      size: r.size,
      mtimeMs: r.mtime_ms,
      sha1: r.sha1,
    }));
  }

  replaceRemote(rows: Iterable<RemoteNodeRow>): void {
    this.store.transaction(() => {
      this.store.db.exec('DELETE FROM remote_nodes');
      const insert = this.store.db.prepare(
        'INSERT INTO remote_nodes (node_uid, parent_uid, name, name_status, type, is_trashed, revision_uid, claimed_sha1, claimed_size, claimed_mtime_ms, server_mtime_ms, degraded, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const r of rows) {
        insert.run(r.nodeUid, r.parentUid, r.name, r.nameStatus, r.type, r.isTrashed ? 1 : 0, r.revisionUid, r.claimedSha1, r.claimedSize, r.claimedMtimeMs, r.serverMtimeMs, r.degraded ? 1 : 0, r.json);
      }
    });
  }

  upsertRemote(r: RemoteNodeRow): void {
    this.store.db
      .prepare(
        'INSERT OR REPLACE INTO remote_nodes (node_uid, parent_uid, name, name_status, type, is_trashed, revision_uid, claimed_sha1, claimed_size, claimed_mtime_ms, server_mtime_ms, degraded, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.nodeUid, r.parentUid, r.name, r.nameStatus, r.type, r.isTrashed ? 1 : 0, r.revisionUid, r.claimedSha1, r.claimedSize, r.claimedMtimeMs, r.serverMtimeMs, r.degraded ? 1 : 0, r.json);
  }

  removeRemote(nodeUid: string): void {
    this.store.db.prepare('DELETE FROM remote_nodes WHERE node_uid = ?').run(nodeUid);
  }

  remote(): RemoteNodeRow[] {
    return (this.store.db.prepare('SELECT * FROM remote_nodes ORDER BY node_uid').all() as {
      node_uid: string; parent_uid: string | null; name: string; name_status: string; type: string; is_trashed: number; revision_uid: string | null;
      claimed_sha1: string | null; claimed_size: number | null; claimed_mtime_ms: number | null; server_mtime_ms: number; degraded: number; json: string;
    }[]).map((r) => ({
      nodeUid: r.node_uid,
      parentUid: r.parent_uid,
      name: r.name,
      nameStatus: r.name_status,
      type: r.type,
      isTrashed: r.is_trashed === 1,
      revisionUid: r.revision_uid,
      claimedSha1: r.claimed_sha1,
      claimedSize: r.claimed_size,
      claimedMtimeMs: r.claimed_mtime_ms,
      serverMtimeMs: r.server_mtime_ms,
      degraded: r.degraded === 1,
      json: r.json,
    }));
  }
}

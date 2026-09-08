/**
 * State database schema and migrations.
 *
 * This module (and everything under src/state) uses only type-erasable syntax
 * and explicit `.ts` import specifiers so it can also run under plain Node
 * with type stripping, which the crash-injection tests rely on.
 */

export const SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Last known synced state of every item, linking local identity to remote identity.
      CREATE TABLE baseline (
        rel_path       TEXT PRIMARY KEY,
        kind           TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
        local_dev      INTEGER NOT NULL,
        local_ino      INTEGER NOT NULL,
        local_size     INTEGER NOT NULL,
        local_mtime_ms REAL NOT NULL,
        local_sha1     TEXT,
        node_uid       TEXT NOT NULL UNIQUE,
        parent_uid     TEXT,
        remote_name    TEXT NOT NULL,
        revision_uid   TEXT,
        remote_sha1    TEXT,
        synced_at      INTEGER NOT NULL
      );
      CREATE INDEX baseline_local_identity ON baseline (local_dev, local_ino);
      CREATE INDEX baseline_parent ON baseline (parent_uid);

      -- Latest local snapshot.
      CREATE TABLE local_nodes (
        rel_path TEXT PRIMARY KEY,
        kind     TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
        dev      INTEGER NOT NULL,
        ino      INTEGER NOT NULL,
        size     INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        sha1     TEXT
      );

      -- Latest remote snapshot.
      CREATE TABLE remote_nodes (
        node_uid        TEXT PRIMARY KEY,
        parent_uid      TEXT,
        name            TEXT NOT NULL,
        name_status     TEXT NOT NULL,
        type            TEXT NOT NULL,
        is_trashed      INTEGER NOT NULL,
        revision_uid    TEXT,
        claimed_sha1    TEXT,
        claimed_size    INTEGER,
        claimed_mtime_ms REAL,
        server_mtime_ms REAL NOT NULL,
        degraded        INTEGER NOT NULL,
        json            TEXT NOT NULL
      );
      CREATE INDEX remote_nodes_parent ON remote_nodes (parent_uid);

      -- Write-ahead operation journal.
      CREATE TABLE journal (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed', 'failed', 'abandoned')),
        op                TEXT NOT NULL,
        rel_path          TEXT,
        previous_rel_path TEXT,
        node_uid          TEXT,
        intended          TEXT NOT NULL,
        pre_state         TEXT NOT NULL,
        outcome           TEXT,
        error             TEXT,
        attempt           INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX journal_status ON journal (status);

      CREATE TABLE cursors (
        scope_id   TEXT PRIMARY KEY,
        event_id   TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE scans (
        kind         TEXT PRIMARY KEY CHECK (kind IN ('local', 'remote')),
        completed_at INTEGER NOT NULL
      );

      CREATE TABLE quarantine (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path    TEXT,
        node_uid    TEXT,
        reason      TEXT NOT NULL,
        details     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE INDEX quarantine_open ON quarantine (released_at);

      CREATE TABLE conflicts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path    TEXT NOT NULL,
        node_uid    TEXT,
        kind        TEXT NOT NULL,
        local       TEXT NOT NULL,
        remote      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution  TEXT
      );
      CREATE INDEX conflicts_open ON conflicts (resolved_at);
    `,
  },
];

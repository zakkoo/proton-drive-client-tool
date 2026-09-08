/**
 * SQLite state store: durable, crash-safe, single-instance.
 *
 * - WAL mode with synchronous=FULL so a committed transaction survives power loss.
 * - PRAGMA integrity_check on every open; a corrupt file is refused and kept.
 * - An exclusive lock file refuses a second instance.
 * - Schema version is recorded; a newer version is refused; migrations run in
 *   a transaction after a checkpointed backup copy that is kept until the
 *   engine reports one successful sync cycle.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

export class StoreLockedError extends Error {
  constructor(file: string, pid: number) {
    super(`State store ${file} is in use by process ${String(pid)}; another instance is already running`);
    this.name = 'StoreLockedError';
  }
}
export class StoreCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(`State store ${file} failed the integrity check (${detail}). The file was left in place for inspection; ` + 'rebuild from scratch requires an explicit user choice.');
    this.name = 'StoreCorruptError';
  }
}
export class StoreVersionError extends Error {
  constructor(file: string, found: number, supported: number) {
    super(`State store ${file} has schema version ${String(found)} but this build supports up to ${String(supported)}; upgrade the application`);
    this.name = 'StoreVersionError';
  }
}
export class StoreMigrationError extends Error {
  constructor(version: number, options?: { cause?: unknown }) {
    super(`Migration to schema version ${String(version)} failed; the store was left at its previous version`, options);
    this.name = 'StoreMigrationError';
  }
}

export interface StoreOptions {
  now?: () => number;
  /** Test hook: throw inside a migration to exercise rollback. */
  failMigration?: (version: number) => void;
}

interface LockHandle {
  file: string;
  fd: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireLock(dbFile: string): LockHandle {
  const file = `${dbFile}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      return { file, fd };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid = NaN;
      try {
        pid = Number(readFileSync(file, 'utf8').trim());
      } catch {
        // unreadable lock: treat as stale below
      }
      // A live holder (including this very process) means another instance owns the store.
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new StoreLockedError(dbFile, pid);
      // Stale lock from a dead process: remove and retry once.
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
  throw new Error(`Could not acquire lock ${file}`);
}

export class StateStore {
  readonly file: string;
  readonly db: DatabaseSync;
  readonly now: () => number;
  private lock: LockHandle | null;
  private closed = false;

  private constructor(file: string, db: DatabaseSync, lock: LockHandle, now: () => number) {
    this.file = file;
    this.db = db;
    this.lock = lock;
    this.now = now;
  }

  static open(file: string, options: StoreOptions = {}): StateStore {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = acquireLock(file);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file);
      let verdict: string;
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA busy_timeout = 5000');
        const check = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
        verdict = check.map((r) => r.integrity_check).join('; ');
      } catch (error) {
        // SQLite may refuse to read a damaged file before integrity_check can report on it.
        const message = error instanceof Error ? error.message : String(error);
        if (/malformed|corrupt|not a database|disk image/i.test(message)) throw new StoreCorruptError(file, message);
        throw error;
      }
      if (verdict !== 'ok') throw new StoreCorruptError(file, verdict);

      const store = new StateStore(file, db, lock, options.now ?? Date.now);
      store.migrate(options);
      return store;
    } catch (error) {
      db?.close();
      closeSync(lock.fd);
      try {
        unlinkSync(lock.file);
      } catch {
        // ignore
      }
      throw error;
    }
  }

  private currentVersion(): number {
    const hasMeta = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as { name: string } | undefined;
    if (hasMeta === undefined) return 0;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row === undefined ? 0 : Number(row.value);
  }

  private hasAnyTables(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
    return row.n > 0;
  }

  get schemaVersion(): number {
    return this.currentVersion();
  }

  private migrate(options: StoreOptions): void {
    const found = this.currentVersion();
    if (found > SCHEMA_VERSION) throw new StoreVersionError(this.file, found, SCHEMA_VERSION);
    for (const migration of MIGRATIONS) {
      if (migration.version <= found) continue;
      if (this.hasAnyTables()) this.backupBeforeMigration(this.currentVersion());
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        options.failMigration?.(migration.version);
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(migration.version));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new StoreMigrationError(migration.version, { cause: error });
      }
    }
  }

  private backupBeforeMigration(fromVersion: number): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backup = `${this.file}.bak-v${String(fromVersion)}-${String(this.now())}`;
    copyFileSync(this.file, backup);
    const existing = this.getMeta('pending_backups');
    const list: string[] = existing === null ? [] : (JSON.parse(existing) as string[]);
    list.push(backup);
    this.setMeta('pending_backups', JSON.stringify(list));
  }

  /** Migration backups waiting for the first successful sync cycle. */
  pendingBackups(): string[] {
    const raw = this.getMeta('pending_backups');
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }

  /** Called by the engine after one successful sync cycle on the migrated store. */
  discardPendingBackups(): string[] {
    const list = this.pendingBackups();
    for (const f of list) {
      if (existsSync(f)) unlinkSync(f);
    }
    this.setMeta('pending_backups', '[]');
    return list;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Run `fn` in a transaction; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    if (this.lock !== null) {
      closeSync(this.lock.fd);
      try {
        unlinkSync(this.lock.file);
      } catch {
        // ignore
      }
      this.lock = null;
    }
  }
}

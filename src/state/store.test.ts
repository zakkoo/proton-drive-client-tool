import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from './schema.ts';
import { StateStore, StoreCorruptError, StoreLockedError, StoreMigrationError, StoreVersionError } from './store.ts';

let dir: string;
let file: string;
const opened: StateStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-state-'));
  file = path.join(dir, 'state.db');
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(options: Parameters<typeof StateStore.open>[1] = {}): StateStore {
  const s = StateStore.open(file, options);
  opened.push(s);
  return s;
}

describe('StateStore', () => {
  it('creates the schema with WAL and synchronous FULL, and records the schema version', () => {
    const s = open();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect((s.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((s.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2);
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['baseline', 'journal', 'cursors', 'quarantine', 'conflicts', 'local_nodes', 'remote_nodes', 'scans', 'meta']) expect(tables).toContain(t);
  });

  it('refuses a second instance while the first holds the lock, and recovers a stale lock from a dead process', () => {
    const s = open();
    expect(() => StateStore.open(file)).toThrow(StoreLockedError);
    s.close();
    writeFileSync(`${file}.lock`, '999999999'); // no such process
    const again = open();
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
  });

  it('refuses to open a corrupt file and leaves it in place', () => {
    open().close();
    const bytes = readFileSync(file);
    // Corrupt the cell area at the end of the first two pages (cells grow from the page end).
    const pageSize = bytes.readUInt16BE(16);
    for (const page of [0, 1]) {
      for (let i = pageSize * (page + 1) - 1200; i < pageSize * (page + 1); i++) bytes[i] = 0xff;
    }
    writeFileSync(file, bytes);
    const before = readFileSync(file);
    expect(() => StateStore.open(file)).toThrow(StoreCorruptError);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('refuses a store written by a newer schema version', () => {
    const s = open();
    s.setMeta('schema_version', String(SCHEMA_VERSION + 1));
    s.close();
    expect(() => StateStore.open(file)).toThrow(StoreVersionError);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('leaves the store at its previous version when a migration fails, keeping the backup', () => {
    // Build a legacy store at version 0 that already has a meta table with content we can check.
    const legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    legacy.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '0'), ('marker', 'legacy')");
    legacy.close();
    expect(() => StateStore.open(file, { failMigration: () => { throw new Error('boom'); } })).toThrow(StoreMigrationError);
    const check = new DatabaseSync(file);
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain('baseline');
    expect((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('0');
    expect((check.prepare("SELECT value FROM meta WHERE key = 'marker'").get() as { value: string }).value).toBe('legacy');
    check.close();
    // A pre-migration backup was taken and the lock was released.
    const backups = readdirSync(dir).filter((f) => f.startsWith('state.db.bak-v0-'));
    expect(backups).toHaveLength(1);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('keeps migration backups until the engine discards them after a successful cycle', () => {
    const legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    legacy.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '0')");
    legacy.close();
    const s = open();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    const pending = s.pendingBackups();
    expect(pending).toHaveLength(1);
    expect(existsSync(pending[0] ?? '')).toBe(true);
    expect(s.discardPendingBackups()).toEqual(pending);
    expect(existsSync(pending[0] ?? '')).toBe(false);
    expect(s.pendingBackups()).toEqual([]);
  });

  it('rolls back a failed transaction and supports nesting', () => {
    const s = open();
    s.setMeta('a', '1');
    expect(() =>
      s.transaction(() => {
        s.setMeta('a', '2');
        s.transaction(() => { s.setMeta('b', '3'); });
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(s.getMeta('a')).toBe('1');
    expect(s.getMeta('b')).toBeNull();
  });
});

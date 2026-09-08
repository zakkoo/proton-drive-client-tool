/**
 * Lazily computed, identity-keyed content digests for local files.
 *
 * A digest is only trusted if the file's size and mtime were unchanged across
 * the hashing, so a file being written while hashed is never reported with a
 * torn digest.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { sha1File } from '../remote/transfer.js';
import type { LocalEntry } from './snapshot.js';

export class FileChangedDuringHashError extends Error {
  constructor(relPath: string) {
    super(`${relPath} changed while it was being hashed`);
    this.name = 'FileChangedDuringHashError';
  }
}

export interface DigestProvider {
  /** Hex SHA1 of the entry's current content; throws FileChangedDuringHashError if it changed meanwhile. */
  digestOf(entry: LocalEntry): Promise<string>;
}

export class DigestCache implements DigestProvider {
  private readonly cache = new Map<string, { key: string; sha1: string }>();

  constructor(private readonly root: string) {}

  private static key(e: LocalEntry): string {
    return `${String(e.dev)}:${String(e.ino)}:${String(e.size)}:${String(e.mtimeMs)}`;
  }

  /** Seed from a persisted baseline so unchanged files never need re-hashing. */
  seed(entry: LocalEntry, sha1: string): void {
    this.cache.set(entry.relPath, { key: DigestCache.key(entry), sha1 });
  }

  async digestOf(entry: LocalEntry): Promise<string> {
    if (entry.kind !== 'file') throw new Error(`${entry.relPath} is not a file`);
    const key = DigestCache.key(entry);
    const cached = this.cache.get(entry.relPath);
    if (cached?.key === key) return cached.sha1;
    const abs = path.join(this.root, entry.relPath);
    const before = await stat(abs);
    const { sha1, size } = await sha1File(abs);
    const after = await stat(abs);
    if (before.size !== size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || after.size !== size) {
      throw new FileChangedDuringHashError(entry.relPath);
    }
    if (before.ino !== entry.ino || before.mtimeMs !== entry.mtimeMs || before.size !== entry.size) {
      // The entry we were asked about is stale; the caller must rescan.
      throw new FileChangedDuringHashError(entry.relPath);
    }
    this.cache.set(entry.relPath, { key, sha1 });
    return sha1;
  }

  forget(relPath: string): void {
    this.cache.delete(relPath);
  }

  /** Move a cached digest to a new path (after a detected rename). */
  rename(from: string, to: string): void {
    const v = this.cache.get(from);
    if (v !== undefined) {
      this.cache.delete(from);
      this.cache.set(to, v);
    }
  }
}

/**
 * Local snapshot types and the full-tree scanner.
 *
 * A snapshot is the complete, point-in-time view of the sync root: every
 * syncable file and directory with its identity (device, inode), size and
 * mtime, plus every item that cannot be synced and why. Digests are computed
 * lazily (see digest.ts) because hashing the whole tree on every scan is not
 * affordable, and mtime/size are only a fast path anyway.
 */
import { constants } from 'node:fs';
import { access, lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

import type { IgnoreMatcher } from './ignore.js';

export type LocalKind = 'file' | 'dir';

export interface LocalEntry {
  /** Root-relative POSIX path. */
  relPath: string;
  kind: LocalKind;
  dev: number;
  ino: number;
  /** 0 for directories. */
  size: number;
  mtimeMs: number;
  /** Creation time, so inode reuse (a deleted file's inode taken by a new one) is not mistaken for a move. */
  birthtimeMs: number;
}

export type UnsyncableReason = 'symlink' | 'special' | 'unreadable' | 'invalid_name';

export interface UnsyncableEntry {
  relPath: string;
  reason: UnsyncableReason;
  detail?: string;
}

export interface LocalSnapshot {
  root: string;
  rootIdentity: { dev: number; ino: number };
  entries: Map<string, LocalEntry>;
  unsyncable: UnsyncableEntry[];
  /** False when the scan was aborted or a directory could not be fully listed. */
  complete: boolean;
  scannedAt: number;
}

export class RootUnavailableError extends Error {
  constructor(root: string, options?: { cause?: unknown }) {
    super(`Sync root is unavailable: ${root}`, options);
    this.name = 'RootUnavailableError';
  }
}

const MAX_NAME_BYTES = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Why a name cannot exist on the remote side, or null when it is fine. */
export function invalidNameReason(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return 'reserved name';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return `name longer than ${MAX_NAME_BYTES} bytes`;
  if (CONTROL_CHARS.test(name)) return 'name contains control characters';
  if (name.includes('/') || name.includes('\\')) return 'name contains a path separator';
  return null;
}

export interface ScanOptions {
  ignore: IgnoreMatcher;
  signal?: AbortSignal;
  now?: () => number;
}

/** Stat the root and return its identity, or throw RootUnavailableError. */
export async function statRoot(root: string): Promise<{ dev: number; ino: number }> {
  let st;
  try {
    st = await lstat(root);
  } catch (error) {
    throw new RootUnavailableError(root, { cause: error });
  }
  if (!st.isDirectory()) throw new RootUnavailableError(root, { cause: new Error('not a directory') });
  return { dev: st.dev, ino: st.ino };
}

/**
 * Full scan of the sync root. Never follows symlinks. Ignored paths are not
 * descended into. Unreadable items are reported, never skipped silently.
 */
export async function scanLocalTree(root: string, options: ScanOptions): Promise<LocalSnapshot> {
  const rootIdentity = await statRoot(root);
  const entries = new Map<string, LocalEntry>();
  const unsyncable: UnsyncableEntry[] = [];
  let complete = true;

  const walk = async (relDir: string): Promise<void> => {
    options.signal?.throwIfAborted();
    const absDir = relDir === '' ? root : path.join(root, relDir);
    let dir;
    try {
      dir = await opendir(absDir);
    } catch (error) {
      if (relDir === '') throw new RootUnavailableError(root, { cause: error });
      unsyncable.push({ relPath: relDir, reason: 'unreadable', detail: errCode(error) });
      complete = false;
      return;
    }
    const subdirs: string[] = [];
    for await (const dirent of dir) {
      options.signal?.throwIfAborted();
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (options.ignore(rel)) continue;
      const nameProblem = invalidNameReason(dirent.name);
      if (nameProblem !== null) {
        unsyncable.push({ relPath: rel, reason: 'invalid_name', detail: nameProblem });
        continue;
      }
      let st;
      try {
        st = await lstat(path.join(root, rel));
      } catch (error) {
        if (errCode(error) === 'ENOENT') continue; // vanished between readdir and lstat
        unsyncable.push({ relPath: rel, reason: 'unreadable', detail: errCode(error) });
        continue;
      }
      if (st.isSymbolicLink()) {
        unsyncable.push({ relPath: rel, reason: 'symlink' });
      } else if (st.isDirectory()) {
        entries.set(rel, { relPath: rel, kind: 'dir', dev: st.dev, ino: st.ino, size: 0, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
        subdirs.push(rel);
      } else if (st.isFile()) {
        try {
          await access(path.join(root, rel), constants.R_OK);
        } catch (error) {
          unsyncable.push({ relPath: rel, reason: 'unreadable', detail: errCode(error) });
          continue;
        }
        entries.set(rel, { relPath: rel, kind: 'file', dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
      } else {
        unsyncable.push({ relPath: rel, reason: 'special' });
      }
    }
    for (const sub of subdirs) await walk(sub);
  };

  await walk('');
  return { root, rootIdentity, entries, unsyncable, complete, scannedAt: (options.now ?? Date.now)() };
}

function errCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error
      ? error.message
      : String(error);
}

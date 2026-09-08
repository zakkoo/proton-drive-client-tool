/**
 * Atomic local write protocol.
 *
 * 1. Download into `<root>/.proton-sync/tmp/<unique>` (same file system as the
 *    target, so the final rename is atomic), verifying the digest.
 * 2. Set the temp file's mtime to the remote's claimed modification time.
 * 3. Re-check the target: it must still be exactly the item the plan expected
 *    (or still absent). If not, the temp file is set aside and the caller
 *    re-reconciles.
 * 4. Move the previous version, if any, into the recycle bin.
 * 5. Rename the temp file into place.
 *
 * Nothing here ever unlinks user data; the only file removed is our own
 * temporary file on failure.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { rename, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

import { INTERNAL_DIR_NAME } from '../config/paths.js';
import type { LocalFingerprint } from '../reconcile/types.js';
import { RemoteError, type RemoteDrive, type RemoteNode } from '../remote/interface.js';
import { downloadVerified, type VerifiedDownload } from '../remote/transfer.js';
import type { RecycleBin } from '../safety/recycle.js';

export class TargetChangedError extends Error {
  constructor(relPath: string, detail: string) {
    super(`Local target ${relPath} changed since planning: ${detail}`);
    this.name = 'TargetChangedError';
  }
}

export class DiskFullError extends Error {
  constructor(detail: string) {
    super(`Disk full: ${detail}`);
    this.name = 'DiskFullError';
  }
}

export function tempDir(root: string): string {
  return path.join(root, INTERNAL_DIR_NAME, 'tmp');
}

export function newTempPath(root: string): string {
  const dir = tempDir(root);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `download-${randomUUID()}`);
}

export function isDiskFull(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ((error).code === 'ENOSPC' || (error).code === 'EDQUOT');
}

/** Compare a stat result with an expected fingerprint; returns a description of the difference or null. */
export function fingerprintMismatch(relPath: string, expected: LocalFingerprint | undefined, root: string): string | null {
  let st;
  try {
    st = statSync(path.join(root, relPath));
  } catch {
    return expected === undefined ? null : `expected an existing item (ino ${String(expected.ino)}) but the path is missing`;
  }
  if (expected === undefined) return `expected no item at the path but found one (ino ${String(st.ino)})`;
  if (st.ino !== expected.ino || st.dev !== expected.dev) return `inode changed (${String(expected.ino)} -> ${String(st.ino)})`;
  if (st.isFile() && (st.size !== expected.size || st.mtimeMs !== expected.mtimeMs)) {
    return `size/mtime changed (${String(expected.size)}/${String(expected.mtimeMs)} -> ${String(st.size)}/${String(st.mtimeMs)})`;
  }
  return null;
}

export interface AtomicDownloadResult extends VerifiedDownload {
  tempPath: string;
  finalPath: string;
  recycledPrevious: boolean;
}

/**
 * Download `node` and atomically place it at `relPath`.
 * `expectedLocal` describes the item expected at the target (undefined = must be absent).
 */
export async function atomicDownload(
  root: string,
  remote: RemoteDrive,
  node: RemoteNode,
  relPath: string,
  expectedLocal: LocalFingerprint | undefined,
  recycle: RecycleBin,
  options: { onProgress?: (bytes: number) => void; signal?: AbortSignal; beforeCommit?: () => Promise<void> } = {},
): Promise<AtomicDownloadResult> {
  const finalPath = path.join(root, relPath);
  const tempPath = newTempPath(root);
  let result: VerifiedDownload;
  try {
    result = await downloadVerified(remote, node, tempPath, { ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  } catch (error) {
    if (isDiskFull(error)) throw new DiskFullError(error instanceof Error ? error.message : String(error));
    throw error;
  }
  try {
    if (options.signal?.aborted === true) throw new RemoteError(`download of ${relPath} cancelled before commit`, 'aborted', false);
    if (node.claimedModifiedAt !== undefined) await utimes(tempPath, node.claimedModifiedAt, node.claimedModifiedAt);
    await options.beforeCommit?.();
    const mismatch = fingerprintMismatch(relPath, expectedLocal, root);
    if (mismatch !== null) throw new TargetChangedError(relPath, mismatch);
    mkdirSync(path.dirname(finalPath), { recursive: true });
    let recycledPrevious = false;
    if (expectedLocal !== undefined) {
      recycle.recycle(relPath, `replaced by remote revision ${node.revisionUid ?? 'unknown'}`);
      recycledPrevious = true;
    }
    await rename(tempPath, finalPath);
    return { ...result, tempPath, finalPath, recycledPrevious };
  } catch (error) {
    // Our own temp file only; the target is untouched.
    await unlink(tempPath).catch(() => undefined);
    if (error instanceof RemoteError || error instanceof TargetChangedError) throw error;
    if (isDiskFull(error)) throw new DiskFullError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

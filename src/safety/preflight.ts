/**
 * Preflight checks before a plan runs. Any failure pauses the engine with a
 * specific reason; nothing is executed.
 */
import { statfs } from 'node:fs/promises';

import { readRootIdentity, sameIdentity, type RootIdentity } from '../config/localRoot.js';
import type { RemoteDrive } from '../remote/interface.js';
import { RootUnavailableError, statRoot } from '../local/snapshot.js';

export type PreflightFailure = 'sync_root_missing' | 'sync_root_changed' | 'store_corrupt' | 'disk_space_low' | 'remote_root_missing' | 'remote_root_changed';

export type PreflightResult = { ok: true; freeBytes: number } | { ok: false; reason: PreflightFailure; detail: string };

export interface PreflightInput {
  root: string;
  expectedRootIdentity: RootIdentity;
  /** Returns 'ok' or a description of the corruption. */
  storeIntegrity: () => string;
  remote: RemoteDrive;
  expectedRemoteRootUid: string;
  /** Bytes the plan will download. */
  plannedDownloadBytes: number;
  /** Extra headroom kept free. Default 256 MiB. */
  marginBytes?: number;
  /** Injectable for tests. */
  freeBytes?: (root: string) => Promise<number>;
}

export async function defaultFreeBytes(root: string): Promise<number> {
  const s = await statfs(root);
  return s.bavail * s.bsize;
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  try {
    await statRoot(input.root);
  } catch (error) {
    if (error instanceof RootUnavailableError) return { ok: false, reason: 'sync_root_missing', detail: error.message };
    throw error;
  }
  const identity = readRootIdentity(input.root);
  if (!sameIdentity(identity, input.expectedRootIdentity)) {
    return { ok: false, reason: 'sync_root_changed', detail: `sync root ${input.root} is a different directory than at setup (dev/ino ${String(identity.dev)}/${String(identity.ino)} vs ${String(input.expectedRootIdentity.dev)}/${String(input.expectedRootIdentity.ino)})` };
  }
  const integrity = input.storeIntegrity();
  if (integrity !== 'ok') return { ok: false, reason: 'store_corrupt', detail: integrity };

  const free = await (input.freeBytes ?? defaultFreeBytes)(input.root);
  const margin = input.marginBytes ?? 256 * 1024 * 1024;
  if (free < input.plannedDownloadBytes + margin) {
    return { ok: false, reason: 'disk_space_low', detail: `${String(free)} bytes free, plan needs ${String(input.plannedDownloadBytes)} plus ${String(margin)} margin` };
  }

  const node = await input.remote.getNode(input.expectedRemoteRootUid);
  if (node === null) return { ok: false, reason: 'remote_root_missing', detail: `remote root ${input.expectedRemoteRootUid} cannot be found` };
  if (node.isTrashed || node.type !== 'folder') return { ok: false, reason: 'remote_root_changed', detail: `remote root ${input.expectedRemoteRootUid} is ${node.isTrashed ? 'trashed' : 'not a folder'}` };
  return { ok: true, freeBytes: free };
}

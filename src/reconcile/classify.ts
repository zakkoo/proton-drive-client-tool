/**
 * Side-state classification: how each side changed relative to the baseline.
 *
 * Content equality is decided by digest when both digests are known. Size and
 * mtime are only a fast path: identical size and mtime with a known baseline
 * digest is treated as unchanged content; a differing size or mtime without a
 * fresh digest is treated as modified (conservative).
 */
import type { BaselineItem, LocalItem, RemoteItem, SideState } from './types.js';

export interface LocalClassification {
  state: SideState;
  item: LocalItem | undefined;
  /** Whether the content differs from the baseline (files only). */
  contentChanged: boolean;
  /** True when the decision had to be made without a fresh digest. */
  digestUnknown: boolean;
  evidence: string[];
}

export interface RemoteClassification {
  state: SideState;
  item: RemoteItem | undefined;
  /** Current root-relative path of the item, when present. */
  relPath: string | undefined;
  contentChanged: boolean;
  evidence: string[];
}

/**
 * Locate the baseline item's local counterpart: the entry at the same path
 * when its identity matches, otherwise the single entry elsewhere with the
 * same (kind, device, inode). Inode reuse by an unrelated new file is
 * indistinguishable from "moved and edited"; both are treated as the same
 * item so the remote keeps its history (a new revision) instead of being
 * trashed, which is the safer outcome either way.
 */
export function findLocalCounterpart(base: BaselineItem, local: ReadonlyMap<string, LocalItem>, byIdentity: ReadonlyMap<string, LocalItem[]>): LocalItem | undefined {
  const atPath = local.get(base.relPath);
  if (atPath?.kind === base.kind && atPath.ino === base.local.ino && atPath.dev === base.local.dev) return atPath;
  const candidates = (byIdentity.get(`${base.kind}:${String(base.local.dev)}:${String(base.local.ino)}`) ?? []).filter((c) => c.kind === base.kind);
  if (candidates.length === 1) return candidates[0];
  // The path is occupied by a different item (inode changed): it is the counterpart when it is
  // the same kind; the classifier then reports it as modified (replaced content).
  if (atPath?.kind === base.kind) return atPath;
  return undefined;
}

export function classifyLocal(base: BaselineItem, counterpart: LocalItem | undefined): LocalClassification {
  if (counterpart === undefined) return { state: 'deleted', item: undefined, contentChanged: false, digestUnknown: false, evidence: ['local: absent'] };
  const evidence: string[] = [];
  const moved = counterpart.relPath !== base.relPath;
  if (moved) evidence.push(`local: path ${base.relPath} -> ${counterpart.relPath}`);
  let contentChanged = false;
  let digestUnknown = false;
  if (base.kind === 'file') {
    const sameStat = counterpart.size === base.local.size && counterpart.mtimeMs === base.local.mtimeMs && counterpart.ino === base.local.ino;
    if (counterpart.sha1 !== undefined && base.local.sha1 !== null) {
      contentChanged = counterpart.sha1 !== base.local.sha1;
      if (contentChanged) evidence.push(`local: digest ${base.local.sha1.slice(0, 8)} -> ${counterpart.sha1.slice(0, 8)}`);
    } else if (sameStat && base.local.sha1 !== null) {
      contentChanged = false;
    } else {
      contentChanged = !sameStat || base.local.sha1 === null;
      digestUnknown = true;
      if (contentChanged) evidence.push(`local: size/mtime changed (${String(base.local.size)}/${String(base.local.mtimeMs)} -> ${String(counterpart.size)}/${String(counterpart.mtimeMs)}), digest unknown`);
    }
  }
  const state: SideState = moved ? (contentChanged ? 'movedAndModified' : 'moved') : contentChanged ? 'modified' : 'unchanged';
  return { state, item: counterpart, contentChanged, digestUnknown, evidence };
}

export function classifyRemote(base: BaselineItem, item: RemoteItem | undefined, relPath: string | undefined): RemoteClassification {
  if (item === undefined || item.isTrashed || relPath === undefined) {
    return { state: 'deleted', item: undefined, relPath: undefined, contentChanged: false, evidence: [item?.isTrashed === true ? 'remote: trashed' : 'remote: absent'] };
  }
  const evidence: string[] = [];
  const moved = relPath !== base.relPath;
  if (moved) evidence.push(`remote: path ${base.relPath} -> ${relPath}`);
  let contentChanged = false;
  if (base.kind === 'file') {
    if (item.sha1 !== undefined && base.remote.sha1 !== null) {
      contentChanged = item.sha1 !== base.remote.sha1;
      if (contentChanged) evidence.push(`remote: digest ${base.remote.sha1.slice(0, 8)} -> ${item.sha1.slice(0, 8)}`);
    } else {
      contentChanged = (item.revisionUid ?? null) !== base.remote.revisionUid;
      if (contentChanged) evidence.push(`remote: revision ${base.remote.revisionUid ?? 'none'} -> ${item.revisionUid ?? 'none'}`);
    }
  }
  const state: SideState = moved ? (contentChanged ? 'movedAndModified' : 'moved') : contentChanged ? 'modified' : 'unchanged';
  return { state, item, relPath, contentChanged, evidence };
}

/** Whether two file versions are the same content; undefined when it cannot be decided. */
export function sameContent(localSha1: string | undefined, remoteSha1: string | undefined): boolean | undefined {
  if (localSha1 === undefined || remoteSha1 === undefined) return undefined;
  return localSha1 === remoteSha1;
}

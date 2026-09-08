/**
 * The reconciler: pure function from (baseline, local, remote) to a Plan.
 *
 * Steps:
 *  1. Resolve remote paths and block unsyncable remote items and collisions.
 *  2. Block local collisions and quarantined items.
 *  3. For every baseline item: classify both sides, look up the decision
 *     table, emit operations / conflicts.
 *  4. For items without a baseline on either side: creates, or create-create
 *     handling when both sides have something at the same path.
 *  5. Apply the completeness gate (withhold deletes) and first-sync rules.
 *  6. Check target occupancy and order operations.
 */
import { classifyLocal, classifyRemote, findLocalCounterpart, sameContent, type LocalClassification, type RemoteClassification } from './classify.js';
import { checkOccupancy } from './occupancy.js';
import { orderOperations } from './order.js';
import { localCollisions, resolveRemote } from './remotePaths.js';
import { decide, type Action } from './table.js';
import type { BaselineItem, Blocked, Conflict, LocalFingerprint, LocalItem, Operation, OperationInput, Plan, ReconcileInput, RemoteFingerprint, RemoteItem, Withheld } from './types.js';

function localFp(i: LocalItem): LocalFingerprint {
  return { dev: i.dev, ino: i.ino, size: i.size, mtimeMs: i.mtimeMs, sha1: i.sha1 };
}
function remoteFp(i: RemoteItem): RemoteFingerprint {
  return { uid: i.uid, parentUid: i.parentUid, name: i.name, revisionUid: i.revisionUid, sha1: i.sha1 };
}
function isUnder(prefix: string, p: string): boolean {
  return prefix !== '' && p.startsWith(`${prefix}/`);
}

class Planner {
  readonly operations: Operation[] = [];
  readonly conflicts: Conflict[] = [];
  readonly blocked: Blocked[] = [];
  readonly withheld: Withheld[] = [];
  private seq = 0;

  private id(): string {
    this.seq += 1;
    return `op-${String(this.seq).padStart(4, '0')}`;
  }

  add(op: OperationInput): void {
    this.operations.push({ ...op, id: this.id() });
  }

  conflict(c: Conflict): void {
    this.conflicts.push(c);
  }

  block(b: Blocked): void {
    this.blocked.push(b);
  }
}

export function reconcile(input: ReconcileInput): Plan {
  const planner = new Planner();
  const { baseline, local, remote } = input;
  const quarantinedPaths = input.quarantinedPaths ?? new Set<string>();
  const quarantinedUids = input.quarantinedUids ?? new Set<string>();
  const firstSync = baseline.size === 0;

  // 1. Remote resolution.
  const resolved = resolveRemote(remote);
  for (const b of resolved.blocked) planner.block(b);
  const remoteByUid = remote.items;
  const remotePath = (uid: string): string | undefined => resolved.paths.get(uid);
  const remoteExcluded = (p: string): boolean => [...resolved.excludedPaths].some((e) => e === p || isUnder(e, p));

  // 2. Local collisions and quarantine.
  const localBlockedPaths = new Set<string>();
  for (const b of localCollisions(local.items.keys())) {
    planner.block(b);
    if (b.relPath !== undefined) localBlockedPaths.add(b.relPath);
  }
  const isQuarantined = (relPath: string | undefined, uid: string | undefined): boolean =>
    (relPath !== undefined && quarantinedPaths.has(relPath)) || (uid !== undefined && quarantinedUids.has(uid));
  const isLocallyBlocked = (p: string): boolean => [...localBlockedPaths].some((b) => b === p || isUnder(b, p));

  // Local identity index for move detection.
  const localByIdentity = new Map<string, LocalItem[]>();
  for (const item of local.items.values()) {
    const k = `${item.kind}:${String(item.dev)}:${String(item.ino)}`;
    const list = localByIdentity.get(k) ?? [];
    list.push(item);
    localByIdentity.set(k, list);
  }

  const claimedLocal = new Set<string>(); // local paths accounted for by a baseline item
  const claimedRemote = new Set<string>(); // remote uids accounted for by a baseline item

  // 3. Baseline items: classify everything first so folder moves can absorb their descendants' moves.
  const baselineItems = [...baseline.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const classified = baselineItems.map((base) => {
    const lc = classifyLocal(base, local.available ? findLocalCounterpart(base, local.items, localByIdentity) : undefined);
    const raw = remoteByUid.get(base.remote.uid);
    // A node under a trashed ancestor is trashed for our purposes.
    const rItem = raw !== undefined && resolved.effectivelyTrashed.has(raw.uid) ? { ...raw, isTrashed: true } : raw;
    const rc = classifyRemote(base, rItem, rItem === undefined ? undefined : remotePath(rItem.uid));
    return { base, lc, rc, rItem };
  });
  const movedLocalDirs = new Map<string, string>();
  const movedRemoteDirs = new Map<string, string>();
  for (const { base, lc, rc } of classified) {
    if (base.kind !== 'dir') continue;
    if ((lc.state === 'moved' || lc.state === 'movedAndModified') && lc.item !== undefined) movedLocalDirs.set(base.relPath, lc.item.relPath);
    if ((rc.state === 'moved' || rc.state === 'movedAndModified') && rc.relPath !== undefined) movedRemoteDirs.set(base.relPath, rc.relPath);
  }
  const impliedBy = (dirs: Map<string, string>, oldPath: string, newPath: string): boolean => {
    for (const [from, to] of dirs) {
      if (isUnder(from, oldPath) && newPath === `${to}${oldPath.slice(from.length)}`) return true;
    }
    return false;
  };
  for (const c of classified) {
    if (c.lc.item !== undefined && (c.lc.state === 'moved' || c.lc.state === 'movedAndModified') && impliedBy(movedLocalDirs, c.base.relPath, c.lc.item.relPath)) {
      c.lc = { ...c.lc, state: c.lc.state === 'moved' ? 'unchanged' : 'modified', evidence: [...c.lc.evidence, 'local: move implied by parent folder move'] };
    }
    if (c.rc.relPath !== undefined && (c.rc.state === 'moved' || c.rc.state === 'movedAndModified') && impliedBy(movedRemoteDirs, c.base.relPath, c.rc.relPath)) {
      c.rc = { ...c.rc, state: c.rc.state === 'moved' ? 'unchanged' : 'modified', evidence: [...c.rc.evidence, 'remote: move implied by parent folder move'] };
    }
  }

  for (const { lc, rc } of classified) {
    if (lc.item !== undefined) claimedLocal.add(lc.item.relPath);
    if (rc.item !== undefined) claimedRemote.add(rc.item.uid);
  }

  // Subtree deletion guard. A folder deleted on one side is propagated only when
  // the whole subtree is deletable on the other side: the folder and every
  // baseline descendant unchanged there, and no new items inside it. Otherwise
  // the folder is kept (delete_vs_edit conflict) and its descendants are
  // detached from the baseline so they are re-created rather than removed.
  const detached = new Set<string>();
  const forcedConflict = new Map<string, 'local' | 'remote'>(); // baseline dir path -> side that deleted
  const newLocalPaths = [...local.items.keys()].filter((p) => !claimedLocal.has(p));
  const newRemotePaths = [...resolved.byPath.entries()].filter(([, item]) => !claimedRemote.has(item.uid)).map(([p]) => p);
  for (const c of classified) {
    if (c.base.kind !== 'dir') continue;
    if (detached.has(c.base.relPath)) continue;
    const descendants = classified.filter((d) => isUnder(c.base.relPath, d.base.relPath));
    if (c.rc.state === 'deleted' && c.lc.state !== 'deleted') {
      const localDirPath = c.lc.item?.relPath ?? c.base.relPath;
      // A descendant moved out of the folder remotely is handled by its own move and does not keep the folder alive.
      const movedOutRemotely = (d: (typeof classified)[number]): boolean => d.rc.relPath !== undefined && !isUnder(c.base.relPath, d.rc.relPath) && d.lc.state === 'unchanged';
      const deletable =
        c.lc.state === 'unchanged' &&
        descendants.every((d) => (d.lc.state === 'unchanged' && d.rc.state === 'deleted') || movedOutRemotely(d)) &&
        !newLocalPaths.some((p) => isUnder(localDirPath, p));
      if (!deletable) {
        forcedConflict.set(c.base.relPath, 'remote');
        for (const d of descendants) detached.add(d.base.relPath);
      }
    } else if (c.lc.state === 'deleted' && c.rc.state !== 'deleted') {
      const remoteDirPath = c.rc.relPath ?? c.base.relPath;
      const movedOutLocally = (d: (typeof classified)[number]): boolean => d.lc.item !== undefined && !isUnder(c.base.relPath, d.lc.item.relPath) && d.rc.state === 'unchanged';
      const deletable =
        c.rc.state === 'unchanged' &&
        descendants.every((d) => (d.rc.state === 'unchanged' && d.lc.state === 'deleted') || movedOutLocally(d)) &&
        !newRemotePaths.some((p) => isUnder(remoteDirPath, p));
      if (!deletable) {
        forcedConflict.set(c.base.relPath, 'local');
        for (const d of descendants) detached.add(d.base.relPath);
      }
    }
  }

  for (const { base, lc, rc, rItem } of classified) {
    if (detached.has(base.relPath)) {
      planner.add({ kind: 'remove_baseline', relPath: base.relPath, evidence: ['detached: parent folder is kept despite deletion on one side; item will be re-created'] });
      continue;
    }
    const forced = forcedConflict.get(base.relPath);
    if (forced !== undefined) {
      planner.conflict({
        kind: 'delete_vs_edit',
        relPath: forced === 'remote' ? (lc.item?.relPath ?? base.relPath) : (rc.relPath ?? base.relPath),
        remoteUid: base.remote.uid,
        deletedOn: forced,
        evidence: [...lc.evidence, ...rc.evidence, 'folder kept: its subtree has changes or new items on the other side'],
      });
      continue;
    }

    if (isQuarantined(base.relPath, base.remote.uid) || isQuarantined(lc.item?.relPath, undefined) || isQuarantined(rc.relPath, undefined)) {
      planner.block({ reason: 'quarantined', relPath: base.relPath, remoteUid: base.remote.uid, detail: 'item is quarantined; released items are re-reconciled' });
      continue;
    }
    if (rItem !== undefined && !rItem.isTrashed && rc.item === undefined) {
      // Present remotely but excluded (undecryptable/collision/document): leave both sides alone.
      planner.block({ reason: 'orphan', relPath: base.relPath, remoteUid: base.remote.uid, detail: 'remote counterpart is excluded from sync; nothing is changed' });
      continue;
    }
    if ((lc.item !== undefined && isLocallyBlocked(lc.item.relPath)) || (rc.relPath !== undefined && remoteExcluded(rc.relPath))) {
      planner.block({ reason: 'case_collision', relPath: base.relPath, remoteUid: base.remote.uid, detail: 'item or its ancestor is part of a name collision' });
      continue;
    }
    if (lc.item !== undefined && rc.item !== undefined && lc.item.kind !== (rc.item.kind === 'other' ? 'file' : rc.item.kind)) {
      planner.block({ reason: 'kind_mismatch', relPath: base.relPath, remoteUid: base.remote.uid, detail: 'file on one side, folder on the other' });
      continue;
    }

    // Staleness guard: never trust an absence reported by a view older than the item's last sync
    // (e.g. our own upload finished after the remote listing started).
    if (lc.state === 'deleted' && base.syncedAt !== undefined && local.asOf !== undefined && base.syncedAt > local.asOf) {
      planner.block({ reason: 'stale_view', relPath: base.relPath, remoteUid: base.remote.uid, detail: `local view (${String(local.asOf)}) predates the last sync of this item (${String(base.syncedAt)})` });
      continue;
    }
    if (rc.state === 'deleted' && base.syncedAt !== undefined && remote.asOf !== undefined && base.syncedAt > remote.asOf) {
      planner.block({ reason: 'stale_view', relPath: base.relPath, remoteUid: base.remote.uid, detail: `remote view (${String(remote.asOf)}) predates the last sync of this item (${String(base.syncedAt)})` });
      continue;
    }

    // Local snapshot incomplete: a missing local item may simply be unlisted. Never treat as deleted.
    if (lc.state === 'deleted' && !local.complete) {
      planner.block({ reason: 'orphan', relPath: base.relPath, remoteUid: base.remote.uid, detail: 'local listing incomplete; absence is not trusted' });
      continue;
    }
    if (rc.state === 'deleted' && !remote.complete) {
      planner.block({ reason: 'orphan', relPath: base.relPath, remoteUid: base.remote.uid, detail: 'remote listing incomplete; absence is not trusted' });
      continue;
    }

    applyDecision(planner, base, lc, rc, decide(lc.state, rc.state));
  }

  // 4. Items without baseline.
  for (const i of local.items.values()) {
    if (!claimedLocal.has(i.relPath) && isQuarantined(i.relPath, undefined)) planner.block({ reason: 'quarantined', relPath: i.relPath, remoteUid: undefined, detail: 'local item is quarantined' });
  }
  for (const [p, item] of resolved.byPath) {
    if (!claimedRemote.has(item.uid) && isQuarantined(p, item.uid) && !local.items.has(p)) planner.block({ reason: 'quarantined', relPath: p, remoteUid: item.uid, detail: 'remote item is quarantined' });
  }
  const newLocal = [...local.items.values()].filter((i) => !claimedLocal.has(i.relPath) && !isLocallyBlocked(i.relPath) && !isQuarantined(i.relPath, undefined)).sort((a, b) => a.relPath.localeCompare(b.relPath));
  const newRemote = [...resolved.byPath.entries()]
    .filter(([p, item]) => !claimedRemote.has(item.uid) && !isQuarantined(p, item.uid) && p !== '')
    .sort((a, b) => a[0].localeCompare(b[0]));
  const newRemoteByPath = new Map(newRemote);
  const handledRemote = new Set<string>();

  for (const li of newLocal) {
    const ri = newRemoteByPath.get(li.relPath);
    if (ri !== undefined) {
      handledRemote.add(ri.uid);
      if (ri.kind !== li.kind) {
        planner.block({ reason: 'kind_mismatch', relPath: li.relPath, remoteUid: ri.uid, detail: 'created as a file on one side and a folder on the other' });
        continue;
      }
      if (li.kind === 'dir') {
        planner.add({ kind: 'update_baseline', relPath: li.relPath, itemKind: 'dir', local: localFp(li), remote: remoteFp(ri), evidence: ['folder exists on both sides'] });
        continue;
      }
      const same = sameContent(li.sha1, ri.sha1);
      if (same === true) {
        planner.add({ kind: 'update_baseline', relPath: li.relPath, itemKind: 'file', local: localFp(li), remote: remoteFp(ri), evidence: ['identical content on both sides'] });
      } else {
        planner.conflict({ kind: 'create_create', relPath: li.relPath, remoteUid: ri.uid, evidence: same === undefined ? ['both sides created the file; digests not comparable'] : ['both sides created the file with different content'] });
      }
      continue;
    }
    // Local only: upload or create folder, unless the path is under a remote-excluded subtree.
    if (remoteExcluded(li.relPath)) {
      planner.block({ reason: 'case_collision', relPath: li.relPath, remoteUid: undefined, detail: 'destination is inside an excluded remote subtree' });
      continue;
    }
    if (li.kind === 'dir') planner.add({ kind: 'create_remote_folder', relPath: li.relPath, evidence: ['local: new folder', 'remote: absent'] });
    else planner.add({ kind: 'upload', relPath: li.relPath, mode: 'new', remoteUid: undefined, expectedLocal: localFp(li), expectedRemote: undefined, evidence: ['local: new file', 'remote: absent'] });
  }
  for (const [p, ri] of newRemote) {
    if (handledRemote.has(ri.uid)) continue;
    if (ri.kind === 'dir') planner.add({ kind: 'create_local_folder', relPath: p, remoteUid: ri.uid, evidence: ['remote: new folder', 'local: absent'] });
    else if (ri.kind === 'file') planner.add({ kind: 'download', relPath: p, remoteUid: ri.uid, expectedRemote: remoteFp(ri), expectedLocal: undefined, evidence: ['remote: new file', 'local: absent'] });
  }

  // 5. Completeness gate and first-sync protection.
  let requiresConfirmation: string | null = null;
  const remoteEmptyButBaselineNot = resolved.paths.size === 0 && baseline.size > 0; // nothing syncable under the root
  const withheldReason = (op: Operation): string | null => {
    if (op.kind === 'recycle_local') {
      if (!remote.available) return 'remote unavailable';
      if (!remote.complete) return 'remote listing incomplete';
      if (remoteEmptyButBaselineNot) return 'remote root is empty while the baseline is not';
    }
    if (op.kind === 'trash_remote') {
      if (!local.available) return 'local root unavailable';
      if (!local.complete) return 'local listing incomplete';
    }
    if (firstSync && (op.kind === 'recycle_local' || op.kind === 'trash_remote')) return 'first sync never deletes';
    return null;
  };
  const kept: Operation[] = [];
  for (const op of planner.operations) {
    const reason = withheldReason(op);
    if (reason === null) kept.push(op);
    else planner.withheld.push({ operation: op, reason });
  }
  if (remoteEmptyButBaselineNot && remote.available && remote.complete) requiresConfirmation = 'remote root is empty while the baseline is not: confirm before any local file is removed';
  if (!local.available) {
    // Nothing that reads or writes the local tree can be trusted while the root is missing.
    const safe = kept.filter((o) => o.kind === 'remove_baseline' || o.kind === 'update_baseline');
    const safeIds = new Set(safe.map((o) => o.id));
    planner.withheld.push(...kept.filter((o) => !safeIds.has(o.id)).map((o) => ({ operation: o, reason: 'local root unavailable' })));
    kept.length = 0;
    kept.push(...safe);
  }

  // 6. Occupancy and ordering.
  const occupancy = checkOccupancy(kept, local.items, resolved.byPath);
  for (const b of occupancy.blocked) planner.block(b);
  const { ordered, blocked: orderBlocked } = orderOperations(occupancy.operations);
  for (const b of orderBlocked) planner.block(b);

  const deletes = ordered.filter((o) => o.kind === 'recycle_local' || o.kind === 'trash_remote').length;
  const replaces = ordered.filter((o) => (o.kind === 'download' && o.expectedLocal !== undefined) || (o.kind === 'upload' && o.mode === 'revision')).length;
  const transfers = ordered.filter((o) => o.kind === 'download' || o.kind === 'upload').length;

  return {
    operations: ordered,
    conflicts: planner.conflicts,
    blocked: planner.blocked,
    withheld: planner.withheld,
    requiresConfirmation,
    firstSync,
    stats: { deletes, replaces, transfers },
  };
}

function applyDecision(planner: Planner, base: BaselineItem, lc: LocalClassification, rc: RemoteClassification, action: Action): void {
  const li = lc.item;
  const ri = rc.item;
  const evidence = [...lc.evidence, ...rc.evidence];
  const localPath = li?.relPath ?? base.relPath;
  const remotePathNow = rc.relPath ?? base.relPath;
  // Where the item lives once structural operations (explicit or parent-implied moves) have run.
  const remoteMoved = rc.relPath !== undefined && rc.relPath !== base.relPath;
  const localMoved = li !== undefined && li.relPath !== base.relPath;
  const finalPath = remoteMoved ? remotePathNow : localMoved ? localPath : base.relPath;

  const emitMoveLocal = (): void => {
    if (li === undefined || rc.relPath === undefined) return;
    planner.add({ kind: 'move_local', from: li.relPath, to: rc.relPath, remoteUid: base.remote.uid, expectedLocal: localFp(li), evidence });
  };
  const emitMoveRemote = (): void => {
    if (ri === undefined || li === undefined) return;
    planner.add({ kind: 'move_remote', remoteUid: ri.uid, from: remotePathNow, to: li.relPath, expectedRemote: remoteFp(ri), evidence });
  };
  const emitDownload = (relPath: string): void => {
    if (ri?.kind !== 'file') return;
    planner.add({ kind: 'download', relPath, remoteUid: ri.uid, expectedRemote: remoteFp(ri), expectedLocal: li === undefined ? undefined : localFp(li), evidence });
  };
  const emitUpload = (relPath: string): void => {
    if (li?.kind !== 'file') return;
    planner.add({ kind: 'upload', relPath, mode: 'revision', remoteUid: base.remote.uid, expectedLocal: localFp(li), expectedRemote: ri === undefined ? undefined : remoteFp(ri), evidence });
  };
  const emitBaselineUpdate = (relPath: string): void => {
    if (li === undefined || ri === undefined) return;
    planner.add({ kind: 'update_baseline', relPath, itemKind: base.kind, local: localFp(li), remote: remoteFp(ri), evidence: [...evidence, 'both sides carry the same content'] });
  };
  const compareContent = (relPath: string): void => {
    if (base.kind === 'dir') {
      emitBaselineUpdate(relPath);
      return;
    }
    const same = sameContent(li?.sha1, ri?.sha1);
    if (same === true) emitBaselineUpdate(relPath);
    else planner.conflict({ kind: 'content', relPath, remoteUid: base.remote.uid, evidence: same === undefined ? [...evidence, 'digests not comparable'] : evidence });
  };

  switch (action.type) {
    case 'none':
      // For directories a metadata-only change is nothing; for files nothing changed.
      return;
    case 'download':
      if (base.kind === 'dir') return;
      emitDownload(finalPath);
      return;
    case 'upload':
      if (base.kind === 'dir') return;
      emitUpload(finalPath);
      return;
    case 'move_local':
      emitMoveLocal();
      return;
    case 'move_remote':
      emitMoveRemote();
      return;
    case 'move_local_then_download':
      emitMoveLocal();
      if (rc.relPath !== undefined) emitDownload(rc.relPath);
      return;
    case 'move_local_then_upload':
      emitMoveLocal();
      if (rc.relPath !== undefined) emitUpload(rc.relPath);
      return;
    case 'move_remote_then_download':
      emitMoveRemote();
      emitDownload(localPath);
      return;
    case 'move_remote_then_upload':
      emitMoveRemote();
      emitUpload(localPath);
      return;
    case 'recycle_local':
      if (li === undefined) return;
      planner.add({ kind: 'recycle_local', relPath: li.relPath, itemKind: base.kind, expectedLocal: localFp(li), evidence: [...evidence, 'local unchanged since baseline'] });
      return;
    case 'trash_remote':
      if (ri === undefined) return;
      planner.add({ kind: 'trash_remote', remoteUid: ri.uid, relPath: remotePathNow, itemKind: base.kind, expectedRemote: remoteFp(ri), evidence: [...evidence, 'remote unchanged since baseline'] });
      return;
    case 'remove_baseline':
      planner.add({ kind: 'remove_baseline', relPath: base.relPath, evidence: ['gone on both sides'] });
      return;
    case 'compare_content':
      if (action.after === 'move_local') {
        emitMoveLocal();
        compareContent(rc.relPath ?? localPath);
      } else if (action.after === 'move_remote') {
        emitMoveRemote();
        compareContent(localPath);
      } else {
        compareContent(finalPath);
      }
      return;
    case 'compare_destination': {
      if (li === undefined || rc.relPath === undefined) return;
      if (li.relPath !== rc.relPath) {
        planner.conflict({ kind: 'divergent_move', relPath: base.relPath, remoteUid: base.remote.uid, localPath: li.relPath, remotePath: rc.relPath, evidence });
        return;
      }
      switch (action.whenSame) {
        case 'none':
          emitBaselineUpdate(li.relPath);
          return;
        case 'download':
          emitDownload(li.relPath);
          return;
        case 'upload':
          emitUpload(li.relPath);
          return;
        case 'compare_content':
          compareContent(li.relPath);
          return;
      }
      return;
    }
    case 'conflict_delete_vs_edit':
      planner.conflict({
        kind: 'delete_vs_edit',
        relPath: action.deletedOn === 'remote' ? localPath : remotePathNow,
        remoteUid: base.remote.uid,
        deletedOn: action.deletedOn,
        evidence,
      });
      return;
  }
}


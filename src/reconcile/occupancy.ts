/**
 * Target occupancy: no planned operation may write to a path that is already
 * taken by an unrelated item on that side. Such operations are blocked (and so
 * is everything planned inside the affected subtree) rather than guessed at.
 */
import type { Blocked, LocalItem, Operation, RemoteItem } from './types.js';

function isUnder(prefix: string, p: string): boolean {
  return p === prefix || p.startsWith(`${prefix}/`);
}

function targetPath(op: Operation): string | undefined {
  switch (op.kind) {
    case 'move_local':
    case 'move_remote':
      return op.to;
    case 'create_remote_folder':
    case 'create_local_folder':
    case 'upload':
    case 'download':
      return op.relPath;
    case 'recycle_local':
    case 'trash_remote':
    case 'update_baseline':
    case 'remove_baseline':
      return undefined;
  }
}

export function checkOccupancy(
  operations: Operation[],
  localItems: ReadonlyMap<string, LocalItem>,
  remoteByPath: ReadonlyMap<string, RemoteItem>,
): { operations: Operation[]; blocked: Blocked[] } {
  const movingAwayLocal = new Set(operations.flatMap((o) => (o.kind === 'move_local' ? [o.from] : [])));
  const movingAwayRemote = new Set(operations.flatMap((o) => (o.kind === 'move_remote' ? [o.from] : [])));
  const recycled = new Set(operations.flatMap((o) => (o.kind === 'recycle_local' ? [o.relPath] : [])));
  const trashed = new Set(operations.flatMap((o) => (o.kind === 'trash_remote' ? [o.relPath] : [])));
  const blocked: Blocked[] = [];
  const blockedSubtrees: string[] = [];

  const localFree = (p: string): boolean => !localItems.has(p) || movingAwayLocal.has(p) || recycled.has(p);
  const remoteFree = (p: string): boolean => !remoteByPath.has(p) || movingAwayRemote.has(p) || trashed.has(p);

  for (const op of operations) {
    let problem: string | null = null;
    switch (op.kind) {
      case 'move_local':
        if (!localFree(op.to)) problem = `local path ${op.to} is occupied by another item`;
        break;
      case 'create_local_folder':
        if (!localFree(op.relPath)) problem = `local path ${op.relPath} is occupied`;
        break;
      case 'download': {
        const existing = localItems.get(op.relPath);
        const expected = op.expectedLocal;
        if (existing !== undefined && !movingAwayLocal.has(op.relPath) && (existing.ino !== expected?.ino || existing.dev !== expected.dev)) {
          problem = `local path ${op.relPath} holds an unrelated item; refusing to overwrite it`;
        }
        break;
      }
      case 'move_remote':
        if (!remoteFree(op.to)) problem = `remote path ${op.to} is occupied by another node`;
        break;
      case 'create_remote_folder':
        if (!remoteFree(op.relPath)) problem = `remote path ${op.relPath} is occupied`;
        break;
      case 'upload':
        if (op.mode === 'new' && !remoteFree(op.relPath)) problem = `remote path ${op.relPath} is occupied`;
        break;
      case 'recycle_local':
      case 'trash_remote':
      case 'update_baseline':
      case 'remove_baseline':
        break;
    }
    if (problem !== null) {
      const t = targetPath(op) ?? '';
      blocked.push({ reason: 'target_occupied', relPath: t, remoteUid: 'remoteUid' in op ? op.remoteUid : undefined, detail: problem });
      blockedSubtrees.push(t);
      if (op.kind === 'move_local' || op.kind === 'move_remote') {
        blocked.push({ reason: 'target_occupied', relPath: op.from, remoteUid: 'remoteUid' in op ? op.remoteUid : undefined, detail: `source of a blocked move: ${problem}` });
        blockedSubtrees.push(op.from);
      }
    }
  }
  if (blocked.length === 0) return { operations, blocked };
  const kept = operations.filter((op) => {
    const t = targetPath(op);
    const from = op.kind === 'move_local' || op.kind === 'move_remote' ? op.from : undefined;
    const rel = 'relPath' in op ? op.relPath : undefined;
    return !blockedSubtrees.some((b) => (t !== undefined && isUnder(b, t)) || (from !== undefined && isUnder(b, from)) || (rel !== undefined && isUnder(b, rel)));
  });
  return { operations: kept, blocked };
}

/**
 * Dependency ordering of planned operations.
 *
 * Phases: baseline bookkeeping, folder creation (parents first), moves
 * (shallowest destination first, sources deeper than destinations ordered so
 * a parent move precedes its children), content transfers, then deletes
 * (deepest first). This guarantees:
 *  - parents exist before children are created or moved into them
 *  - moves out of a folder precede that folder's deletion
 *  - content updates follow structural changes to the same item
 */
import type { Blocked, Operation } from './types.js';

function depth(p: string): number {
  return p === '' ? 0 : p.split('/').length;
}

function phase(op: Operation): number {
  switch (op.kind) {
    case 'update_baseline':
    case 'remove_baseline':
      return 0;
    case 'create_remote_folder':
    case 'create_local_folder':
      return 1;
    case 'move_local':
    case 'move_remote':
      return 2;
    case 'upload':
    case 'download':
      return 3;
    case 'recycle_local':
    case 'trash_remote':
      return 4;
  }
}

function key(op: Operation): string {
  switch (op.kind) {
    case 'create_remote_folder':
    case 'create_local_folder':
    case 'upload':
    case 'download':
    case 'recycle_local':
    case 'trash_remote':
    case 'update_baseline':
    case 'remove_baseline':
      return op.relPath;
    case 'move_local':
    case 'move_remote':
      return op.to;
  }
}

/**
 * Order operations. Moves that form a cycle (a -> b while b -> a) cannot be
 * executed directly without temporary names; they are reported as blocked and
 * removed from the plan.
 */
export function orderOperations(operations: Operation[]): { ordered: Operation[]; blocked: Blocked[] } {
  const blocked: Blocked[] = [];
  const moves = operations.filter((o): o is Extract<Operation, { kind: 'move_local' | 'move_remote' }> => o.kind === 'move_local' || o.kind === 'move_remote');
  const cyclic = new Set<string>();
  for (const side of ['move_local', 'move_remote'] as const) {
    const sideMoves = moves.filter((m) => m.kind === side);
    const byFrom = new Map(sideMoves.map((m) => [m.from, m]));
    for (const m of sideMoves) {
      // Follow the chain from m.to; if it leads back to m.from, we have a cycle.
      const seen = new Set<string>([m.from]);
      let cur = byFrom.get(m.to);
      while (cur !== undefined) {
        if (seen.has(cur.from)) break;
        if (cur.to === m.from || seen.has(cur.to)) {
          cyclic.add(m.id);
          cyclic.add(cur.id);
          break;
        }
        seen.add(cur.from);
        cur = byFrom.get(cur.to);
      }
      // Destination occupied by an item that is not moving away is a target_occupied case handled by the planner.
    }
  }
  for (const m of moves) {
    if (cyclic.has(m.id)) blocked.push({ reason: 'move_cycle', relPath: m.from, remoteUid: m.kind === 'move_remote' ? m.remoteUid : undefined, detail: `move ${m.from} -> ${m.to} is part of a cycle` });
  }

  const remaining = operations.filter((o) => !cyclic.has(o.id));
  const ordered = [...remaining].sort((a, b) => {
    const pa = phase(a);
    const pb = phase(b);
    if (pa !== pb) return pa - pb;
    const da = depth(key(a));
    const db = depth(key(b));
    if (pa === 4) {
      // Deletes: deepest first.
      if (da !== db) return db - da;
    } else if (da !== db) {
      return da - db;
    }
    return key(a).localeCompare(key(b)) || a.id.localeCompare(b.id);
  });
  return { ordered, blocked };
}

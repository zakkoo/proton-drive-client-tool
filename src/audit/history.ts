import type { AuditEntry } from './types.js';

export interface HistoryQuery {
  path?: string;
  nodeUid?: string;
}

/**
 * All entries concerning one item, in chronological order, following renames.
 *
 * Identity is propagated in both directions: an entry that mentions a known
 * path, previous path or node UID contributes its other identifiers to the
 * set, and the scan is repeated until the set stops growing. This finds
 * entries written under earlier paths before the queried path existed.
 */
export function history(entries: readonly AuditEntry[], query: HistoryQuery): AuditEntry[] {
  const paths = new Set<string>();
  const uids = new Set<string>();
  if (query.path !== undefined) paths.add(query.path);
  if (query.nodeUid !== undefined) uids.add(query.nodeUid);
  if (paths.size === 0 && uids.size === 0) return [];

  const matches = (e: AuditEntry): boolean =>
    (e.nodeUid !== undefined && uids.has(e.nodeUid)) ||
    (e.path !== undefined && paths.has(e.path)) ||
    (e.previousPath !== undefined && paths.has(e.previousPath));

  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries) {
      if (!matches(e)) continue;
      for (const p of [e.path, e.previousPath]) {
        if (p !== undefined && !paths.has(p)) {
          paths.add(p);
          grew = true;
        }
      }
      if (e.nodeUid !== undefined && !uids.has(e.nodeUid)) {
        uids.add(e.nodeUid);
        grew = true;
      }
    }
  }

  return entries
    .filter(matches)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
}

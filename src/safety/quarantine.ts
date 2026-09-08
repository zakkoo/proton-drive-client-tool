/**
 * Quarantine: items the engine refuses to touch until the user releases them.
 */
import type { AuditLog } from '../audit/logger.js';
import type { QuarantineEntry, QuarantineRepo } from '../state/misc.ts';

export type QuarantineReason = 'digest_mismatch' | 'remote_metadata_inconsistent' | 'unreadable' | 'unknown_outcome' | 'verification_failed' | 'manual';

export class QuarantineService {
  constructor(
    private readonly repo: QuarantineRepo,
    private readonly audit: AuditLog,
  ) {}

  quarantine(item: { relPath: string | null; nodeUid: string | null; reason: QuarantineReason; details?: unknown }): QuarantineEntry {
    const entry = this.repo.add({ relPath: item.relPath, nodeUid: item.nodeUid, reason: item.reason, details: item.details ?? null });
    this.audit.append({
      kind: 'safety',
      op: 'quarantine',
      message: `quarantined ${item.relPath ?? item.nodeUid ?? 'item'}: ${item.reason}`,
      ...(item.relPath !== null ? { path: item.relPath } : {}),
      ...(item.nodeUid !== null ? { nodeUid: item.nodeUid } : {}),
      outcome: 'skipped',
      details: { id: entry.id, ...(typeof item.details === 'object' && item.details !== null ? (item.details as Record<string, unknown>) : {}) },
    });
    return entry;
  }

  release(id: number): QuarantineEntry {
    const entry = this.repo.release(id);
    this.audit.append({
      kind: 'user',
      op: 'release_quarantine',
      message: `user released quarantined item ${String(id)}; it will be re-reconciled from scratch`,
      ...(entry.relPath !== null ? { path: entry.relPath } : {}),
      ...(entry.nodeUid !== null ? { nodeUid: entry.nodeUid } : {}),
      outcome: 'ok',
    });
    return entry;
  }

  open(): QuarantineEntry[] {
    return this.repo.open();
  }

  /** Sets for the reconciler input. */
  sets(): { paths: Set<string>; uids: Set<string> } {
    const paths = new Set<string>();
    const uids = new Set<string>();
    for (const e of this.repo.open()) {
      if (e.relPath !== null) paths.add(e.relPath);
      if (e.nodeUid !== null) uids.add(e.nodeUid);
    }
    return { paths, uids };
  }
}

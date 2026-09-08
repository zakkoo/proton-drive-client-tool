/**
 * Conflict handling.
 *
 * New conflicts reported by the reconciler are turned into safe, journaled
 * steps that keep both versions, plus an inbox entry for the user. The steps
 * are expressed so that the ordinary reconcile cycle finishes the job:
 *
 *  content / create_create   rename the local copy to a conflict name and
 *                            detach the baseline row; next cycle the remote
 *                            version is downloaded to the original path and
 *                            the conflict copy is uploaded
 *  delete_vs_edit            detach the baseline row(s); next cycle the kept
 *                            side is re-created on the other side
 *  divergent_move            nothing automatic; both destinations are recorded
 *                            and the user chooses
 *
 * Inbox resolutions (keep local / keep remote / keep both) are expressed as
 * executor operations (recycle, trash, moves), never permanent deletes.
 */
import { renameSync, statSync } from 'node:fs';
import path from 'node:path';

import type { AuditLog } from '../audit/logger.js';
import type { Conflict, LocalFingerprint, Operation, RemoteFingerprint } from '../reconcile/types.js';
import type { RemoteDrive, RemoteNode } from '../remote/interface.js';
import type { BaselineRepo } from '../state/baseline.ts';
import type { JournalRepo } from '../state/journal.ts';
import type { ConflictEntry, ConflictRepo } from '../state/misc.ts';
import type { StateStore } from '../state/store.ts';
import { machineName, uniqueConflictPath } from './naming.js';

export type Resolution = 'keep_local' | 'keep_remote' | 'keep_both';

export interface ConflictContext {
  root: string;
  remote: RemoteDrive;
  store: StateStore;
  baseline: BaselineRepo;
  journal: JournalRepo;
  conflicts: ConflictRepo;
  audit: AuditLog;
  machine?: string;
  now?: () => Date;
}

export interface ConflictRecord {
  relPath: string;
  /** Path of the preserved local version for content conflicts. */
  conflictCopyPath?: string;
  localPath?: string;
  remotePath?: string;
}

function localFp(root: string, relPath: string): LocalFingerprint | undefined {
  try {
    const st = statSync(path.join(root, relPath));
    return { dev: st.dev, ino: st.ino, size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

function remoteFp(node: RemoteNode): RemoteFingerprint {
  return { uid: node.uid, parentUid: node.parentUid, name: node.name, revisionUid: node.revisionUid, sha1: node.claimedSha1 };
}

export class ConflictHandler {
  private readonly machine: string;
  private readonly now: () => Date;
  private seq = 0;

  constructor(private readonly ctx: ConflictContext) {
    this.machine = ctx.machine ?? machineName();
    this.now = ctx.now ?? (() => new Date());
  }

  private opId(): string {
    this.seq += 1;
    return `conflict-op-${String(this.seq)}`;
  }

  /**
   * Handle the conflicts of a plan. Returns the inbox entries created.
   * Local renames are journaled so a crash between the rename and the baseline
   * update is recoverable (recovery sees a completed local move).
   */
  async handleNew(conflicts: readonly Conflict[]): Promise<ConflictEntry[]> {
    const created: ConflictEntry[] = [];
    for (const c of conflicts) {
      if (this.ctx.conflicts.openForPath(c.relPath) !== null && c.kind !== 'content' && c.kind !== 'create_create') continue;
      switch (c.kind) {
        case 'content':
        case 'create_create':
          created.push(await this.handleContent(c));
          break;
        case 'delete_vs_edit':
          created.push(this.handleDeleteVsEdit(c));
          break;
        case 'divergent_move':
          created.push(this.handleDivergentMove(c));
          break;
      }
    }
    return created;
  }

  private async handleContent(c: Conflict): Promise<ConflictEntry> {
    const local = localFp(this.ctx.root, c.relPath);
    const remoteNode = c.remoteUid !== undefined ? await this.ctx.remote.getNode(c.remoteUid) : null;
    const exists = (p: string): boolean => {
      try {
        statSync(path.join(this.ctx.root, p));
        return true;
      } catch {
        return this.ctx.baseline.byPath(p) !== null;
      }
    };
    const copyPath = uniqueConflictPath(c.relPath, this.machine, this.now(), exists);
    if (local !== undefined) {
      // Journal the local rename as a move so recovery can finish it.
      const entry = this.ctx.journal.plan({ op: 'conflict_rename_local', relPath: copyPath, previousRelPath: c.relPath, nodeUid: c.remoteUid ?? null, intended: { kind: 'conflict_rename_local', from: c.relPath, to: copyPath }, preState: { local } });
      this.ctx.journal.start(entry.id);
      renameSync(path.join(this.ctx.root, c.relPath), path.join(this.ctx.root, copyPath));
      this.ctx.store.transaction(() => {
        // The original path now belongs to the remote version only; the copy is a new local file.
        this.ctx.baseline.remove(c.relPath);
        this.ctx.journal.complete(entry.id, { renamedTo: copyPath });
      });
    } else {
      this.ctx.baseline.remove(c.relPath);
    }
    const record = this.ctx.conflicts.add({
      relPath: c.relPath,
      nodeUid: c.remoteUid ?? null,
      kind: c.kind,
      local: { path: copyPath, fingerprint: local ?? null },
      remote: remoteNode === null ? null : { uid: remoteNode.uid, revisionUid: remoteNode.revisionUid, sha1: remoteNode.claimedSha1, size: remoteNode.claimedSize },
    });
    this.ctx.audit.append({
      kind: 'conflict',
      op: c.kind,
      message: `conflict on ${c.relPath}: local version kept as ${copyPath}, remote version will occupy ${c.relPath}`,
      path: c.relPath,
      ...(c.remoteUid !== undefined ? { nodeUid: c.remoteUid } : {}),
      details: { conflictId: record.id, copyPath, evidence: c.evidence },
    });
    return record;
  }

  private handleDeleteVsEdit(c: Conflict): ConflictEntry {
    // Detach: the kept side becomes "new" and is re-created on the other side by the next cycle.
    const removed = this.ctx.baseline.removeSubtree(c.relPath);
    if (c.remoteUid !== undefined) this.ctx.baseline.removeByNodeUid(c.remoteUid);
    const record = this.ctx.conflicts.add({
      relPath: c.relPath,
      nodeUid: c.remoteUid ?? null,
      kind: c.kind,
      local: { deleted: c.deletedOn === 'local' },
      remote: { deleted: c.deletedOn === 'remote' },
    });
    this.ctx.audit.append({
      kind: 'conflict',
      op: c.kind,
      message: `${c.deletedOn === 'remote' ? 'deleted remotely but changed locally' : 'deleted locally but changed remotely'}: ${c.relPath} is kept and will be re-created on the other side`,
      path: c.relPath,
      ...(c.remoteUid !== undefined ? { nodeUid: c.remoteUid } : {}),
      details: { conflictId: record.id, detachedRows: removed, evidence: c.evidence },
    });
    return record;
  }

  private handleDivergentMove(c: Conflict): ConflictEntry {
    const record = this.ctx.conflicts.add({
      relPath: c.relPath,
      nodeUid: c.remoteUid ?? null,
      kind: c.kind,
      local: { path: c.localPath },
      remote: { path: c.remotePath },
    });
    this.ctx.audit.append({
      kind: 'conflict',
      op: c.kind,
      message: `${c.relPath} was moved to ${c.localPath ?? '?'} locally and to ${c.remotePath ?? '?'} remotely; waiting for the user`,
      path: c.relPath,
      ...(c.remoteUid !== undefined ? { nodeUid: c.remoteUid } : {}),
      details: { conflictId: record.id, evidence: c.evidence },
    });
    return record;
  }

  /**
   * Resolve an inbox entry. Returns executor operations to run (may be empty).
   * Every removal is a recycle or a trash; nothing is permanently deleted.
   */
  async resolve(id: number, choice: Resolution): Promise<Operation[]> {
    const entry = this.ctx.conflicts.get(id);
    if (entry.resolvedAt !== null) throw new Error(`Conflict ${String(id)} is already resolved`);
    const ops: Operation[] = [];
    if (entry.kind === 'content' || entry.kind === 'create_create') {
      const copyPath = (entry.local as { path?: string }).path;
      if (choice === 'keep_remote' && copyPath !== undefined) ops.push(...(await this.removeBothSides(copyPath)));
      if (choice === 'keep_local' && copyPath !== undefined) {
        ops.push(...(await this.removeBothSides(entry.relPath)));
        ops.push(...(await this.moveBothSides(copyPath, entry.relPath)));
      }
    } else if (entry.kind === 'divergent_move') {
      const localPath = (entry.local as { path?: string }).path;
      const remotePath = (entry.remote as { path?: string }).path;
      if (choice === 'keep_local' && localPath !== undefined && remotePath !== undefined && entry.nodeUid !== null) {
        const node = await this.ctx.remote.getNode(entry.nodeUid);
        if (node !== null) ops.push({ id: this.opId(), kind: 'move_remote', remoteUid: node.uid, from: remotePath, to: localPath, expectedRemote: remoteFp(node), evidence: ['user chose the local destination'] });
        this.ctx.baseline.rename(entry.relPath, localPath);
      }
      if (choice === 'keep_remote' && localPath !== undefined && remotePath !== undefined && entry.nodeUid !== null) {
        const local = localFp(this.ctx.root, localPath);
        if (local !== undefined) ops.push({ id: this.opId(), kind: 'move_local', from: localPath, to: remotePath, remoteUid: entry.nodeUid, expectedLocal: local, evidence: ['user chose the remote destination'] });
        this.ctx.baseline.rename(entry.relPath, remotePath);
      }
      if (choice === 'keep_both') {
        // Detach: both destinations become new items and are created on the other side.
        this.ctx.baseline.removeSubtree(entry.relPath);
        if (entry.nodeUid !== null) this.ctx.baseline.removeByNodeUid(entry.nodeUid);
      }
    }
    // delete_vs_edit: the kept side was already re-created; any choice just closes the entry.
    this.ctx.conflicts.resolve(id, choice);
    this.ctx.audit.append({ kind: 'user', op: 'resolve_conflict', message: `user resolved conflict ${String(id)} on ${entry.relPath}: ${choice}`, path: entry.relPath, ...(entry.nodeUid !== null ? { nodeUid: entry.nodeUid } : {}), outcome: 'ok', details: { operations: ops.map((o) => o.kind) } });
    return ops;
  }

  /** Recycle the local item and trash the remote item at `relPath`, using current fingerprints. */
  private async removeBothSides(relPath: string): Promise<Operation[]> {
    const ops: Operation[] = [];
    const row = this.ctx.baseline.byPath(relPath);
    const local = localFp(this.ctx.root, relPath);
    if (local !== undefined) ops.push({ id: this.opId(), kind: 'recycle_local', relPath, itemKind: row?.kind ?? 'file', expectedLocal: local, evidence: ['conflict resolution'] });
    if (row !== null) {
      const node = await this.ctx.remote.getNode(row.nodeUid);
      if (node !== null && !node.isTrashed) ops.push({ id: this.opId(), kind: 'trash_remote', remoteUid: node.uid, relPath, itemKind: row.kind, expectedRemote: remoteFp(node), evidence: ['conflict resolution'] });
    }
    return ops;
  }

  /** Rename the synced item at `from` to `to` on both sides (remote first, then local follows). */
  private async moveBothSides(from: string, to: string): Promise<Operation[]> {
    const row = this.ctx.baseline.byPath(from);
    if (row === null) return [];
    const node = await this.ctx.remote.getNode(row.nodeUid);
    const local = localFp(this.ctx.root, from);
    if (node === null || local === undefined) return [];
    return [
      { id: this.opId(), kind: 'move_remote', remoteUid: node.uid, from, to, expectedRemote: remoteFp(node), evidence: ['conflict resolution: keep local'] },
      { id: this.opId(), kind: 'move_local', from, to, remoteUid: node.uid, expectedLocal: local, evidence: ['conflict resolution: keep local'] },
    ];
  }
}

/**
 * Startup recovery over the journal. Runs before any new plan.
 *
 * For every unresolved entry, both sides are inspected to decide whether the
 * operation took effect:
 *  - took effect        -> complete (baseline updated) without redoing it
 *  - clearly did not    -> failed (the item is simply replanned)
 *  - cannot be decided  -> abandoned and quarantined; nothing is deleted
 * Entries still 'planned' were never started: abandoned.
 * Leftover temporary download files are removed (they are ours).
 */
import { readdirSync, statSync, type Stats } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

import type { BaselineRow } from '../state/baseline.ts';
import type { Operation } from '../reconcile/types.js';
import type { RemoteNode } from '../remote/interface.js';
import { sha1File } from '../remote/transfer.js';
import { tempDir } from './localWrite.js';
import type { ExecutorContext } from './types.js';

export interface RecoveryReport {
  completed: number;
  failed: number;
  abandoned: number;
  tempFilesRemoved: number;
}

type Verdict = { kind: 'completed'; upserts: BaselineRow[]; removeSubtrees: string[]; renames: { from: string; to: string }[]; note: string } | { kind: 'failed'; note: string } | { kind: 'abandoned'; note: string };

function nameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export async function recoverJournal(ctx: ExecutorContext): Promise<RecoveryReport> {
  const report: RecoveryReport = { completed: 0, failed: 0, abandoned: 0, tempFilesRemoved: 0 };

  // Our own temp files from interrupted downloads.
  try {
    for (const f of readdirSync(tempDir(ctx.root))) {
      await unlink(path.join(tempDir(ctx.root), f));
      report.tempFilesRemoved++;
    }
  } catch {
    // no temp dir yet
  }

  for (const entry of ctx.journal.unresolved()) {
    const op = entry.intended as Operation;
    if (entry.status === 'planned') {
      ctx.journal.abandon(entry.id, 'never started before restart');
      ctx.audit.append({ kind: 'recovery', op: op.kind, message: `abandoned planned ${op.kind} (never started)`, ...(entry.relPath !== null ? { path: entry.relPath } : {}), details: { journalId: entry.id } });
      report.abandoned++;
      continue;
    }
    let verdict: Verdict;
    try {
      verdict = await inspect(ctx, op);
    } catch (error) {
      verdict = { kind: 'abandoned', note: `inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    switch (verdict.kind) {
      case 'completed':
        ctx.store.transaction(() => {
          for (const r of verdict.renames) ctx.baseline.rename(r.from, r.to);
          for (const p of verdict.removeSubtrees) ctx.baseline.removeSubtree(p);
          for (const row of verdict.upserts) ctx.baseline.upsert(row);
          ctx.journal.complete(entry.id, { recovered: true, note: verdict.note });
        });
        report.completed++;
        break;
      case 'failed':
        ctx.journal.fail(entry.id, `recovery: ${verdict.note}`);
        report.failed++;
        break;
      case 'abandoned':
        ctx.journal.abandon(entry.id, `recovery: ${verdict.note}`);
        ctx.quarantine.quarantine({ relPath: entry.relPath, nodeUid: entry.nodeUid, reason: 'unknown_outcome', details: { journalId: entry.id, op: op.kind, note: verdict.note } });
        report.abandoned++;
        break;
    }
    ctx.audit.append({
      kind: 'recovery',
      op: op.kind,
      message: `recovered in-progress ${op.kind}: ${verdict.kind} (${verdict.note})`,
      ...(entry.relPath !== null ? { path: entry.relPath } : {}),
      ...(entry.nodeUid !== null ? { nodeUid: entry.nodeUid } : {}),
      outcome: verdict.kind === 'completed' ? 'ok' : verdict.kind === 'failed' ? 'failed' : 'abandoned',
      details: { journalId: entry.id },
    });
  }
  return report;
}

function row(ctx: ExecutorContext, relPath: string, kind: 'file' | 'dir', node: RemoteNode, sha1: string | null): BaselineRow {
  const st = statSync(path.join(ctx.root, relPath));
  return {
    relPath,
    kind,
    localDev: st.dev,
    localIno: st.ino,
    localSize: kind === 'file' ? st.size : 0,
    localMtimeMs: st.mtimeMs,
    localSha1: sha1,
    nodeUid: node.uid,
    parentUid: node.parentUid ?? null,
    remoteName: node.name,
    revisionUid: node.revisionUid ?? null,
    remoteSha1: node.claimedSha1 ?? null,
    syncedAt: ctx.now?.() ?? Date.now(),
  };
}

function localExists(ctx: ExecutorContext, relPath: string): Stats | null {
  try {
    return statSync(path.join(ctx.root, relPath));
  } catch {
    return null;
  }
}

async function inspect(ctx: ExecutorContext, op: Operation): Promise<Verdict> {
  const { remote } = ctx;
  switch (op.kind) {
    case 'upload': {
      const local = localExists(ctx, op.relPath);
      if (local === null) return { kind: 'abandoned', note: 'local source is gone; cannot verify what was uploaded' };
      const { sha1 } = await sha1File(path.join(ctx.root, op.relPath));
      if (op.mode === 'revision' && op.remoteUid !== undefined) {
        const node = await remote.getNode(op.remoteUid);
        if (node?.claimedSha1 === sha1) return { kind: 'completed', upserts: [row(ctx, op.relPath, 'file', node, sha1)], removeSubtrees: [], renames: [], note: 'remote already holds the uploaded revision' };
        return { kind: 'failed', note: 'remote does not hold the uploaded content' };
      }
      const parentRow = op.relPath.includes('/') ? ctx.baseline.byPath(op.relPath.slice(0, op.relPath.lastIndexOf('/'))) : null;
      const parentUid = op.relPath.includes('/') ? parentRow?.nodeUid : ctx.remoteRootUid;
      if (parentUid === undefined) return { kind: 'failed', note: 'remote parent unknown; will be replanned' };
      const match = (await remote.listChildren(parentUid)).find((c) => c.name === nameOf(op.relPath) && !c.isTrashed && c.type === 'file');
      if (match?.claimedSha1 === sha1) return { kind: 'completed', upserts: [row(ctx, op.relPath, 'file', match, sha1)], removeSubtrees: [], renames: [], note: 'remote already holds the uploaded file' };
      return { kind: 'failed', note: match === undefined ? 'upload did not land' : 'a different file is at the destination' };
    }
    case 'download': {
      const node = await remote.getNode(op.remoteUid);
      const local = localExists(ctx, op.relPath);
      if (node === null) return { kind: 'failed', note: 'remote node gone; replanned' };
      if (local?.isFile() !== true) return { kind: 'failed', note: 'download did not complete; replanned' };
      const previous = op.expectedLocal;
      if (local.ino === previous?.ino && local.mtimeMs === previous.mtimeMs && local.size === previous.size) {
        return { kind: 'failed', note: 'target still holds the previous version; replanned' };
      }
      const { sha1 } = await sha1File(path.join(ctx.root, op.relPath));
      if (node.claimedSha1 !== undefined && node.claimedSha1 === sha1) return { kind: 'completed', upserts: [row(ctx, op.relPath, 'file', node, sha1)], removeSubtrees: [], renames: [], note: 'downloaded content is in place' };
      if (node.claimedSha1 === undefined) return { kind: 'abandoned', note: 'no remote digest to verify the downloaded file against' };
      return { kind: 'abandoned', note: 'local file matches neither the previous nor the remote version' };
    }
    case 'move_local': {
      const src = localExists(ctx, op.from);
      const dst = localExists(ctx, op.to);
      if (src !== null && dst === null) return { kind: 'failed', note: 'move not performed; replanned' };
      if (src === null && dst !== null && dst.ino === op.expectedLocal.ino) {
        const node = await remote.getNode(op.remoteUid);
        if (node === null) return { kind: 'abandoned', note: 'moved locally but the remote node is gone' };
        const old = ctx.baseline.byPath(op.from);
        return { kind: 'completed', upserts: [row(ctx, op.to, dst.isDirectory() ? 'dir' : 'file', node, old?.localSha1 ?? null)], removeSubtrees: [], renames: [{ from: op.from, to: op.to }], note: 'local move already done' };
      }
      return { kind: 'abandoned', note: 'neither the source nor the expected destination is in the planned state' };
    }
    case 'move_remote': {
      const node = await remote.getNode(op.remoteUid);
      if (node === null) return { kind: 'abandoned', note: 'remote node gone during move' };
      const parentRow = op.to.includes('/') ? ctx.baseline.byPath(op.to.slice(0, op.to.lastIndexOf('/'))) : null;
      const targetParent = op.to.includes('/') ? parentRow?.nodeUid : ctx.remoteRootUid;
      if (targetParent !== undefined && node.parentUid === targetParent && node.name === nameOf(op.to)) {
        const old = ctx.baseline.byPath(op.from);
        const local = localExists(ctx, op.to);
        if (local === null) return { kind: 'abandoned', note: 'remote moved but the local item is not at the destination' };
        return { kind: 'completed', upserts: [row(ctx, op.to, node.type === 'folder' ? 'dir' : 'file', node, old?.localSha1 ?? null)], removeSubtrees: [], renames: [{ from: op.from, to: op.to }], note: 'remote move already done' };
      }
      return { kind: 'failed', note: 'remote move not performed; replanned' };
    }
    case 'recycle_local': {
      const local = localExists(ctx, op.relPath);
      if (local !== null) return { kind: 'failed', note: 'item still present; replanned' };
      const recycled = ctx.recycle.list().some((r) => r.relPath === op.relPath);
      if (recycled) return { kind: 'completed', upserts: [], removeSubtrees: [op.relPath], renames: [], note: 'item is in the recycle bin' };
      return { kind: 'abandoned', note: 'item is gone but not in the recycle bin' };
    }
    case 'trash_remote': {
      const node = await remote.getNode(op.remoteUid);
      if (node === null || node.isTrashed) return { kind: 'completed', upserts: [], removeSubtrees: [op.relPath], renames: [], note: 'remote node is trashed' };
      return { kind: 'failed', note: 'remote node not trashed; replanned' };
    }
    case 'create_remote_folder': {
      const parentRow = op.relPath.includes('/') ? ctx.baseline.byPath(op.relPath.slice(0, op.relPath.lastIndexOf('/'))) : null;
      const parentUid = op.relPath.includes('/') ? parentRow?.nodeUid : ctx.remoteRootUid;
      if (parentUid === undefined) return { kind: 'failed', note: 'remote parent unknown; replanned' };
      const match = (await remote.listChildren(parentUid)).find((c) => c.name === nameOf(op.relPath) && !c.isTrashed && c.type === 'folder');
      if (match !== undefined && localExists(ctx, op.relPath) !== null) return { kind: 'completed', upserts: [row(ctx, op.relPath, 'dir', match, null)], removeSubtrees: [], renames: [], note: 'remote folder exists' };
      return { kind: 'failed', note: 'remote folder not created; replanned' };
    }
    case 'create_local_folder': {
      const node = await remote.getNode(op.remoteUid);
      const local = localExists(ctx, op.relPath);
      if (node !== null && local?.isDirectory() === true) return { kind: 'completed', upserts: [row(ctx, op.relPath, 'dir', node, null)], removeSubtrees: [], renames: [], note: 'local folder exists' };
      return { kind: 'failed', note: 'local folder not created; replanned' };
    }
    case 'update_baseline':
    case 'remove_baseline':
      return { kind: 'failed', note: `bookkeeping ${op.kind} is never journaled` };
  }
}

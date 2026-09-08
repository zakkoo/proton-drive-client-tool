/**
 * Model world for reconciler tests: an in-memory local tree and remote tree
 * with baseline, plus a model executor that applies a Plan the way the real
 * executor would (recycle instead of delete, trash instead of delete, conflict
 * copies kept). Used by unit tests and the property-based convergence test.
 */
import { createHash } from 'node:crypto';

import type { BaselineItem, LocalItem, Plan, ReconcileInput, RemoteItem } from '../reconcile/types.js';

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export interface ModelFile {
  kind: 'file';
  content: string;
  ino: number;
  mtimeMs: number;
}
export interface ModelDir {
  kind: 'dir';
  ino: number;
}
export type ModelEntry = ModelFile | ModelDir;

export interface RemoteModelNode {
  uid: string;
  parentUid: string | undefined;
  name: string;
  kind: 'file' | 'dir';
  content?: string;
  revision: string;
  trashed: boolean;
}

export class World {
  readonly local = new Map<string, ModelEntry>();
  readonly remote = new Map<string, RemoteModelNode>();
  readonly baseline = new Map<string, BaselineItem>();
  readonly recycled: { relPath: string; content?: string }[] = [];
  /** Superseded remote revisions (Proton keeps revision history). */
  readonly revisions: string[] = [];
  readonly rootUid = 'root';
  private nextIno = 1;
  private nextUid = 1;
  private nextRev = 1;
  clock = 1_000_000;

  constructor() {
    this.remote.set(this.rootUid, { uid: this.rootUid, parentUid: undefined, name: '', kind: 'dir', revision: 'r0', trashed: false });
  }

  // ---- helpers ---------------------------------------------------------

  tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private newIno(): number {
    return this.nextIno++;
  }
  private newUid(): string {
    return `n${String(this.nextUid++)}`;
  }
  private newRev(): string {
    return `r${String(this.nextRev++)}`;
  }

  localWrite(relPath: string, content: string): void {
    this.ensureLocalParents(relPath);
    const existing = this.local.get(relPath);
    if (existing?.kind === 'file') {
      existing.content = content;
      existing.mtimeMs = this.tick();
    } else {
      this.local.set(relPath, { kind: 'file', content, ino: this.newIno(), mtimeMs: this.tick() });
    }
  }

  localMkdir(relPath: string): void {
    this.ensureLocalParents(relPath);
    if (!this.local.has(relPath)) this.local.set(relPath, { kind: 'dir', ino: this.newIno() });
  }

  private ensureLocalParents(relPath: string): void {
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!this.local.has(p)) this.local.set(p, { kind: 'dir', ino: this.newIno() });
    }
  }

  localDelete(relPath: string): void {
    for (const k of [...this.local.keys()]) if (k === relPath || k.startsWith(`${relPath}/`)) this.local.delete(k);
  }

  localMove(from: string, to: string): void {
    this.ensureLocalParents(to);
    const moved: [string, ModelEntry][] = [];
    for (const [k, v] of [...this.local]) {
      if (k === from || k.startsWith(`${from}/`)) {
        moved.push([to + k.slice(from.length), v]);
        this.local.delete(k);
      }
    }
    for (const [k, v] of moved) this.local.set(k, v);
  }

  remotePathOf(uid: string): string | undefined {
    const parts: string[] = [];
    let cur = this.remote.get(uid);
    if (cur === undefined) return undefined;
    while (cur.parentUid !== undefined) {
      if (cur.trashed) return undefined;
      parts.unshift(cur.name);
      const parent = this.remote.get(cur.parentUid);
      if (parent === undefined) return undefined;
      cur = parent;
    }
    return parts.join('/');
  }

  remoteByPath(relPath: string): RemoteModelNode | undefined {
    for (const n of this.remote.values()) {
      if (n.uid !== this.rootUid && !n.trashed && this.remotePathOf(n.uid) === relPath) return n;
    }
    return undefined;
  }

  remoteWrite(relPath: string, content: string): RemoteModelNode {
    const parentUid = this.ensureRemoteParents(relPath);
    const existing = this.remoteByPath(relPath);
    if (existing?.kind === 'file') {
      existing.content = content;
      existing.revision = this.newRev();
      return existing;
    }
    const node: RemoteModelNode = { uid: this.newUid(), parentUid, name: relPath.split('/').at(-1) ?? relPath, kind: 'file', content, revision: this.newRev(), trashed: false };
    this.remote.set(node.uid, node);
    return node;
  }

  remoteMkdir(relPath: string): RemoteModelNode {
    const parentUid = this.ensureRemoteParents(relPath);
    const existing = this.remoteByPath(relPath);
    if (existing !== undefined) return existing;
    const node: RemoteModelNode = { uid: this.newUid(), parentUid, name: relPath.split('/').at(-1) ?? relPath, kind: 'dir', revision: this.newRev(), trashed: false };
    this.remote.set(node.uid, node);
    return node;
  }

  private ensureRemoteParents(relPath: string): string {
    const parts = relPath.split('/');
    let parentUid = this.rootUid;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      const existing = this.remoteByPath(p);
      if (existing !== undefined) parentUid = existing.uid;
      else {
        const node: RemoteModelNode = { uid: this.newUid(), parentUid, name: parts[i] ?? '', kind: 'dir', revision: this.newRev(), trashed: false };
        this.remote.set(node.uid, node);
        parentUid = node.uid;
      }
    }
    return parentUid;
  }

  remoteTrash(relPath: string): void {
    const n = this.remoteByPath(relPath);
    if (n !== undefined) n.trashed = true;
  }

  remoteMove(from: string, to: string): void {
    const n = this.remoteByPath(from);
    if (n === undefined) return;
    const parentUid = this.ensureRemoteParents(to);
    n.parentUid = parentUid;
    n.name = to.split('/').at(-1) ?? to;
  }

  /** Record both sides as in sync for a path (used to build baselines in tests). */
  markSynced(relPath: string): void {
    const l = this.local.get(relPath);
    const r = this.remoteByPath(relPath);
    if (l === undefined || r === undefined) throw new Error(`cannot mark ${relPath} synced: missing on a side`);
    this.baseline.set(relPath, {
      relPath,
      kind: l.kind,
      local: { dev: 1, ino: l.ino, size: l.kind === 'file' ? l.content.length : 0, mtimeMs: l.kind === 'file' ? l.mtimeMs : 0, sha1: l.kind === 'file' ? sha1(l.content) : null },
      remote: { uid: r.uid, parentUid: r.parentUid ?? null, name: r.name, revisionUid: r.revision, sha1: r.kind === 'file' ? sha1(r.content ?? '') : null },
    });
  }

  markAllSynced(): void {
    for (const p of this.local.keys()) if (this.remoteByPath(p) !== undefined) this.markSynced(p);
  }

  // ---- views -----------------------------------------------------------

  input(over: Partial<ReconcileInput> = {}): ReconcileInput {
    const localItems = new Map<string, LocalItem>();
    for (const [p, e] of this.local) {
      localItems.set(p, e.kind === 'file' ? { relPath: p, kind: 'file', dev: 1, ino: e.ino, size: e.content.length, mtimeMs: e.mtimeMs, sha1: sha1(e.content) } : { relPath: p, kind: 'dir', dev: 1, ino: e.ino, size: 0, mtimeMs: 0 });
    }
    const remoteItems = new Map<string, RemoteItem>();
    for (const n of this.remote.values()) {
      remoteItems.set(n.uid, {
        uid: n.uid,
        parentUid: n.parentUid,
        name: n.name,
        kind: n.kind,
        nameStatus: 'ok',
        isTrashed: n.trashed,
        isProtonDocument: false,
        revisionUid: n.revision,
        sha1: n.kind === 'file' ? sha1(n.content ?? '') : undefined,
        size: n.content?.length,
      });
    }
    return {
      baseline: new Map(this.baseline),
      local: { items: localItems, complete: true, available: true },
      remote: { items: remoteItems, rootUid: this.rootUid, complete: true, available: true },
      ...over,
    };
  }

  // ---- model executor ----------------------------------------------------

  /**
   * Apply a plan the way the executor would. When `confirmWithheld` is set,
   * operations the gate withheld pending user confirmation are applied too
   * (modelling the user pressing "proceed").
   */
  apply(plan: Plan, options: { confirmWithheld?: boolean } = {}): void {
    const operations = options.confirmWithheld === true && plan.requiresConfirmation !== null ? [...plan.operations, ...plan.withheld.map((w) => w.operation)] : plan.operations;
    for (const op of operations) {
      switch (op.kind) {
        case 'create_remote_folder':
          this.remoteMkdir(op.relPath);
          break;
        case 'create_local_folder':
          this.localMkdir(op.relPath);
          break;
        case 'upload': {
          const l = this.local.get(op.relPath);
          if (l?.kind !== 'file') break;
          if (op.mode === 'new') this.remoteWrite(op.relPath, l.content);
          else {
            const n = this.remote.get(op.remoteUid ?? '');
            if (n === undefined) break;
            if (n.content !== undefined) this.revisions.push(n.content);
            n.content = l.content;
            n.revision = this.newRev();
          }
          break;
        }
        case 'download': {
          const n = this.remote.get(op.remoteUid);
          if (n?.kind !== 'file') break;
          const existing = this.local.get(op.relPath);
          if (existing?.kind === 'file') this.recycled.push({ relPath: op.relPath, content: existing.content });
          this.ensureLocalParents(op.relPath);
          this.local.set(op.relPath, { kind: 'file', content: n.content ?? '', ino: this.newIno(), mtimeMs: this.tick() });
          break;
        }
        case 'move_local':
          this.localMove(op.from, op.to);
          break;
        case 'move_remote': {
          const n = this.remote.get(op.remoteUid);
          if (n === undefined) break;
          const parentUid = this.ensureRemoteParents(op.to);
          n.parentUid = parentUid;
          n.name = op.to.split('/').at(-1) ?? op.to;
          break;
        }
        case 'recycle_local': {
          for (const [k, v] of [...this.local]) {
            if (k === op.relPath || k.startsWith(`${op.relPath}/`)) {
              this.recycled.push(v.kind === 'file' ? { relPath: k, content: v.content } : { relPath: k });
              this.local.delete(k);
            }
          }
          break;
        }
        case 'trash_remote': {
          const n = this.remote.get(op.remoteUid);
          if (n !== undefined) n.trashed = true;
          break;
        }
        case 'update_baseline':
          break;
        case 'remove_baseline':
          this.baseline.delete(op.relPath);
          break;
      }
    }
    // Refresh the baseline for everything that now matches on both sides (what the executor's commit does).
    for (const op of operations) {
      const paths = op.kind === 'move_local' || op.kind === 'move_remote' ? [op.to] : 'relPath' in op ? [op.relPath] : [];
      for (const p of paths) {
        if (op.kind === 'remove_baseline' || op.kind === 'recycle_local' || op.kind === 'trash_remote') {
          this.baseline.delete(p);
          continue;
        }
        if (this.local.has(p) && this.remoteByPath(p) !== undefined) {
          // Moves keep the old baseline path around; drop it.
          if (op.kind === 'move_local' || op.kind === 'move_remote') this.baseline.delete(op.from);
          this.markSynced(p);
        }
      }
      if (op.kind === 'move_local' || op.kind === 'move_remote') {
        // Descendants of a moved folder follow along.
        for (const [bp] of [...this.baseline]) {
          if (bp.startsWith(`${op.from}/`)) {
            this.baseline.delete(bp);
            const np = op.to + bp.slice(op.from.length);
            if (this.local.has(np) && this.remoteByPath(np) !== undefined) this.markSynced(np);
          }
        }
      }
    }
    // Conflicts: the conflict module keeps both versions; model that by uploading the local copy
    // under a conflict name and downloading the remote one to the original path.
    for (const c of plan.conflicts) {
      if (c.kind === 'content' || c.kind === 'create_create') {
        const l = this.local.get(c.relPath);
        const r = this.remoteByPath(c.relPath);
        if (l?.kind === 'file' && r?.kind === 'file') {
          const conflictName = `${c.relPath}.conflict-${String(this.tick())}`;
          this.local.set(conflictName, { kind: 'file', content: l.content, ino: this.newIno(), mtimeMs: this.tick() });
          this.remoteWrite(conflictName, l.content);
          this.local.set(c.relPath, { kind: 'file', content: r.content ?? '', ino: this.newIno(), mtimeMs: this.tick() });
          this.markSynced(conflictName);
          this.markSynced(c.relPath);
        }
      } else if (c.kind === 'delete_vs_edit') {
        if (c.deletedOn === 'remote') {
          const l = this.local.get(c.relPath);
          if (l?.kind === 'file') {
            this.remoteWrite(c.relPath, l.content);
            this.markSynced(c.relPath);
          } else if (l?.kind === 'dir') {
            this.remoteMkdir(c.relPath);
            this.markSynced(c.relPath);
          }
        } else {
          const r = this.remoteByPath(c.relPath);
          if (r?.kind === 'file') {
            this.ensureLocalParents(c.relPath);
            this.local.set(c.relPath, { kind: 'file', content: r.content ?? '', ino: this.newIno(), mtimeMs: this.tick() });
            this.markSynced(c.relPath);
          } else if (r?.kind === 'dir') {
            this.localMkdir(c.relPath);
            this.markSynced(c.relPath);
          }
        }
        // Old baseline path (if the item moved) is stale now.
        for (const [bp, b] of [...this.baseline]) if (b.remote.uid === c.remoteUid && bp !== c.relPath) this.baseline.delete(bp);
      } else {
        // divergent_move: keep both places by copying the remote one locally under its path and the local one remotely.
        const l = c.localPath !== undefined ? this.local.get(c.localPath) : undefined;
        const r = this.remote.get(c.remoteUid ?? '');
        if (l?.kind === 'file' && c.localPath !== undefined) {
          this.remoteWrite(c.localPath, l.content);
          this.markSynced(c.localPath);
        }
        if (r?.kind === 'file' && c.remotePath !== undefined) {
          this.ensureLocalParents(c.remotePath);
          this.local.set(c.remotePath, { kind: 'file', content: r.content ?? '', ino: this.newIno(), mtimeMs: this.tick() });
          this.markSynced(c.remotePath);
        }
        this.baseline.delete(c.relPath);
      }
    }
  }

  /** Files (path -> content) on each side, ignoring directories. */
  localFiles(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [p, e] of this.local) if (e.kind === 'file') out.set(p, e.content);
    return out;
  }
  remoteFiles(): Map<string, string> {
    const out = new Map<string, string>();
    for (const n of this.remote.values()) {
      if (n.kind !== 'file' || n.trashed) continue;
      const p = this.remotePathOf(n.uid);
      if (p !== undefined) out.set(p, n.content ?? '');
    }
    return out;
  }
  trashedContents(): string[] {
    return [...this.remote.values()].filter((n) => n.trashed && n.kind === 'file').map((n) => n.content ?? '');
  }
  /** Every content still recoverable somewhere: live on either side, recycled, trashed, or an old revision. */
  recoverableContents(): Set<string> {
    return new Set([...this.localFiles().values(), ...this.remoteFiles().values(), ...this.recycled.map((r) => r.content ?? ''), ...this.trashedContents(), ...this.revisions]);
  }
}

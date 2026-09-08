/**
 * Journal repository: write-ahead record of every mutating operation.
 *
 * Transitions: planned -> in_progress -> completed | failed | abandoned.
 * planned -> abandoned is also allowed (plan discarded before execution).
 * Every other transition throws.
 */
import type { StateStore } from './store.ts';

export type JournalStatus = 'planned' | 'in_progress' | 'completed' | 'failed' | 'abandoned';

export interface JournalEntryInput {
  op: string;
  relPath: string | null;
  previousRelPath: string | null;
  nodeUid: string | null;
  /** What the operation is meant to achieve (serialisable). */
  intended: unknown;
  /** Fingerprints of both sides at planning time (serialisable). */
  preState: unknown;
}

export interface JournalEntry extends JournalEntryInput {
  id: number;
  createdAt: number;
  updatedAt: number;
  status: JournalStatus;
  outcome: unknown;
  error: string | null;
  attempt: number;
}

interface DbRow {
  id: number;
  created_at: number;
  updated_at: number;
  status: JournalStatus;
  op: string;
  rel_path: string | null;
  previous_rel_path: string | null;
  node_uid: string | null;
  intended: string;
  pre_state: string;
  outcome: string | null;
  error: string | null;
  attempt: number;
}

const ALLOWED: Record<JournalStatus, readonly JournalStatus[]> = {
  planned: ['in_progress', 'abandoned'],
  in_progress: ['completed', 'failed', 'abandoned'],
  completed: [],
  failed: [],
  abandoned: [],
};

export class IllegalJournalTransitionError extends Error {
  constructor(id: number, from: JournalStatus, to: JournalStatus) {
    super(`Journal entry ${String(id)}: illegal transition ${from} -> ${to}`);
    this.name = 'IllegalJournalTransitionError';
  }
}

function fromDb(r: DbRow): JournalEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    op: r.op,
    relPath: r.rel_path,
    previousRelPath: r.previous_rel_path,
    nodeUid: r.node_uid,
    intended: JSON.parse(r.intended) as unknown,
    preState: JSON.parse(r.pre_state) as unknown,
    outcome: r.outcome === null ? null : (JSON.parse(r.outcome) as unknown),
    error: r.error,
    attempt: r.attempt,
  };
}

export class JournalRepo {
  private readonly store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  plan(input: JournalEntryInput): JournalEntry {
    const now = this.store.now();
    const result = this.store.db
      .prepare(
        `INSERT INTO journal (created_at, updated_at, status, op, rel_path, previous_rel_path, node_uid, intended, pre_state)
         VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, ?)`,
      )
      .run(now, now, input.op, input.relPath, input.previousRelPath, input.nodeUid, JSON.stringify(input.intended), JSON.stringify(input.preState));
    return this.get(Number(result.lastInsertRowid));
  }

  get(id: number): JournalEntry {
    const row = this.store.db.prepare('SELECT * FROM journal WHERE id = ?').get(id) as DbRow | undefined;
    if (row === undefined) throw new Error(`Journal entry ${String(id)} not found`);
    return fromDb(row);
  }

  byStatus(status: JournalStatus): JournalEntry[] {
    return (this.store.db.prepare('SELECT * FROM journal WHERE status = ? ORDER BY id').all(status) as unknown as DbRow[]).map(fromDb);
  }

  /** Entries needing attention at startup: in progress, plus planned ones never started. */
  unresolved(): JournalEntry[] {
    return (this.store.db.prepare("SELECT * FROM journal WHERE status IN ('planned', 'in_progress') ORDER BY id").all() as unknown as DbRow[]).map(fromDb);
  }

  private transition(id: number, to: JournalStatus, patch: { outcome?: unknown; error?: string | null; bumpAttempt?: boolean }): JournalEntry {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (!ALLOWED[current.status].includes(to)) throw new IllegalJournalTransitionError(id, current.status, to);
      this.store.db
        .prepare('UPDATE journal SET status = ?, updated_at = ?, outcome = COALESCE(?, outcome), error = ?, attempt = attempt + ? WHERE id = ?')
        .run(to, this.store.now(), patch.outcome === undefined ? null : JSON.stringify(patch.outcome), patch.error ?? null, patch.bumpAttempt === true ? 1 : 0, id);
      return this.get(id);
    });
  }

  start(id: number): JournalEntry {
    return this.transition(id, 'in_progress', { bumpAttempt: true });
  }

  /** Record another attempt of an in-progress entry (retry without leaving in_progress). */
  recordRetry(id: number): JournalEntry {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (current.status !== 'in_progress') throw new IllegalJournalTransitionError(id, current.status, 'in_progress');
      this.store.db.prepare('UPDATE journal SET attempt = attempt + 1, updated_at = ? WHERE id = ?').run(this.store.now(), id);
      return this.get(id);
    });
  }

  complete(id: number, outcome: unknown): JournalEntry {
    return this.transition(id, 'completed', { outcome });
  }

  fail(id: number, error: string): JournalEntry {
    return this.transition(id, 'failed', { error });
  }

  abandon(id: number, reason: string): JournalEntry {
    return this.transition(id, 'abandoned', { error: reason });
  }

  /** Remove terminal entries older than the given timestamp; the audit log keeps the history. */
  prune(olderThan: number): number {
    const result = this.store.db.prepare("DELETE FROM journal WHERE status IN ('completed', 'failed', 'abandoned') AND updated_at < ?").run(olderThan);
    return Number(result.changes);
  }
}

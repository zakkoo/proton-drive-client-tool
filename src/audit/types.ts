/**
 * Audit log entry types.
 *
 * Every decision and action the engine takes is recorded as one JSON Lines
 * entry. Field names are stable so the log can be parsed by standard tools
 * and queried per file (see history.ts).
 */

export type AuditKind =
  /** A planned operation, with the evidence it was based on. */
  | 'plan'
  /** An executed operation and its outcome. */
  | 'execute'
  /** A safety brake, quarantine, preflight failure or refused action. */
  | 'safety'
  /** A conflict created, listed or resolved. */
  | 'conflict'
  /** A crash-recovery step over the journal. */
  | 'recovery'
  /** A user confirmation, rejection or resolution. */
  | 'user'
  /** Engine lifecycle and state transitions. */
  | 'engine'
  /** Authentication and session events (never with secrets). */
  | 'auth'
  /** Dry-run: what would have been done. */
  | 'would_do';

export type AuditOutcome = 'ok' | 'failed' | 'skipped' | 'abandoned' | 'would_do';

export interface AuditEntryInput {
  kind: AuditKind;
  /** Human-readable summary. */
  message: string;
  /** Operation kind, e.g. 'upload', 'download', 'move_local', 'trash_remote'. */
  op?: string;
  /** Local path relative to the sync root, after the operation. */
  path?: string;
  /** Local path relative to the sync root, before a move/rename. */
  previousPath?: string;
  /** Remote node identifier. */
  nodeUid?: string;
  /** Content digest before the operation (hex SHA1). */
  digestBefore?: string;
  /** Content digest after the operation (hex SHA1). */
  digestAfter?: string;
  outcome?: AuditOutcome;
  /** Error category and message; never raw secrets. */
  error?: string;
  /** Any further structured detail. Redacted before writing. */
  details?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  /** ISO-8601 timestamp, always the first field. */
  ts: string;
  /** Monotonic sequence within the process, for ordering entries with equal ts. */
  seq: number;
}

export const AUDIT_FIELDS = [
  'ts',
  'seq',
  'kind',
  'message',
  'op',
  'path',
  'previousPath',
  'nodeUid',
  'digestBefore',
  'digestAfter',
  'outcome',
  'error',
  'details',
] as const satisfies readonly (keyof AuditEntry)[];

/**
 * Reconciliation types. Everything here is plain data: the reconciler is a
 * pure function of these inputs and performs no I/O.
 */

export type ItemKind = 'file' | 'dir';

export interface LocalFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Hex SHA1 when known. */
  sha1?: string | undefined;
}

export interface RemoteFingerprint {
  uid: string;
  parentUid: string | undefined;
  name: string;
  revisionUid?: string | undefined;
  /** Hex SHA1 when the remote carries a claim. */
  sha1?: string | undefined;
}

export interface LocalItem extends LocalFingerprint {
  relPath: string;
  kind: ItemKind;
}

export interface RemoteItem extends RemoteFingerprint {
  kind: ItemKind | 'other';
  nameStatus: 'ok' | 'undecryptable' | 'invalid';
  isTrashed: boolean;
  isProtonDocument: boolean;
  size?: number | undefined;
  mtimeMs?: number | undefined;
}

export interface BaselineItem {
  relPath: string;
  kind: ItemKind;
  /** When both sides were last confirmed in sync (ms). Used by the staleness guard. */
  syncedAt?: number;
  local: Omit<LocalFingerprint, 'sha1'> & { sha1: string | null };
  remote: { uid: string; parentUid: string | null; name: string; revisionUid: string | null; sha1: string | null };
}

export interface LocalView {
  items: ReadonlyMap<string, LocalItem>;
  /** The view reflects the file system at least as of this time (ms). */
  asOf?: number;
  /** False when a directory could not be listed. Deletes are withheld. */
  complete: boolean;
  /** False when the sync root itself is unavailable. */
  available: boolean;
  /**
   * Baseline paths that are still present locally but absent from `items`
   * because they are now ignored or unsyncable (unreadable, a symlink, a
   * special file). Their absence must never be read as a deletion.
   */
  hidden?: ReadonlySet<string>;
}

export interface RemoteView {
  /** Every non-trashed node under the sync root (and the root itself), keyed by uid. */
  items: ReadonlyMap<string, RemoteItem>;
  /** The view reflects the server at least as of this time (ms). */
  asOf?: number;
  rootUid: string;
  complete: boolean;
  available: boolean;
}

export interface ReconcileInput {
  baseline: ReadonlyMap<string, BaselineItem>;
  local: LocalView;
  remote: RemoteView;
  /** Paths and uids the engine refuses to touch. */
  quarantinedPaths?: ReadonlySet<string>;
  quarantinedUids?: ReadonlySet<string>;
}

/** How one side changed relative to the baseline. */
export type SideState = 'unchanged' | 'modified' | 'moved' | 'movedAndModified' | 'deleted';

export type OperationKind =
  | 'create_remote_folder'
  | 'create_local_folder'
  | 'upload'
  | 'download'
  | 'move_local'
  | 'move_remote'
  | 'recycle_local'
  | 'trash_remote'
  | 'update_baseline'
  | 'remove_baseline';

interface OperationBase {
  id: string;
  kind: OperationKind;
  /** Why this operation was planned: which fields differed on which side. */
  evidence: string[];
}

export type Operation =
  | (OperationBase & { kind: 'create_remote_folder'; relPath: string })
  | (OperationBase & { kind: 'create_local_folder'; relPath: string; remoteUid: string })
  | (OperationBase & { kind: 'upload'; relPath: string; mode: 'new' | 'revision'; remoteUid: string | undefined; expectedLocal: LocalFingerprint; expectedRemote: RemoteFingerprint | undefined })
  | (OperationBase & { kind: 'download'; relPath: string; remoteUid: string; expectedRemote: RemoteFingerprint; expectedLocal: LocalFingerprint | undefined })
  | (OperationBase & { kind: 'move_local'; from: string; to: string; remoteUid: string; expectedLocal: LocalFingerprint })
  | (OperationBase & { kind: 'move_remote'; remoteUid: string; from: string; to: string; expectedRemote: RemoteFingerprint })
  | (OperationBase & { kind: 'recycle_local'; relPath: string; itemKind: ItemKind; expectedLocal: LocalFingerprint })
  | (OperationBase & { kind: 'trash_remote'; remoteUid: string; relPath: string; itemKind: ItemKind; expectedRemote: RemoteFingerprint })
  | (OperationBase & { kind: 'update_baseline'; relPath: string; itemKind: ItemKind; local: LocalFingerprint; remote: RemoteFingerprint })
  | (OperationBase & { kind: 'remove_baseline'; relPath: string });

/** Omit over each member of a union, not over the union as a whole. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OperationInput = DistributiveOmit<Operation, 'id'>;

export type ConflictKind =
  /** Both sides changed the content differently. */
  | 'content'
  /** One side deleted, the other edited or moved; the edit is kept. */
  | 'delete_vs_edit'
  /** Moved to different destinations on both sides. */
  | 'divergent_move'
  /** Created independently on both sides at the same path with different content. */
  | 'create_create';

export interface Conflict {
  kind: ConflictKind;
  relPath: string;
  /** Present when the remote side has an item involved. */
  remoteUid: string | undefined;
  /** Which side deleted, for delete_vs_edit. */
  deletedOn?: 'local' | 'remote';
  /** Destinations for divergent moves. */
  localPath?: string;
  remotePath?: string;
  evidence: string[];
}

export type BlockedReason =
  | 'case_collision'
  | 'kind_mismatch'
  | 'target_occupied'
  | 'move_cycle'
  | 'undecryptable'
  | 'invalid_name'
  | 'proton_document'
  | 'unsupported_type'
  | 'quarantined'
  | 'orphan'
  /** The side's view predates the item's last sync; its absence is not trusted. */
  | 'stale_view';

export interface Blocked {
  reason: BlockedReason;
  relPath: string | undefined;
  remoteUid: string | undefined;
  detail: string;
}

export interface Withheld {
  operation: Operation;
  reason: string;
}

export interface Plan {
  operations: Operation[];
  conflicts: Conflict[];
  blocked: Blocked[];
  /** Deletes the gate refused to plan, with the reason. */
  withheld: Withheld[];
  /** True when the plan must not run without user confirmation (empty remote vs non-empty baseline). */
  requiresConfirmation: string | null;
  firstSync: boolean;
  stats: { deletes: number; replaces: number; transfers: number };
}

/**
 * RemoteDrive: the only surface through which the engine touches Proton Drive.
 *
 * Deliberately narrow. There is no permanent delete and no empty-trash; those
 * SDK methods are never wired in (see sdkRemoteDrive.ts and forbidden.test.ts).
 */

export type RemoteNodeType = 'file' | 'folder' | 'other';

export interface RemoteNode {
  /** Stable identifier; survives rename and move. */
  uid: string;
  /** Undefined for the root of a share. */
  parentUid: string | undefined;
  /** Decrypted name, or a placeholder when nameStatus is not 'ok'. */
  name: string;
  nameStatus: 'ok' | 'undecryptable' | 'invalid';
  type: RemoteNodeType;
  /** Proton Docs/Sheets and similar server-side documents have no downloadable content. */
  isProtonDocument: boolean;
  isTrashed: boolean;
  treeEventScopeId: string;
  /** Server-side modification (rename, move, new revision). */
  serverModifiedAt: Date;
  /** Client-claimed modification time of the content (from encrypted attributes). */
  claimedModifiedAt: Date | undefined;
  /** Client-claimed clear-text size. */
  claimedSize: number | undefined;
  /** Active revision identifier for files. */
  revisionUid: string | undefined;
  /** Client-claimed hex SHA1 of the content. */
  claimedSha1: string | undefined;
  /** Whether the SDK verified the claimed digest's signature. */
  sha1Verified: boolean;
  /** True when any field could not be decrypted or verified. */
  degraded: boolean;
  errors: string[];
}

export interface RemoteUploadSource {
  size: number;
  /** Hex SHA1 of the content; verified by the server side after upload. */
  sha1: string;
  modifiedAt: Date;
  mediaType?: string;
  /** Opens a fresh stream over the content. May be called more than once. */
  open(): ReadableStream<Uint8Array>;
}

export interface RemoteUploadResult {
  nodeUid: string;
  revisionUid: string;
}

export interface TransferOptions {
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
}

export type RemoteEvent =
  | {
      type: 'node_created' | 'node_updated';
      nodeUid: string;
      parentUid: string | undefined;
      isTrashed: boolean;
      eventId: string;
      scopeId: string;
    }
  | { type: 'node_deleted'; nodeUid: string; parentUid: string | undefined; eventId: string; scopeId: string }
  /** The cursor is too old or the tree changed in bulk; a full listing is required. */
  | { type: 'refresh_required'; eventId: string; scopeId: string }
  /** No events; the cursor may be advanced to eventId. */
  | { type: 'fast_forward'; eventId: string; scopeId: string }
  | { type: 'scope_removed'; eventId: string; scopeId: string };

export type RemoteErrorKind =
  | 'not_found'
  | 'name_conflict'
  | 'validation'
  | 'auth'
  | 'rate_limited'
  | 'connection'
  | 'server'
  | 'integrity'
  | 'aborted'
  | 'unsupported'
  | 'unknown';

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly kind: RemoteErrorKind,
    /** Whether the same call may succeed if repeated (after a re-read for mutations). */
    readonly retryable: boolean,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RemoteError';
    this.details = options?.details;
  }
  readonly details: unknown;
}

export interface RemoteDrive {
  /** The user's "My files" root folder. */
  getMyFilesRoot(): Promise<RemoteNode>;
  /** Resolve a POSIX path such as `/my-files/Sync/docs`. Escape `/` in names as `\/`. Null when missing. */
  resolvePath(remotePath: string): Promise<RemoteNode | null>;
  /** Null when the node does not exist or is not accessible. */
  getNode(uid: string): Promise<RemoteNode | null>;
  /** Every direct child. Throws instead of returning a partial listing. */
  listChildren(parentUid: string, signal?: AbortSignal): Promise<RemoteNode[]>;
  /** Stream the active revision's decrypted content into `sink`. */
  downloadToStream(uid: string, sink: WritableStream<Uint8Array>, options?: TransferOptions): Promise<void>;
  uploadNewFile(parentUid: string, name: string, source: RemoteUploadSource, options?: TransferOptions): Promise<RemoteUploadResult>;
  uploadNewRevision(nodeUid: string, source: RemoteUploadSource, options?: TransferOptions): Promise<RemoteUploadResult>;
  createFolder(parentUid: string, name: string, modifiedAt?: Date): Promise<RemoteNode>;
  rename(uid: string, newName: string): Promise<RemoteNode>;
  move(uid: string, newParentUid: string): Promise<RemoteNode>;
  /** Move nodes to Trash. Never permanent. */
  trash(uids: string[]): Promise<void>;
  /** Events since `lastEventId` for a tree scope; without a cursor yields a fast_forward carrying the latest id. */
  iterateEvents(scopeId: string, lastEventId?: string, signal?: AbortSignal): AsyncIterable<RemoteEvent>;
}

/** Split a remote path into name segments, honouring `\/` escapes. */
export function splitRemotePath(remotePath: string): string[] {
  if (!remotePath.startsWith('/')) throw new RemoteError(`Remote path must be absolute: ${remotePath}`, 'validation', false);
  const segments: string[] = [];
  let current = '';
  for (let i = 1; i < remotePath.length; i++) {
    const ch = remotePath.charAt(i);
    if (ch === '\\' && remotePath.charAt(i + 1) === '/') {
      current += '/';
      i++;
    } else if (ch === '/') {
      if (current !== '') segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') segments.push(current);
  return segments;
}

/**
 * RemoteDrive over the official SDK.
 *
 * The SDK client is consumed through the narrow `SdkClient` type below so the
 * adapter can be unit-tested with a stub. `deleteNodes` and `emptyTrash` are
 * intentionally absent from that type: permanent deletion is unreachable.
 */
import {
  AbortError,
  ConnectionError,
  DecryptionError,
  DriveEventType,
  IntegrityError,
  NodeType,
  NodeWithSameNameExistsValidationError,
  ProtonDriveError,
  RateLimitedError,
  ServerError,
  ValidationError,
  type DriveEvent,
  type FileDownloader,
  type FileUploader,
  type MaybeMissingNode,
  type NodeEntity,
  type NodeResult,
  type UploadMetadata,
} from '@protontech/drive-sdk';

import type { Logger } from './proton/logger.js';
import {
  RemoteError,
  splitRemotePath,
  type RemoteDrive,
  type RemoteEvent,
  type RemoteNode,
  type RemoteUploadResult,
  type RemoteUploadSource,
  type TransferOptions,
} from './interface.js';

/** The subset of ProtonDriveClient this adapter uses. No delete, no empty-trash. */
export interface SdkClient {
  getMyFilesRootFolder(): Promise<NodeEntity>;
  getNode(nodeUid: string): Promise<NodeEntity>;
  iterateFolderChildren(parentNodeUid: string, filterOptions?: { type?: NodeType }, signal?: AbortSignal): AsyncGenerator<NodeEntity>;
  iterateNodes(nodeUids: string[], signal?: AbortSignal): AsyncGenerator<MaybeMissingNode>;
  getFileDownloader(nodeUid: string, signal?: AbortSignal): Promise<FileDownloader>;
  getFileUploader(parentFolderUid: string, name: string, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader>;
  getFileRevisionUploader(nodeUid: string, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader>;
  createFolder(parentNodeUid: string, name: string, modificationTime?: Date): Promise<NodeEntity>;
  renameNode(nodeUid: string, newName: string): Promise<NodeEntity>;
  moveNodes(nodeUids: string[], newParentNodeUid: string, signal?: AbortSignal): AsyncGenerator<NodeResult>;
  trashNodes(nodeUids: string[], signal?: AbortSignal): AsyncGenerator<NodeResult>;
  iterateEvents(treeEventScopeId: string, lastEventId?: string, signal?: AbortSignal): AsyncGenerator<DriveEvent>;
}

const PROTON_DOCUMENT_PREFIX = 'application/vnd.proton.';

export function toRemoteNode(node: NodeEntity): RemoteNode {
  let name: string;
  let nameStatus: RemoteNode['nameStatus'];
  if (node.name.ok) {
    name = node.name.value;
    nameStatus = 'ok';
  } else if (typeof node.name.error === 'object' && 'name' in node.name.error && typeof node.name.error.name === 'string' && 'error' in node.name.error) {
    name = node.name.error.name;
    nameStatus = 'invalid';
  } else {
    name = `‹undecryptable ${node.uid}›`;
    nameStatus = 'undecryptable';
  }
  const type: RemoteNode['type'] = node.type === NodeType.File ? 'file' : node.type === NodeType.Folder ? 'folder' : 'other';
  const revision = node.activeRevision;
  const errors = (node.errors ?? []).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  if (!node.name.ok && nameStatus === 'undecryptable') {
    const e = node.name.error;
    errors.push(e instanceof Error ? `name: ${e.message}` : 'name: undecryptable');
  }
  return {
    uid: node.uid,
    parentUid: node.parentUid,
    name,
    nameStatus,
    type,
    isProtonDocument: typeof node.mediaType === 'string' && node.mediaType.startsWith(PROTON_DOCUMENT_PREFIX),
    isTrashed: node.trashTime !== undefined,
    treeEventScopeId: node.treeEventScopeId,
    serverModifiedAt: node.modificationTime,
    claimedModifiedAt: type === 'folder' ? node.folder?.claimedModificationTime : revision?.claimedModificationTime,
    claimedSize: revision?.claimedSize,
    revisionUid: revision?.uid,
    claimedSha1: revision?.claimedDigests?.sha1?.toLowerCase(),
    sha1Verified: revision?.claimedDigests?.sha1Verified ?? false,
    degraded: errors.length > 0 || nameStatus !== 'ok',
    errors,
  };
}

export function toRemoteEvent(event: DriveEvent): RemoteEvent {
  const scopeId = event.treeEventScopeId;
  switch (event.type) {
    case DriveEventType.NodeCreated:
      return { type: 'node_created', nodeUid: event.nodeUid, parentUid: event.parentNodeUid, isTrashed: event.isTrashed, eventId: event.eventId, scopeId };
    case DriveEventType.NodeUpdated:
      return { type: 'node_updated', nodeUid: event.nodeUid, parentUid: event.parentNodeUid, isTrashed: event.isTrashed, eventId: event.eventId, scopeId };
    case DriveEventType.NodeDeleted:
      return { type: 'node_deleted', nodeUid: event.nodeUid, parentUid: event.parentNodeUid, eventId: event.eventId, scopeId };
    case DriveEventType.TreeRefresh:
      return { type: 'refresh_required', eventId: event.eventId, scopeId };
    case DriveEventType.FastForward:
      return { type: 'fast_forward', eventId: event.eventId, scopeId };
    case DriveEventType.TreeRemove:
      return { type: 'scope_removed', eventId: event.eventId, scopeId };
    case DriveEventType.SharedWithMeUpdated:
      return { type: 'fast_forward', eventId: event.eventId, scopeId };
  }
}

/** Map an SDK error to RemoteError. Anything unknown is treated as non-retryable. */
export function toRemoteError(error: unknown, context: string): RemoteError {
  if (error instanceof RemoteError) return error;
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  if (error instanceof NodeWithSameNameExistsValidationError) {
    return new RemoteError(`${context}: a node with the same name already exists`, 'name_conflict', false, {
      cause: error,
      details: { existingNodeUid: error.existingNodeUid, isUnfinishedUpload: error.isUnfinishedUpload },
    });
  }
  if (error instanceof ValidationError) return new RemoteError(`${context}: ${msg(error)}`, 'validation', false, { cause: error, details: error.details });
  if (error instanceof RateLimitedError) return new RemoteError(`${context}: rate limited`, 'rate_limited', true, { cause: error });
  if (error instanceof ServerError) {
    const status = error.statusCode;
    if (status === 401 || status === 403 || error.code === 401) return new RemoteError(`${context}: session rejected`, 'auth', false, { cause: error });
    if (status === 404 || error.code === 2501) return new RemoteError(`${context}: not found`, 'not_found', false, { cause: error });
    if (status === 422) return new RemoteError(`${context}: ${msg(error)}`, 'validation', false, { cause: error });
    if (status !== undefined && status >= 500) return new RemoteError(`${context}: server error ${status}`, 'server', true, { cause: error });
    return new RemoteError(`${context}: ${msg(error)}`, 'server', false, { cause: error, details: { status, code: error.code } });
  }
  if (error instanceof ConnectionError) return new RemoteError(`${context}: connection failed`, 'connection', true, { cause: error });
  if (error instanceof IntegrityError) return new RemoteError(`${context}: integrity check failed: ${msg(error)}`, 'integrity', false, { cause: error, details: error.debug });
  if (error instanceof DecryptionError) return new RemoteError(`${context}: decryption failed`, 'integrity', false, { cause: error });
  if (error instanceof AbortError || (error instanceof Error && error.name === 'AbortError')) return new RemoteError(`${context}: aborted`, 'aborted', false, { cause: error });
  if (error instanceof Error && error.name === 'TimeoutError') return new RemoteError(`${context}: timed out`, 'connection', true, { cause: error });
  if (error instanceof ProtonDriveError) return new RemoteError(`${context}: ${msg(error)}`, 'unknown', false, { cause: error });
  return new RemoteError(`${context}: ${msg(error)}`, 'unknown', false, { cause: error });
}

function ensureResult(result: NodeResult, context: string): void {
  if (!result.ok) throw toRemoteError(result.error, `${context} ${result.uid}`);
}

export class SdkRemoteDrive implements RemoteDrive {
  constructor(
    private readonly sdk: SdkClient,
    private readonly logger: Logger,
  ) {}

  private async guard<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRemoteError(error, context);
    }
  }

  getMyFilesRoot(): Promise<RemoteNode> {
    return this.guard('get root', async () => toRemoteNode(await this.sdk.getMyFilesRootFolder()));
  }

  async resolvePath(remotePath: string): Promise<RemoteNode | null> {
    const segments = splitRemotePath(remotePath);
    const [section, ...rest] = segments;
    if (section !== 'my-files') {
      throw new RemoteError(`Only paths under /my-files are supported (got ${remotePath})`, 'unsupported', false);
    }
    let current = await this.getMyFilesRoot();
    for (const segment of rest) {
      const children = await this.listChildren(current.uid);
      const matches = children.filter((c) => c.nameStatus === 'ok' && c.name === segment && !c.isTrashed);
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        throw new RemoteError(`Ambiguous remote path: ${matches.length} nodes named ${segment} under ${current.name}`, 'validation', false);
      }
      const next = matches[0];
      if (next === undefined) return null;
      current = next;
    }
    return current;
  }

  async getNode(uid: string): Promise<RemoteNode | null> {
    try {
      return toRemoteNode(await this.sdk.getNode(uid));
    } catch (error) {
      const mapped = toRemoteError(error, `get node ${uid}`);
      if (mapped.kind === 'not_found') return null;
      throw mapped;
    }
  }

  listChildren(parentUid: string, signal?: AbortSignal): Promise<RemoteNode[]> {
    return this.guard(`list children of ${parentUid}`, async () => {
      const out: RemoteNode[] = [];
      for await (const child of this.sdk.iterateFolderChildren(parentUid, undefined, signal)) {
        out.push(toRemoteNode(child));
      }
      return out;
    });
  }

  downloadToStream(uid: string, sink: WritableStream<Uint8Array>, options: TransferOptions = {}): Promise<void> {
    return this.guard(`download ${uid}`, async () => {
      const downloader = await this.sdk.getFileDownloader(uid, options.signal);
      const controller = downloader.downloadToStream(sink, options.onProgress);
      await controller.completion();
    });
  }

  private async upload(context: string, getUploader: () => Promise<FileUploader>, source: RemoteUploadSource, options: TransferOptions): Promise<RemoteUploadResult> {
    return this.guard(context, async () => {
      const uploader = await getUploader();
      const controller = await uploader.uploadFromStream(source.open(), [], options.onProgress);
      const { nodeUid, nodeRevisionUid } = await controller.completion();
      return { nodeUid, revisionUid: nodeRevisionUid };
    });
  }

  private metadata(source: RemoteUploadSource): UploadMetadata {
    return {
      mediaType: source.mediaType ?? 'application/octet-stream',
      expectedSize: source.size,
      expectedSha1: source.sha1,
      modificationTime: source.modifiedAt,
    };
  }

  uploadNewFile(parentUid: string, name: string, source: RemoteUploadSource, options: TransferOptions = {}): Promise<RemoteUploadResult> {
    return this.upload(`upload ${name} to ${parentUid}`, () => this.sdk.getFileUploader(parentUid, name, this.metadata(source), options.signal), source, options);
  }

  uploadNewRevision(nodeUid: string, source: RemoteUploadSource, options: TransferOptions = {}): Promise<RemoteUploadResult> {
    return this.upload(`upload revision of ${nodeUid}`, () => this.sdk.getFileRevisionUploader(nodeUid, this.metadata(source), options.signal), source, options);
  }

  createFolder(parentUid: string, name: string, modifiedAt?: Date): Promise<RemoteNode> {
    return this.guard(`create folder ${name} in ${parentUid}`, async () => toRemoteNode(await this.sdk.createFolder(parentUid, name, modifiedAt)));
  }

  rename(uid: string, newName: string): Promise<RemoteNode> {
    return this.guard(`rename ${uid}`, async () => toRemoteNode(await this.sdk.renameNode(uid, newName)));
  }

  move(uid: string, newParentUid: string): Promise<RemoteNode> {
    return this.guard(`move ${uid} to ${newParentUid}`, async () => {
      for await (const result of this.sdk.moveNodes([uid], newParentUid)) ensureResult(result, 'move');
      return toRemoteNode(await this.sdk.getNode(uid));
    });
  }

  trash(uids: string[]): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.guard(`trash ${uids.length} node(s)`, async () => {
      for await (const result of this.sdk.trashNodes(uids)) ensureResult(result, 'trash');
      this.logger.info(`Moved ${uids.length} node(s) to Trash`);
    });
  }

  async *iterateEvents(scopeId: string, lastEventId?: string, signal?: AbortSignal): AsyncIterable<RemoteEvent> {
    try {
      for await (const event of this.sdk.iterateEvents(scopeId, lastEventId, signal)) {
        yield toRemoteEvent(event);
      }
    } catch (error) {
      throw toRemoteError(error, `events for scope ${scopeId}`);
    }
  }
}

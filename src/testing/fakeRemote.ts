/**
 * In-memory RemoteDrive with the same semantics the engine relies on:
 * stable uids, revisions with digests, trash, name conflicts, an event log
 * per scope with expiring cursors, and fault injection hooks.
 */
import { createHash } from 'node:crypto';

import {
  RemoteError,
  splitRemotePath,
  type RemoteDrive,
  type RemoteEvent,
  type RemoteNode,
  type RemoteUploadResult,
  type RemoteUploadSource,
  type TransferOptions,
} from '../remote/interface.js';

interface FakeNodeRecord {
  uid: string;
  parentUid: string | undefined;
  name: string;
  type: 'file' | 'folder';
  trashed: boolean;
  serverModifiedAt: Date;
  claimedModifiedAt: Date | undefined;
  revisionUid: string | undefined;
  content: Buffer | undefined;
  /** Claimed digest; may be set to undefined to simulate uploads by clients that send none. */
  claimedSha1: string | undefined;
  nameStatus: RemoteNode['nameStatus'];
  isProtonDocument: boolean;
}

export type FakeFault =
  | { kind: 'throttle'; retryAfterMs?: number }
  | { kind: 'connection' }
  /** The mutation is applied on the server but the client sees a timeout. */
  | { kind: 'unknown_outcome' }
  /** Downloaded bytes are corrupted after hashing on the server side. */
  | { kind: 'corrupt_download' }
  /** Upload completes but the stored digest differs (server-side inconsistency). */
  | { kind: 'mismatch_upload' }
  | { kind: 'auth' }
  /** The download sink reports no space left on device. */
  | { kind: 'enospc' };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<RemoteEvent, 'eventId'>;

export type FakeOperation = 'list' | 'get' | 'download' | 'upload' | 'createFolder' | 'rename' | 'move' | 'trash' | 'events';

export class FakeRemote implements RemoteDrive {
  readonly scopeId = 'scope-1';
  private readonly nodes = new Map<string, FakeNodeRecord>();
  private readonly events: { eventId: number; event: EventBody }[] = [];
  private nextUid = 1;
  private nextEvent = 1;
  private oldestRetainedEvent = 0;
  private readonly faults = new Map<FakeOperation, FakeFault[]>();
  readonly calls: { op: FakeOperation; args: unknown[] }[] = [];
  /** Superseded revision contents per node (Proton keeps revision history). */
  private readonly superseded = new Map<string, Buffer[]>();
  readonly rootUid: string;
  clock: () => Date = () => new Date();
  /** Test hook invoked after the upload body was read and before the server commits it. */
  beforeUploadCommit: (() => Promise<void>) | undefined;
  /** Test hook invoked after all bytes were streamed and before the download completes. */
  beforeDownloadComplete: (() => Promise<void>) | undefined;

  constructor() {
    this.rootUid = this.newUid('root');
    this.nodes.set(this.rootUid, {
      uid: this.rootUid,
      parentUid: undefined,
      name: 'root',
      type: 'folder',
      trashed: false,
      serverModifiedAt: this.clock(),
      claimedModifiedAt: undefined,
      revisionUid: undefined,
      content: undefined,
      claimedSha1: undefined,
      nameStatus: 'ok',
      isProtonDocument: false,
    });
  }

  // ---- fault injection -------------------------------------------------

  injectFault(op: FakeOperation, fault: FakeFault): void {
    const list = this.faults.get(op) ?? [];
    list.push(fault);
    this.faults.set(op, list);
  }

  private takeFault(op: FakeOperation): FakeFault | undefined {
    const list = this.faults.get(op);
    if (list === undefined || list.length === 0) return undefined;
    return list.shift();
  }

  private throwFault(fault: FakeFault, context: string): never {
    switch (fault.kind) {
      case 'throttle':
        throw new RemoteError(`${context}: rate limited`, 'rate_limited', true, { details: { retryAfterMs: fault.retryAfterMs ?? 1000 } });
      case 'connection':
      case 'unknown_outcome':
        throw new RemoteError(`${context}: connection failed`, 'connection', true);
      case 'auth':
        throw new RemoteError(`${context}: session rejected`, 'auth', false);
      case 'enospc':
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      case 'corrupt_download':
      case 'mismatch_upload':
        throw new Error(`fault ${fault.kind} is not thrown directly`);
    }
  }

  /** Make every cursor older than the latest event invalid (simulates server-side event expiry). */
  expireOldCursors(): void {
    this.oldestRetainedEvent = this.nextEvent - 1;
  }

  // ---- test helpers ----------------------------------------------------

  /** Direct server-side mutations for tests (emit events like another client would). */
  seedFolder(parentUid: string, name: string): RemoteNode {
    return this.createFolderInternal(parentUid, name, undefined);
  }

  seedFile(parentUid: string, name: string, content: string | Buffer, opts: { modifiedAt?: Date; claimedSha1?: string | null } = {}): RemoteNode {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const sha1 = sha1Hex(buf);
    const uid = this.newUid('file');
    const rec: FakeNodeRecord = {
      uid,
      parentUid,
      name,
      type: 'file',
      trashed: false,
      serverModifiedAt: this.clock(),
      claimedModifiedAt: opts.modifiedAt ?? this.clock(),
      revisionUid: this.newUid('rev'),
      content: buf,
      claimedSha1: opts.claimedSha1 === null ? undefined : (opts.claimedSha1 ?? sha1),
      nameStatus: 'ok',
      isProtonDocument: false,
    };
    this.assertNoConflict(parentUid, name);
    this.nodes.set(uid, rec);
    this.emit({ type: 'node_created', nodeUid: uid, parentUid, isTrashed: false, scopeId: this.scopeId });
    return this.toNode(rec);
  }

  /** Replace a file's content server-side, as another client would. */
  seedRevision(uid: string, content: string | Buffer, modifiedAt?: Date): RemoteNode {
    const rec = this.mustGet(uid);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    this.rememberRevision(rec);
    rec.content = buf;
    rec.claimedSha1 = sha1Hex(buf);
    rec.revisionUid = this.newUid('rev');
    rec.claimedModifiedAt = modifiedAt ?? this.clock();
    rec.serverModifiedAt = this.clock();
    this.emit({ type: 'node_updated', nodeUid: uid, parentUid: rec.parentUid, isTrashed: false, scopeId: this.scopeId });
    return this.toNode(rec);
  }

  seedUndecryptable(parentUid: string): RemoteNode {
    const uid = this.newUid('file');
    const rec: FakeNodeRecord = {
      uid, parentUid, name: `‹undecryptable ${uid}›`, type: 'file', trashed: false, serverModifiedAt: this.clock(), claimedModifiedAt: undefined,
      revisionUid: this.newUid('rev'), content: Buffer.from('x'), claimedSha1: undefined, nameStatus: 'undecryptable', isProtonDocument: false,
    };
    this.nodes.set(uid, rec);
    this.emit({ type: 'node_created', nodeUid: uid, parentUid, isTrashed: false, scopeId: this.scopeId });
    return this.toNode(rec);
  }

  /** Permanently remove (as the user might via the web UI's trash). Test helper only; not part of RemoteDrive. */
  seedPermanentDelete(uid: string): void {
    const rec = this.mustGet(uid);
    for (const child of [...this.nodes.values()].filter((n) => n.parentUid === uid)) this.seedPermanentDelete(child.uid);
    this.nodes.delete(uid);
    this.emit({ type: 'node_deleted', nodeUid: uid, parentUid: rec.parentUid, scopeId: this.scopeId });
  }

  private rememberRevision(rec: FakeNodeRecord): void {
    if (rec.content === undefined) return;
    const list = this.superseded.get(rec.uid) ?? [];
    list.push(rec.content);
    this.superseded.set(rec.uid, list);
  }

  /** Contents of every superseded revision, recoverable through Proton's revision history. */
  supersededContents(): string[] {
    return [...this.superseded.values()].flat().map((b) => b.toString());
  }

  contentOf(uid: string): Buffer | undefined {
    return this.nodes.get(uid)?.content;
  }

  record(uid: string): Readonly<FakeNodeRecord> | undefined {
    return this.nodes.get(uid);
  }

  allNodes(): RemoteNode[] {
    return [...this.nodes.values()].map((r) => this.toNode(r));
  }

  trashedUids(): string[] {
    return [...this.nodes.values()].filter((n) => n.trashed).map((n) => n.uid);
  }

  pathOf(uid: string): string {
    const parts: string[] = [];
    let cur = this.nodes.get(uid);
    while (cur?.parentUid !== undefined) {
      parts.unshift(cur.name);
      cur = this.nodes.get(cur.parentUid);
    }
    return '/' + parts.join('/');
  }

  // ---- RemoteDrive -----------------------------------------------------

  getMyFilesRoot(): Promise<RemoteNode> {
    return Promise.resolve(this.toNode(this.mustGet(this.rootUid)));
  }

  async resolvePath(remotePath: string): Promise<RemoteNode | null> {
    const [section, ...rest] = splitRemotePath(remotePath);
    if (section !== 'my-files') throw new RemoteError(`Only /my-files is supported (got ${remotePath})`, 'unsupported', false);
    let current = this.mustGet(this.rootUid);
    for (const segment of rest) {
      const children = await this.listChildren(current.uid);
      const match = children.filter((c) => c.name === segment && !c.isTrashed && c.nameStatus === 'ok');
      if (match.length === 0) return null;
      if (match.length > 1) throw new RemoteError(`Ambiguous path ${remotePath}`, 'validation', false);
      current = this.mustGet(match[0]?.uid ?? '');
    }
    return this.toNode(current);
  }

  async getNode(uid: string): Promise<RemoteNode | null> {
    await Promise.resolve(); // behave like I/O: failures are rejections, never synchronous throws
    this.calls.push({ op: 'get', args: [uid] });
    const fault = this.takeFault('get');
    if (fault !== undefined) this.throwFault(fault, `get ${uid}`);
    const rec = this.nodes.get(uid);
    return rec === undefined ? null : this.toNode(rec);
  }

  async listChildren(parentUid: string): Promise<RemoteNode[]> {
    await Promise.resolve(); // behave like I/O: failures are rejections, never synchronous throws
    this.calls.push({ op: 'list', args: [parentUid] });
    const fault = this.takeFault('list');
    if (fault !== undefined) this.throwFault(fault, `list ${parentUid}`);
    if (!this.nodes.has(parentUid)) throw new RemoteError(`list ${parentUid}: not found`, 'not_found', false);
    return [...this.nodes.values()].filter((n) => n.parentUid === parentUid).map((n) => this.toNode(n));
  }

  async downloadToStream(uid: string, sink: WritableStream<Uint8Array>, options: TransferOptions = {}): Promise<void> {
    this.calls.push({ op: 'download', args: [uid] });
    const fault = this.takeFault('download');
    if (fault !== undefined && fault.kind !== 'corrupt_download') this.throwFault(fault, `download ${uid}`);
    const rec = this.nodes.get(uid);
    if (rec === undefined) throw new RemoteError(`download ${uid}: not found`, 'not_found', false);
    if (rec.type !== 'file' || rec.content === undefined) throw new RemoteError(`download ${uid}: not a file`, 'validation', false);
    let data = rec.content;
    if (fault?.kind === 'corrupt_download') {
      data = Buffer.from(data);
      data[0] = ((data[0] ?? 0) + 1) & 0xff;
    }
    const writer = sink.getWriter();
    try {
      const chunk = 64 * 1024;
      for (let off = 0; off < data.length; off += chunk) {
        options.signal?.throwIfAborted();
        await writer.write(new Uint8Array(data.subarray(off, Math.min(off + chunk, data.length))));
        options.onProgress?.(Math.min(off + chunk, data.length));
      }
      if (data.length === 0) options.onProgress?.(0);
      await this.beforeDownloadComplete?.();
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
  }

  private async readAll(source: RemoteUploadSource, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const reader = source.open().getReader();
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async uploadNewFile(parentUid: string, name: string, source: RemoteUploadSource, options: TransferOptions = {}): Promise<RemoteUploadResult> {
    this.calls.push({ op: 'upload', args: [parentUid, name] });
    const fault = this.takeFault('upload');
    if (fault?.kind === 'connection' || fault?.kind === 'throttle' || fault?.kind === 'auth') this.throwFault(fault, `upload ${name}`);
    if (!this.nodes.has(parentUid)) throw new RemoteError(`upload ${name}: parent not found`, 'not_found', false);
    this.assertNoConflict(parentUid, name);
    const data = await this.readAll(source, options.signal);
    this.checkUploadIntegrity(data, source, name);
    await this.beforeUploadCommit?.();
    const uid = this.newUid('file');
    const rec: FakeNodeRecord = {
      uid, parentUid, name, type: 'file', trashed: false, serverModifiedAt: this.clock(), claimedModifiedAt: source.modifiedAt,
      revisionUid: this.newUid('rev'), content: data, claimedSha1: fault?.kind === 'mismatch_upload' ? 'deadbeef'.repeat(5) : source.sha1,
      nameStatus: 'ok', isProtonDocument: false,
    };
    this.nodes.set(uid, rec);
    this.emit({ type: 'node_created', nodeUid: uid, parentUid, isTrashed: false, scopeId: this.scopeId });
    if (fault?.kind === 'unknown_outcome') this.throwFault(fault, `upload ${name}`);
    return { nodeUid: uid, revisionUid: rec.revisionUid ?? '' };
  }

  async uploadNewRevision(nodeUid: string, source: RemoteUploadSource, options: TransferOptions = {}): Promise<RemoteUploadResult> {
    this.calls.push({ op: 'upload', args: [nodeUid] });
    const fault = this.takeFault('upload');
    if (fault?.kind === 'connection' || fault?.kind === 'throttle' || fault?.kind === 'auth') this.throwFault(fault, `upload revision ${nodeUid}`);
    const rec = this.nodes.get(nodeUid);
    if (rec === undefined) throw new RemoteError(`upload revision ${nodeUid}: not found`, 'not_found', false);
    if (rec.type !== 'file') throw new RemoteError(`upload revision ${nodeUid}: not a file`, 'validation', false);
    const data = await this.readAll(source, options.signal);
    this.checkUploadIntegrity(data, source, rec.name);
    await this.beforeUploadCommit?.();
    this.rememberRevision(rec);
    rec.content = data;
    rec.revisionUid = this.newUid('rev');
    rec.claimedSha1 = fault?.kind === 'mismatch_upload' ? 'deadbeef'.repeat(5) : source.sha1;
    rec.claimedModifiedAt = source.modifiedAt;
    rec.serverModifiedAt = this.clock();
    this.emit({ type: 'node_updated', nodeUid, parentUid: rec.parentUid, isTrashed: false, scopeId: this.scopeId });
    if (fault?.kind === 'unknown_outcome') this.throwFault(fault, `upload revision ${nodeUid}`);
    return { nodeUid, revisionUid: rec.revisionUid };
  }

  private checkUploadIntegrity(data: Buffer, source: RemoteUploadSource, name: string): void {
    if (data.length !== source.size) throw new RemoteError(`upload ${name}: size ${data.length} does not match expected ${source.size}`, 'integrity', false);
    if (sha1Hex(data) !== source.sha1) throw new RemoteError(`upload ${name}: digest does not match expected sha1`, 'integrity', false);
  }

  async createFolder(parentUid: string, name: string, modifiedAt?: Date): Promise<RemoteNode> {
    await Promise.resolve(); // behave like I/O: failures are rejections, never synchronous throws
    this.calls.push({ op: 'createFolder', args: [parentUid, name] });
    const fault = this.takeFault('createFolder');
    if (fault !== undefined && fault.kind !== 'unknown_outcome') this.throwFault(fault, `create folder ${name}`);
    if (!this.nodes.has(parentUid)) throw new RemoteError(`create folder ${name}: parent not found`, 'not_found', false);
    const node = this.createFolderInternal(parentUid, name, modifiedAt);
    if (fault?.kind === 'unknown_outcome') this.throwFault(fault, `create folder ${name}`);
    return node;
  }

  private createFolderInternal(parentUid: string, name: string, modifiedAt: Date | undefined): RemoteNode {
    this.assertNoConflict(parentUid, name);
    const uid = this.newUid('folder');
    const rec: FakeNodeRecord = {
      uid, parentUid, name, type: 'folder', trashed: false, serverModifiedAt: this.clock(), claimedModifiedAt: modifiedAt,
      revisionUid: undefined, content: undefined, claimedSha1: undefined, nameStatus: 'ok', isProtonDocument: false,
    };
    this.nodes.set(uid, rec);
    this.emit({ type: 'node_created', nodeUid: uid, parentUid, isTrashed: false, scopeId: this.scopeId });
    return this.toNode(rec);
  }

  async rename(uid: string, newName: string): Promise<RemoteNode> {
    await Promise.resolve(); // behave like I/O: failures are rejections, never synchronous throws
    this.calls.push({ op: 'rename', args: [uid, newName] });
    const fault = this.takeFault('rename');
    if (fault !== undefined && fault.kind !== 'unknown_outcome') this.throwFault(fault, `rename ${uid}`);
    const rec = this.mustGet(uid);
    if (newName === '' || newName.includes('/')) throw new RemoteError(`rename ${uid}: invalid name`, 'validation', false);
    if (rec.parentUid !== undefined && rec.name !== newName) this.assertNoConflict(rec.parentUid, newName);
    rec.name = newName;
    rec.serverModifiedAt = this.clock();
    this.emit({ type: 'node_updated', nodeUid: uid, parentUid: rec.parentUid, isTrashed: rec.trashed, scopeId: this.scopeId });
    if (fault?.kind === 'unknown_outcome') this.throwFault(fault, `rename ${uid}`);
    return this.toNode(rec);
  }

  async move(uid: string, newParentUid: string): Promise<RemoteNode> {
    await Promise.resolve(); // behave like I/O: failures are rejections, never synchronous throws
    this.calls.push({ op: 'move', args: [uid, newParentUid] });
    const fault = this.takeFault('move');
    if (fault !== undefined && fault.kind !== 'unknown_outcome') this.throwFault(fault, `move ${uid}`);
    const rec = this.mustGet(uid);
    if (!this.nodes.has(newParentUid)) throw new RemoteError(`move ${uid}: target not found`, 'not_found', false);
    for (let p: string | undefined = newParentUid; p !== undefined; p = this.nodes.get(p)?.parentUid) {
      if (p === uid) throw new RemoteError(`move ${uid}: cannot move into own subtree`, 'validation', false);
    }
    if (rec.parentUid !== newParentUid) this.assertNoConflict(newParentUid, rec.name);
    rec.parentUid = newParentUid;
    rec.serverModifiedAt = this.clock();
    this.emit({ type: 'node_updated', nodeUid: uid, parentUid: newParentUid, isTrashed: rec.trashed, scopeId: this.scopeId });
    if (fault?.kind === 'unknown_outcome') this.throwFault(fault, `move ${uid}`);
    return this.toNode(rec);
  }

  async trash(uids: string[]): Promise<void> {
    await Promise.resolve(); // behave like I/O: failures are rejections, never synchronous throws
    this.calls.push({ op: 'trash', args: [uids] });
    const fault = this.takeFault('trash');
    if (fault !== undefined && fault.kind !== 'unknown_outcome') this.throwFault(fault, 'trash');
    for (const uid of uids) {
      const rec = this.mustGet(uid);
      if (uid === this.rootUid) throw new RemoteError('trash: cannot trash root', 'validation', false);
      rec.trashed = true;
      rec.serverModifiedAt = this.clock();
      this.emit({ type: 'node_updated', nodeUid: uid, parentUid: rec.parentUid, isTrashed: true, scopeId: this.scopeId });
    }
    if (fault?.kind === 'unknown_outcome') this.throwFault(fault, 'trash');
  }

  async *iterateEvents(scopeId: string, lastEventId?: string): AsyncIterable<RemoteEvent> {
    this.calls.push({ op: 'events', args: [scopeId, lastEventId] });
    const fault = this.takeFault('events');
    if (fault !== undefined) this.throwFault(fault, 'events');
    if (scopeId !== this.scopeId) throw new RemoteError(`unknown scope ${scopeId}`, 'not_found', false);
    const latest = String(this.nextEvent - 1);
    if (lastEventId === undefined) {
      yield { type: 'fast_forward', eventId: latest, scopeId };
      return;
    }
    const last = Number(lastEventId);
    if (!Number.isInteger(last) || last < this.oldestRetainedEvent) {
      yield { type: 'refresh_required', eventId: latest, scopeId };
      return;
    }
    const pending = this.events.filter((e) => e.eventId > last);
    if (pending.length === 0) {
      yield { type: 'fast_forward', eventId: latest, scopeId };
      return;
    }
    for (const e of pending) {
      yield { ...e.event, eventId: String(e.eventId) };
      await Promise.resolve();
    }
  }

  // ---- internals -------------------------------------------------------

  private emit(event: EventBody): void {
    this.events.push({ eventId: this.nextEvent++, event });
  }

  private newUid(kind: string): string {
    return `${kind}-${String(this.nextUid++).padStart(4, '0')}`;
  }

  private mustGet(uid: string): FakeNodeRecord {
    const rec = this.nodes.get(uid);
    if (rec === undefined) throw new RemoteError(`${uid}: not found`, 'not_found', false);
    return rec;
  }

  private assertNoConflict(parentUid: string, name: string): void {
    for (const n of this.nodes.values()) {
      if (n.parentUid === parentUid && !n.trashed && n.name === name) {
        throw new RemoteError(`a node named ${name} already exists`, 'name_conflict', false, { details: { existingNodeUid: n.uid } });
      }
    }
  }

  private toNode(rec: FakeNodeRecord): RemoteNode {
    return {
      uid: rec.uid,
      parentUid: rec.parentUid,
      name: rec.name,
      nameStatus: rec.nameStatus,
      type: rec.type,
      isProtonDocument: rec.isProtonDocument,
      isTrashed: rec.trashed,
      treeEventScopeId: this.scopeId,
      serverModifiedAt: rec.serverModifiedAt,
      claimedModifiedAt: rec.claimedModifiedAt,
      claimedSize: rec.content?.length,
      revisionUid: rec.revisionUid,
      claimedSha1: rec.claimedSha1,
      sha1Verified: rec.claimedSha1 !== undefined,
      degraded: rec.nameStatus !== 'ok',
      errors: rec.nameStatus === 'ok' ? [] : ['name: undecryptable'],
    };
  }
}

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * In-memory mirror of the remote tree under the sync root, kept current by
 * the event feed and refreshed by full listings (startup, expiry, interval).
 */
import type { NodeRemoteEvent } from '../remote/events.js';
import type { RemoteDrive, RemoteNode } from '../remote/interface.js';
import type { RemoteView } from '../reconcile/types.js';
import { listRemoteTree, remoteViewFromNodes } from './views.js';

export class RemoteMirror {
  private nodes = new Map<string, RemoteNode>();
  private complete = false;
  private available = true;
  lastFullListingAt: number | null = null;
  /** The mirror reflects the server at least as of this time (start of the last listing or completed poll). */
  private asOf: number | undefined;

  constructor(
    private readonly remote: RemoteDrive,
    private readonly rootUid: string,
    private readonly now: () => number = Date.now,
  ) {}

  get isComplete(): boolean {
    return this.complete;
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Replace the mirror with a complete listing. Throws (and marks unavailable) on failure. */
  async fullRefresh(signal?: AbortSignal): Promise<void> {
    const startedAt = this.now();
    try {
      const nodes = await listRemoteTree(this.remote, this.rootUid, signal);
      this.nodes = new Map(nodes.map((n) => [n.uid, n]));
      this.complete = true;
      this.available = true;
      this.lastFullListingAt = this.now();
      this.asOf = startedAt;
    } catch (error) {
      this.complete = false;
      this.available = false;
      throw error;
    }
  }

  /** Apply one node event by re-reading the node (events carry no metadata). */
  async applyEvent(event: NodeRemoteEvent): Promise<void> {
    if (event.type === 'node_deleted') {
      this.nodes.delete(event.nodeUid);
      return;
    }
    const node = await this.remote.getNode(event.nodeUid);
    if (node === null) this.nodes.delete(event.nodeUid);
    else this.nodes.set(node.uid, node);
    this.available = true;
  }

  /** Our own completed mutation: reflect it immediately instead of waiting for the event stream. */
  upsert(node: RemoteNode): void {
    this.nodes.set(node.uid, node);
  }

  remove(uid: string): void {
    this.nodes.delete(uid);
  }

  /** A poll of the event stream that started at `startedAt` completed successfully. */
  markPolled(startedAt: number): void {
    if (this.asOf === undefined || startedAt > this.asOf) this.asOf = startedAt;
  }

  markUnavailable(): void {
    this.available = false;
  }

  markAvailable(): void {
    this.available = true;
  }

  view(): RemoteView {
    return remoteViewFromNodes([...this.nodes.values()], this.rootUid, this.complete, this.available, this.asOf);
  }

  files(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.type === 'file' && !node.isTrashed) n++;
    return n;
  }
}

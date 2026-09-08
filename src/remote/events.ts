/**
 * Remote change feed: polls the event stream for one tree scope, hands node
 * events to a handler, persists the cursor only after the handler finished,
 * and falls back to a full refresh when the cursor is expired or the stream
 * has been silent for too long.
 */
import type { Logger } from './proton/logger.js';
import type { RemoteDrive, RemoteEvent } from './interface.js';

export interface EventCursorStore {
  get(scopeId: string): Promise<string | null>;
  set(scopeId: string, eventId: string): Promise<void>;
}

export type NodeRemoteEvent = Extract<RemoteEvent, { type: 'node_created' | 'node_updated' | 'node_deleted' }>;

export interface ChangeFeedOptions {
  remote: RemoteDrive;
  scopeId: string;
  cursors: EventCursorStore;
  logger: Logger;
  /** Called for each node event, in order. Must not throw; errors stop the poll before the cursor advances. */
  onEvent: (event: NodeRemoteEvent) => Promise<void>;
  /** Called when a full listing is required (expired cursor, bulk change, or silence). */
  onRefreshRequired: (reason: string) => Promise<void>;
  onStatus?: (status: FeedStatus) => void;
  /** Called after a successful poll with the time the poll started. */
  onPollComplete?: (startedAt: number) => void;
  pollIntervalMs?: number;
  /** Without a successful poll for this long the feed reports degraded and requests a refresh. */
  silenceThresholdMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type FeedStatus = 'live' | 'degraded' | 'stopped';

export interface PollResult {
  events: number;
  refreshRequired: boolean;
  cursor: string | null;
}

export class RemoteChangeFeed {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private lastSuccess: number | null = null;
  private status: FeedStatus = 'stopped';
  private degradedRefreshRequested = false;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly options: ChangeFeedOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    }));
  }

  get currentStatus(): FeedStatus {
    return this.status;
  }

  /** One poll. Processes events from the stored cursor and persists it after each handled event. */
  async poll(signal?: AbortSignal): Promise<PollResult> {
    const { remote, scopeId, cursors, logger } = this.options;
    const startedAt = this.now();
    let cursor = await cursors.get(scopeId);
    let events = 0;
    let refreshRequired = false;
    for await (const event of remote.iterateEvents(scopeId, cursor ?? undefined, signal)) {
      switch (event.type) {
        case 'node_created':
        case 'node_updated':
        case 'node_deleted':
          await this.options.onEvent(event);
          events++;
          break;
        case 'refresh_required':
          logger.warn(`Event stream for scope ${scopeId} requires a full refresh`);
          await this.options.onRefreshRequired(cursor === null ? 'no cursor' : 'cursor expired or bulk change');
          refreshRequired = true;
          break;
        case 'scope_removed':
          logger.warn(`Event scope ${scopeId} was removed`);
          await this.options.onRefreshRequired('scope removed');
          refreshRequired = true;
          break;
        case 'fast_forward':
          break;
      }
      // Persist only after the handler succeeded, so a crash replays the event instead of losing it.
      await cursors.set(scopeId, event.eventId);
      cursor = event.eventId;
    }
    this.lastSuccess = this.now();
    this.degradedRefreshRequested = false;
    this.setStatus('live');
    this.options.onPollComplete?.(startedAt);
    return { events, refreshRequired, cursor };
  }

  /** Whether the stream has been silent longer than the threshold. */
  isSilentTooLong(): boolean {
    const threshold = this.options.silenceThresholdMs ?? 15 * 60_000;
    return this.lastSuccess === null ? false : this.now() - this.lastSuccess > threshold;
  }

  /** Run the poll loop until stop(). Errors mark the feed degraded and, after the silence threshold, request a refresh. */
  start(): void {
    if (this.loop !== null) return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.lastSuccess ??= this.now();
    this.loop = (async () => {
      while (!this.isStopping()) {
        try {
          await this.poll(signal);
        } catch (error) {
          if (this.isStopping()) break;
          this.options.logger.warn(`Event poll failed: ${error instanceof Error ? error.message : String(error)}`);
          this.setStatus('degraded');
          if (this.isSilentTooLong() && !this.degradedRefreshRequested) {
            this.degradedRefreshRequested = true;
            try {
              await this.options.onRefreshRequired('event stream silent too long');
            } catch (refreshError) {
              this.options.logger.error('Refresh after silence failed', refreshError);
            }
          }
        }
        try {
          await this.sleep(this.options.pollIntervalMs ?? 30_000, signal);
        } catch {
          break;
        }
      }
      this.setStatus('stopped');
    })();
  }

  private isStopping(): boolean {
    return this.abort?.signal.aborted ?? true;
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = null;
    this.abort = null;
  }

  private setStatus(status: FeedStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }
}

/**
 * Local watcher: inotify events (via @parcel/watcher) plus periodic full
 * scans, producing debounced, settled, move-aware change batches against a
 * maintained in-memory snapshot.
 *
 * Guarantees relied upon by the engine:
 *  - a file is reported only once it has stopped changing (settle check)
 *  - a burst of writes yields one change
 *  - an inotify overflow or watcher error forces a full scan, never a guess
 *  - a vanished sync root yields one `root_unavailable` condition and no
 *    per-file deletes
 */
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import watcher from '@parcel/watcher';

import type { Logger } from '../remote/proton/logger.js';
import { diffSnapshots, type LocalChange } from './diff.js';
import type { DigestProvider } from './digest.js';
import type { IgnoreMatcher } from './ignore.js';
import { RootUnavailableError, scanLocalTree, statRoot, type LocalEntry, type LocalSnapshot } from './snapshot.js';

export type LocalWatcherEvent =
  | { type: 'changes'; changes: LocalChange[]; snapshot: LocalSnapshot; source: 'events' | 'scan' }
  | { type: 'root_unavailable'; error: Error }
  | { type: 'root_restored'; snapshot: LocalSnapshot }
  | { type: 'rescan'; reason: string };

export interface LocalWatcherOptions {
  root: string;
  ignore: IgnoreMatcher;
  digests: DigestProvider;
  previousDigest: (relPath: string) => string | undefined;
  logger: Logger;
  onEvent: (event: LocalWatcherEvent) => Promise<void> | void;
  debounceMs?: number;
  /** Delay between the two stat samples used to decide a file has settled. */
  settleMs?: number;
  fullScanIntervalMs?: number;
  /** Optional initial snapshot (e.g. rebuilt from the baseline) to diff the first scan against. */
  initialSnapshot?: LocalSnapshot;
  now?: () => number;
}

export class LocalWatcher {
  private snapshot: LocalSnapshot | null;
  private subscription: watcher.AsyncSubscription | null = null;
  private dirty = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private fullScanRequested = false;
  private processing: Promise<void> = Promise.resolve();
  private rootUnavailable = false;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;

  constructor(private readonly options: LocalWatcherOptions) {
    this.snapshot = options.initialSnapshot ?? null;
    this.debounceMs = options.debounceMs ?? 2000;
    this.settleMs = options.settleMs ?? Math.min(500, this.debounceMs);
    this.now = options.now ?? Date.now;
  }

  get currentSnapshot(): LocalSnapshot | null {
    return this.snapshot;
  }

  /** Initial full scan, then subscribe to events and start the periodic scan timer. */
  async start(): Promise<void> {
    await this.fullScan('startup');
    this.subscription = await watcher.subscribe(
      this.options.root,
      (error, events) => {
        if (error) {
          this.options.logger.warn(`Watcher error (${error.message}); forcing a full scan`);
          this.requestFullScan(`watcher error: ${error.message}`);
          return;
        }
        for (const e of events) {
          const rel = path.relative(this.options.root, e.path).split(path.sep).join('/');
          if (rel === '' || rel.startsWith('..')) {
            this.requestFullScan('event outside or at root');
            continue;
          }
          if (this.options.ignore(rel)) continue;
          this.dirty.add(rel);
        }
        this.armDebounce();
      },
    );
    const interval = this.options.fullScanIntervalMs ?? 60 * 60_000;
    this.scanTimer = setInterval(() => { this.requestFullScan('periodic'); }, interval);
    this.scanTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.scanTimer !== null) clearInterval(this.scanTimer);
    await this.subscription?.unsubscribe();
    this.subscription = null;
    await this.processing;
  }

  /** Ask for a full scan on the next processing turn (also used by the engine's safety checks). */
  requestFullScan(reason: string): void {
    this.fullScanRequested = true;
    this.enqueue(() => this.fullScan(reason));
  }

  /**
   * Refresh the given paths in the snapshot right away (no debounce, no settle
   * wait): used after the engine's own writes so the next cycle never sees a
   * snapshot older than the baseline it just updated.
   */
  async refreshNow(relPaths: readonly string[]): Promise<void> {
    for (const p of relPaths) this.dirty.add(p);
    this.enqueue(() => this.processDirty({ skipSettle: true }));
    await this.processing;
  }

  /** Wait until queued processing has drained (tests and shutdown). */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.enqueue(() => this.processDirty());
    }
    await this.processing;
  }

  private armDebounce(): void {
    if (this.stopped) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.enqueue(() => this.processDirty());
    }, this.debounceMs);
  }

  private enqueue(task: () => Promise<void>): void {
    this.processing = this.processing.then(task).catch((error: unknown) => {
      this.options.logger.error('Local watcher processing failed', error);
    });
  }

  private async emit(event: LocalWatcherEvent): Promise<void> {
    try {
      await this.options.onEvent(event);
    } catch (error) {
      this.options.logger.error('Local watcher listener failed', error);
    }
  }

  private async fullScan(reason: string): Promise<void> {
    if (this.stopped) return;
    this.fullScanRequested = false;
    this.dirty.clear();
    let next: LocalSnapshot;
    try {
      next = await scanLocalTree(this.options.root, { ignore: this.options.ignore, now: this.now });
    } catch (error) {
      if (error instanceof RootUnavailableError) {
        await this.markRootUnavailable(error);
        return;
      }
      throw error;
    }
    if (this.rootUnavailable) {
      this.rootUnavailable = false;
      await this.emit({ type: 'root_restored', snapshot: next });
    }
    if (this.snapshot !== null && !sameIdentity(this.snapshot.rootIdentity, next.rootIdentity)) {
      // The directory at the root path is not the same object any more.
      await this.markRootUnavailable(new RootUnavailableError(this.options.root, { cause: new Error('root identity changed') }));
      this.snapshot = next; // keep the newest view for when the engine decides how to proceed
      return;
    }
    const prev = this.snapshot;
    this.snapshot = next;
    if (reason !== 'startup' || prev !== null) {
      const changes = prev === null ? [] : await diffSnapshots(prev, next, this.options);
      if (reason !== 'startup' && reason !== 'periodic') await this.emit({ type: 'rescan', reason });
      if (changes.length > 0 || prev === null) await this.emit({ type: 'changes', changes, snapshot: next, source: 'scan' });
    } else {
      await this.emit({ type: 'changes', changes: [], snapshot: next, source: 'scan' });
    }
  }

  private async markRootUnavailable(error: RootUnavailableError): Promise<void> {
    this.dirty.clear();
    if (!this.rootUnavailable) {
      this.rootUnavailable = true;
      this.options.logger.error(error.message);
      await this.emit({ type: 'root_unavailable', error });
    }
  }

  /** Apply dirty paths to a copy of the snapshot, wait for them to settle, and emit the diff. */
  private async processDirty(options: { skipSettle?: boolean } = {}): Promise<void> {
    if (this.stopped || this.fullScanRequested) return;
    const prev = this.snapshot;
    if (prev === null) {
      await this.fullScan('no snapshot');
      return;
    }
    try {
      const id = await statRoot(this.options.root);
      if (!sameIdentity(id, prev.rootIdentity)) {
        await this.markRootUnavailable(new RootUnavailableError(this.options.root, { cause: new Error('root identity changed') }));
        return;
      }
    } catch (error) {
      if (error instanceof RootUnavailableError) {
        await this.markRootUnavailable(error);
        return;
      }
      throw error;
    }
    const dirty = [...this.dirty];
    this.dirty.clear();
    if (dirty.length === 0) return;

    const entries = new Map(prev.entries);
    const unsyncable = prev.unsyncable.filter((u) => !dirty.some((d) => d === u.relPath || u.relPath.startsWith(`${d}/`)));
    const unsettled: string[] = [];

    // Sort so parents are handled before children.
    for (const rel of dirty.sort()) {
      const abs = path.join(this.options.root, rel);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        // Gone: drop it and any descendants.
        for (const key of [...entries.keys()]) {
          if (key === rel || key.startsWith(`${rel}/`)) entries.delete(key);
        }
        continue;
      }
      if (st.isSymbolicLink()) {
        entries.delete(rel);
        unsyncable.push({ relPath: rel, reason: 'symlink' });
        continue;
      }
      if (st.isDirectory()) {
        // Rescan the subtree: new directories may contain files created before the watch existed.
        const sub = await scanLocalTree(abs, { ignore: (p) => this.options.ignore(`${rel}/${p}`), now: this.now });
        for (const key of [...entries.keys()]) {
          if (key.startsWith(`${rel}/`)) entries.delete(key);
        }
        entries.set(rel, { relPath: rel, kind: 'dir', dev: st.dev, ino: st.ino, size: 0, mtimeMs: st.mtimeMs });
        for (const e of sub.entries.values()) entries.set(`${rel}/${e.relPath}`, { ...e, relPath: `${rel}/${e.relPath}` });
        for (const u of sub.unsyncable) unsyncable.push({ ...u, relPath: `${rel}/${u.relPath}` });
        continue;
      }
      if (!st.isFile()) {
        entries.delete(rel);
        unsyncable.push({ relPath: rel, reason: 'special' });
        continue;
      }
      // Settle check: the file must look the same after a short pause and not be freshly modified.
      const settled = options.skipSettle === true ? { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } : await this.settle(abs, st);
      if (settled === null) {
        unsettled.push(rel);
        continue;
      }
      entries.set(rel, { relPath: rel, kind: 'file', dev: settled.dev, ino: settled.ino, size: settled.size, mtimeMs: settled.mtimeMs });
    }

    for (const rel of unsettled) this.dirty.add(rel);
    if (unsettled.length > 0) this.armDebounce();

    const next: LocalSnapshot = { ...prev, entries, unsyncable, complete: true, scannedAt: this.now() };
    const changes = await diffSnapshots(prev, next, this.options);
    this.snapshot = next;
    if (changes.length > 0) await this.emit({ type: 'changes', changes, snapshot: next, source: 'events' });
  }

  private async settle(abs: string, first: Stats): Promise<LocalEntry | null> {
    if (this.now() - first.mtimeMs < this.settleMs) return null;
    await new Promise((r) => setTimeout(r, this.settleMs));
    let second;
    try {
      second = await lstat(abs);
    } catch {
      return null;
    }
    if (second.size !== first.size || second.mtimeMs !== first.mtimeMs || second.ino !== first.ino) return null;
    return { relPath: '', kind: 'file', dev: second.dev, ino: second.ino, size: second.size, mtimeMs: second.mtimeMs };
  }
}

function sameIdentity(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

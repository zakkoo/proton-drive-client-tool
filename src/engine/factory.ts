/**
 * Wires configuration, store, safety components, watcher, feed and engine
 * together. Used by the CLI (with the Proton runtime) and by tests (with the
 * fake remote).
 */
import { DatabaseSync } from 'node:sqlite';

import type { AuditLog } from '../audit/logger.js';
import type { AppPaths } from '../config/paths.js';
import type { SyncConfig } from '../config/schema.js';
import { ConflictHandler } from '../conflict/handler.js';
import { DigestCache } from '../local/digest.js';
import { createIgnoreMatcher } from '../local/ignore.js';
import { LocalWatcher } from '../local/watcher.js';
import { RemoteChangeFeed } from '../remote/events.js';
import type { RemoteDrive } from '../remote/interface.js';
import { createLogger, type Logger, type LogLevel, type LogSink } from '../remote/proton/logger.js';
import type { SessionState } from '../remote/proton/sessionState.js';
import { PlanGate } from '../safety/brake.js';
import { runPreflight } from '../safety/preflight.js';
import { QuarantineService } from '../safety/quarantine.js';
import { RecycleBin } from '../safety/recycle.js';
import { BaselineRepo } from '../state/baseline.ts';
import { JournalRepo } from '../state/journal.ts';
import { ConflictRepo, CursorRepo, QuarantineRepo, ScanRepo } from '../state/misc.ts';
import { StateStore } from '../state/store.ts';
import type { ControlTarget } from './control.js';
import { SyncEngine } from './engine.js';
import { RemoteMirror } from './remoteMirror.js';

export interface EngineFactoryOptions {
  config: SyncConfig;
  paths: AppPaths;
  remote: RemoteDrive;
  audit: AuditLog;
  logSink?: LogSink;
  logLevel?: LogLevel;
  session?: SessionState;
  now?: () => number;
  /** Disable the remote event feed (tests without a scope). */
  disableFeed?: boolean;
  /** Override timers for tests. */
  timers?: { watcherDebounceMs?: number; watcherSettleMs?: number; feedPollMs?: number; triggerDebounceMs?: number };
}

export interface EngineBundle {
  engine: SyncEngine;
  store: StateStore;
  recycle: RecycleBin;
  controlTarget: ControlTarget;
  dispose(): Promise<void>;
}

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export async function createEngine(options: EngineFactoryOptions): Promise<EngineBundle> {
  const { config, paths, remote, audit } = options;
  if (config.remoteRootNodeUid === undefined || config.localRootIdentity === undefined) {
    throw new NotConfiguredError('The sync pair is not set up yet; run `proton-drive-sync setup <local-dir> <remote-folder>` first');
  }
  const remoteRootUid = config.remoteRootNodeUid;
  const rootIdentity = config.localRootIdentity;
  const log = (c: string): Logger => createLogger(c, options.logSink, options.logLevel);
  const now = options.now ?? Date.now;

  const store = StateStore.open(paths.stateDb, { now });
  const baseline = new BaselineRepo(store);
  const journal = new JournalRepo(store);
  const conflictRepo = new ConflictRepo(store);
  const cursors = new CursorRepo(store);
  const scans = new ScanRepo(store);
  const quarantine = new QuarantineService(new QuarantineRepo(store), audit);
  const recycle = new RecycleBin(config.localRoot, config.safety.recycleRetentionDays, audit, now);
  const digests = new DigestCache(config.localRoot);
  const gate = new PlanGate(config.safety, audit, now);
  const conflicts = new ConflictHandler({ root: config.localRoot, remote, store, baseline, journal, conflicts: conflictRepo, audit, now: () => new Date(now()) });
  const mirror = new RemoteMirror(remote, remoteRootUid, now);

  // Late-bound engine reference for the watcher and feed callbacks.
  let engine: SyncEngine | null = null;
  const watcher = new LocalWatcher({
    root: config.localRoot,
    ignore: createIgnoreMatcher(config.ignore),
    digests,
    previousDigest: (relPath) => baseline.byPath(relPath)?.localSha1 ?? undefined,
    logger: log('watcher'),
    onEvent: (e) => engine?.onLocalEvent(e),
    debounceMs: options.timers?.watcherDebounceMs ?? config.timing.debounceMs,
    ...(options.timers?.watcherSettleMs !== undefined ? { settleMs: options.timers.watcherSettleMs } : {}),
    fullScanIntervalMs: config.timing.localScanIntervalMinutes * 60_000,
  });

  let feed: RemoteChangeFeed | null = null;
  if (options.disableFeed !== true) {
    const rootNode = await remote.getNode(remoteRootUid);
    if (rootNode !== null) {
      feed = new RemoteChangeFeed({
        remote,
        scopeId: rootNode.treeEventScopeId,
        cursors,
        logger: log('events'),
        onEvent: (e) => engine?.onRemoteEvent(e) ?? Promise.resolve(),
        onRefreshRequired: (reason) => engine?.onRemoteRefreshRequired(reason) ?? Promise.resolve(),
        onStatus: (s) => engine?.onFeedStatus(s),
        onPollComplete: (t) => engine?.onFeedPollComplete(t),
        pollIntervalMs: options.timers?.feedPollMs ?? 30_000,
        silenceThresholdMs: config.timing.eventSilenceMinutes * 60_000,
        now,
      });
    }
  }

  const storeIntegrity = (): string => {
    try {
      const rows = store.db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      return rows.map((r) => r.quick_check).join('; ');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  engine = new SyncEngine({
    config,
    executorContext: { root: config.localRoot, remoteRootUid, remote, store, baseline, journal, quarantine, recycle, audit, logger: log('executor'), digests, now },
    baseline,
    conflictRepo,
    scans,
    quarantine,
    conflicts,
    gate,
    mirror,
    watcher,
    feed,
    digests,
    audit,
    logger: log('engine'),
    preflight: (plannedDownloadBytes) => runPreflight({ root: config.localRoot, expectedRootIdentity: rootIdentity, storeIntegrity, remote, expectedRemoteRootUid: remoteRootUid, plannedDownloadBytes }),
    ...(options.session !== undefined ? { session: options.session } : {}),
    now,
    ...(options.timers?.triggerDebounceMs !== undefined ? { triggerDebounceMs: options.timers.triggerDebounceMs } : {}),
  });
  const e = engine;

  const controlTarget: ControlTarget = {
    getStatus: () => e.getStatus(),
    pause: () => { e.pause(); },
    resume: () => { e.resume(); },
    syncNow: () => e.syncNow(),
    confirmHeldPlan: (id) => e.confirmHeldPlan(id),
    rejectHeldPlan: (id) => e.rejectHeldPlan(id),
    listConflicts: () => conflictRepo.open(),
    resolveConflict: (id, choice) => e.resolveConflict(id, choice),
    listQuarantine: () => quarantine.open(),
    releaseQuarantine: (id) => { e.releaseQuarantine(id); },
    listRecycle: () => recycle.list(),
    quit: async () => {
      await e.stop();
    },
    onStatus: (listener) => {
      e.on('status', listener);
      return () => e.off('status', listener);
    },
  };

  return {
    engine: e,
    store,
    recycle,
    controlTarget,
    dispose: async () => {
      await e.stop();
      store.close();
    },
  };
}

/** Quick integrity probe usable without an open StateStore (e.g. `status` command). */
export function quickCheck(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    return rows.map((r) => r.quick_check).join('; ');
  } finally {
    db.close();
  }
}

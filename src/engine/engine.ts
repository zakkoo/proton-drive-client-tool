/**
 * SyncEngine: the cycle scheduler and state machine.
 *
 * A cycle is: gather local snapshot and remote view -> compute digests for
 * candidates -> reconcile -> handle conflicts -> preflight -> brake -> execute.
 * Cycles are single-flight; triggers (local changes, remote events, timers,
 * "sync now") set a dirty flag and the loop re-runs once the current cycle
 * ends. Only user actions change pause state.
 */
import { EventEmitter } from 'node:events';

import type { AuditLog } from '../audit/logger.js';
import type { SyncConfig } from '../config/schema.js';
import type { ConflictHandler, Resolution } from '../conflict/handler.js';
import { Executor } from '../execute/executor.js';
import { recoverJournal } from '../execute/recovery.js';
import type { ExecutionSummary, ExecutorContext, ExecutorEvent } from '../execute/types.js';
import type { DigestProvider } from '../local/digest.js';
import { createIgnoreMatcher, type IgnoreMatcher } from '../local/ignore.js';
import type { LocalSnapshot } from '../local/snapshot.js';
import type { LocalWatcher, LocalWatcherEvent } from '../local/watcher.js';
import { reconcile } from '../reconcile/reconcile.js';
import type { BaselineItem, LocalView, Operation, Plan } from '../reconcile/types.js';
import type { RemoteChangeFeed } from '../remote/events.js';
import { RemoteError } from '../remote/interface.js';
import type { Logger } from '../remote/proton/logger.js';
import type { SessionState } from '../remote/proton/sessionState.js';
import type { PlanGate } from '../safety/brake.js';
import type { PreflightResult } from '../safety/preflight.js';
import type { QuarantineService } from '../safety/quarantine.js';
import type { BaselineRepo } from '../state/baseline.ts';
import type { ConflictRepo, ScanRepo } from '../state/misc.ts';
import type { RemoteMirror } from './remoteMirror.js';
import { canTransition, IllegalStateTransitionError, initialStatus, summarize, type EngineState, type EngineStatus, type TransferStatus } from './status.js';
import { baselineRowToItem, localViewFromSnapshot } from './views.js';

export interface EngineDeps {
  config: SyncConfig;
  executorContext: Omit<ExecutorContext, 'onEvent' | 'config'>;
  baseline: BaselineRepo;
  conflictRepo: ConflictRepo;
  scans: ScanRepo;
  quarantine: QuarantineService;
  conflicts: ConflictHandler;
  gate: PlanGate;
  mirror: RemoteMirror;
  watcher: LocalWatcher;
  feed: RemoteChangeFeed | null;
  digests: DigestProvider;
  audit: AuditLog;
  logger: Logger;
  preflight: (plannedDownloadBytes: number) => Promise<PreflightResult>;
  session?: SessionState;
  now?: () => number;
  /** Debounce for coalescing triggers into one cycle. */
  triggerDebounceMs?: number;
}

export interface CycleResult {
  plan: Plan;
  summary: ExecutionSummary | null;
  held: boolean;
  skipped: string | null;
}

export class SyncEngine extends EventEmitter {
  private status: EngineStatus;
  private readonly now: () => number;
  private cycleRunning: Promise<CycleResult | null> | null = null;
  private dirty = false;
  private triggerTimer: NodeJS.Timeout | null = null;
  private listingTimer: NodeJS.Timeout | null = null;
  private executor: Executor | null = null;
  private userPaused: boolean;
  private stopped = false;
  private lastSnapshot: LocalSnapshot | null = null;
  private localRootAvailable = true;
  private readonly transfers = new Map<string, TransferStatus>();
  private lastRemoteFailure: string | null = null;
  private readonly ignoreMatcher: IgnoreMatcher;

  constructor(private readonly deps: EngineDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.userPaused = deps.config.startPaused;
    this.status = initialStatus(deps.config.dryRun, this.now());
    this.ignoreMatcher = createIgnoreMatcher(deps.config.ignore);
  }

  /**
   * Tag baseline paths that vanished from the scan only because they are now
   * ignored or unsyncable, so the reconciler does not read their absence as a
   * deletion.
   */
  private withHiddenPaths(view: LocalView, snapshot: LocalSnapshot, baseline: ReadonlyMap<string, BaselineItem>): LocalView {
    const hidden = new Set<string>();
    for (const relPath of baseline.keys()) {
      if (view.items.has(relPath)) continue;
      if (this.ignoreMatcher(relPath) || snapshot.unsyncable.some((u) => u.relPath === relPath)) hidden.add(relPath);
    }
    return hidden.size > 0 ? { ...view, hidden } : view;
  }

  // ---- status ------------------------------------------------------------

  getStatus(): EngineStatus {
    // Recompute counts and attention live so a surface never shows a stale empty default while
    // the engine already has real values (e.g. counts right after a cycle, before the next publish).
    const live = { ...this.status, transfers: [...this.transfers.values()], attention: this.computeAttention(), counts: this.computeCounts() };
    return { ...live, summaryLines: summarize(live) };
  }

  private computeAttention(): EngineStatus['attention'] {
    const held = this.deps.gate.current;
    return {
      conflicts: this.deps.conflictRepo.open().length,
      quarantined: this.deps.quarantine.open().length,
      heldPlan: held === null ? null : { id: held.id, reason: held.verdict.reason ?? 'confirmation required', affected: held.verdict.affected.map(describeOp) },
    };
  }

  private computeCounts(): EngineStatus['counts'] {
    return {
      baseline: this.deps.baseline.count(),
      localFiles: this.lastSnapshot === null ? 0 : [...this.lastSnapshot.entries.values()].filter((e) => e.kind === 'file').length,
      remoteFiles: this.deps.mirror.files(),
    };
  }

  private setState(state: EngineState, reason: string | null = null): void {
    if (!canTransition(this.status.state, state)) throw new IllegalStateTransitionError(this.status.state, state);
    if (this.status.state !== state || this.status.reason !== reason) {
      this.deps.audit.append({ kind: 'engine', op: 'state', message: `${this.status.state} -> ${state}${reason !== null ? ` (${reason})` : ''}` });
    }
    this.status = { ...this.status, state, reason, since: this.now() };
    this.publish();
  }

  private publish(): void {
    this.refreshAttention();
    this.emit('status', this.getStatus());
  }

  private refreshAttention(): void {
    this.status = { ...this.status, attention: this.computeAttention(), counts: this.computeCounts() };
  }

  /** The resting state after a cycle: attention if anything needs the user, else idle. */
  private restingState(): EngineState {
    if (this.deps.gate.current !== null) return 'awaiting_confirmation';
    if (this.deps.conflictRepo.open().length > 0 || this.deps.quarantine.open().length > 0) return 'attention';
    return 'idle';
  }

  // ---- lifecycle ---------------------------------------------------------

  async start(): Promise<void> {
    if (this.deps.session !== undefined && this.deps.session.current !== 'logged_in') {
      this.setState('needs_login', 'no stored session');
      this.deps.session.onChange((s) => {
        if (s === 'logged_in' && this.status.state === 'needs_login') void this.start();
        if (s === 'needs_login' && this.status.state !== 'needs_login' && this.status.state !== 'stopped') this.setState('needs_login', 'session rejected');
      });
      return;
    }
    if (this.status.state !== 'starting' && this.status.state !== 'needs_login') return;
    this.setState('scanning', 'recovering journal');
    const report = await recoverJournal(this.ctx());
    this.deps.audit.append({ kind: 'recovery', message: `journal recovery: ${String(report.completed)} completed, ${String(report.failed)} failed, ${String(report.abandoned)} abandoned`, details: { ...report } });

    this.deps.watcher.requestFullScan('startup');
    await this.deps.watcher.start();
    // The watcher's own onEvent (wired by the factory) forwards to onLocalEvent.
    this.lastSnapshot = this.deps.watcher.currentSnapshot;

    try {
      await this.deps.mirror.fullRefresh();
    } catch (error) {
      this.remoteFailure(error);
    }
    this.deps.feed?.start();
    const listingMs = this.deps.config.timing.remoteListingIntervalMinutes * 60_000;
    this.listingTimer = setInterval(() => {
      void this.deps.mirror
        .fullRefresh()
        .then(() => { this.trigger('periodic remote listing'); })
        .catch((error: unknown) => {
          this.remoteFailure(error);
        });
    }, listingMs);
    this.listingTimer.unref();

    if (this.userPaused) {
      this.setState('paused', 'started paused');
      return;
    }
    await this.runCycle('startup');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.triggerTimer !== null) clearTimeout(this.triggerTimer);
    if (this.listingTimer !== null) clearInterval(this.listingTimer);
    this.executor?.pause();
    await this.deps.feed?.stop();
    await this.deps.watcher.stop();
    await this.cycleRunning;
    if (this.status.state !== 'stopped') this.setState('stopped');
  }

  private ctx(): ExecutorContext {
    return { ...this.deps.executorContext, config: { concurrency: this.deps.config.transfers.concurrency, maxRetries: this.deps.config.transfers.maxRetries, dryRun: this.deps.config.dryRun }, onEvent: (e) => { this.onExecutorEvent(e); } };
  }

  // ---- inputs from watcher and feed --------------------------------------

  async onLocalEvent(event: LocalWatcherEvent): Promise<void> {
    switch (event.type) {
      case 'changes':
        this.lastSnapshot = event.snapshot;
        this.localRootAvailable = true;
        if (event.changes.length > 0 || event.source === 'scan') this.trigger('local changes');
        break;
      case 'root_unavailable':
        this.localRootAvailable = false;
        this.deps.audit.append({ kind: 'safety', message: `local sync root unavailable: ${event.error.message}`, outcome: 'failed' });
        this.setStateSafely('error', 'sync root unavailable');
        break;
      case 'root_restored':
        this.lastSnapshot = event.snapshot;
        this.localRootAvailable = true;
        this.trigger('sync root restored');
        break;
      case 'rescan':
        this.deps.audit.append({ kind: 'engine', message: `local rescan: ${event.reason}` });
        break;
    }
    await Promise.resolve();
  }

  async onRemoteEvent(event: Parameters<RemoteMirror['applyEvent']>[0]): Promise<void> {
    await this.deps.mirror.applyEvent(event);
    this.trigger('remote event');
  }

  async onRemoteRefreshRequired(reason: string): Promise<void> {
    this.deps.audit.append({ kind: 'engine', message: `remote full listing: ${reason}` });
    try {
      await this.deps.mirror.fullRefresh();
      this.trigger(`remote refresh (${reason})`);
    } catch (error) {
      this.remoteFailure(error);
    }
  }

  onFeedPollComplete(startedAt: number): void {
    this.deps.mirror.markPolled(startedAt);
  }

  onFeedStatus(status: 'live' | 'degraded' | 'stopped'): void {
    this.status = { ...this.status, degraded: status === 'degraded' };
    this.publish();
  }

  onThrottle(state: 'throttled' | 'unthrottled'): void {
    if (state === 'throttled' && (this.status.state === 'syncing' || this.status.state === 'idle' || this.status.state === 'scanning')) this.setStateSafely('throttled', 'server asked us to slow down');
    if (state === 'unthrottled' && this.status.state === 'throttled') this.setStateSafely(this.cycleRunning !== null ? 'syncing' : this.restingState());
  }

  private remoteFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastRemoteFailure = message;
    if (error instanceof RemoteError && error.kind === 'auth') {
      void this.deps.session?.handleRemoteError(error);
      this.setStateSafely('needs_login', 'session rejected');
      return;
    }
    if (error instanceof RemoteError && (error.kind === 'connection' || error.kind === 'server' || error.kind === 'rate_limited')) {
      this.deps.mirror.markUnavailable();
      this.setStateSafely('offline', message);
      return;
    }
    this.deps.mirror.markUnavailable();
    this.setStateSafely('error', message);
  }

  private setStateSafely(state: EngineState, reason: string | null = null): void {
    if (this.status.state === 'stopped') return;
    if (canTransition(this.status.state, state)) this.setState(state, reason);
    else this.deps.logger.warn(`ignored state change ${this.status.state} -> ${state}`);
  }

  // ---- triggers and cycles -----------------------------------------------

  /** Coalesce triggers into one cycle after a short debounce. */
  trigger(reason: string): void {
    if (this.stopped || this.userPaused) return;
    this.dirty = true;
    if (this.triggerTimer !== null) clearTimeout(this.triggerTimer);
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      void this.runCycle(reason);
    }, this.deps.triggerDebounceMs ?? 500);
    this.triggerTimer.unref();
  }

  /** Run one cycle now (or join the running one). Loops while triggers arrived during the run. */
  runCycle(reason: string): Promise<CycleResult | null> {
    if (this.cycleRunning !== null) {
      this.dirty = true;
      return this.cycleRunning;
    }
    this.cycleRunning = (async () => {
      let result: CycleResult | null = null;
      do {
        this.dirty = false;
        try {
          result = await this.cycleOnce(reason);
        } catch (error) {
          this.deps.logger.error('cycle failed', error);
          this.deps.audit.append({ kind: 'engine', message: `cycle failed: ${error instanceof Error ? error.message : String(error)}`, outcome: 'failed' });
          this.remoteFailure(error);
          result = null;
        }
      } while (this.shouldRerun());
      return result;
    })().finally(() => {
      this.cycleRunning = null;
    });
    return this.cycleRunning;
  }

  /** Read through a method: the flag is mutated by triggers while a cycle awaits. */
  private shouldRerun(): boolean {
    return this.dirty && !this.stopped && !this.userPaused;
  }

  private async cycleOnce(reason: string): Promise<CycleResult> {
    if (this.userPaused) return { plan: emptyPlan(), summary: null, held: false, skipped: 'paused' };
    if (this.deps.session !== undefined && this.deps.session.current !== 'logged_in') return { plan: emptyPlan(), summary: null, held: false, skipped: 'needs login' };
    this.status = { ...this.status, progress: null };
    this.setStateSafely('scanning', reason);
    this.status = { ...this.status, lastCycleAt: this.now() };

    // Inputs.
    const snapshot = this.deps.watcher.currentSnapshot ?? this.lastSnapshot;
    if (snapshot === null) return { plan: emptyPlan(), summary: null, held: false, skipped: 'no local snapshot yet' };
    this.lastSnapshot = snapshot;
    if (!this.deps.mirror.isComplete) {
      try {
        await this.deps.mirror.fullRefresh();
      } catch (error) {
        this.remoteFailure(error);
        return { plan: emptyPlan(), summary: null, held: false, skipped: `remote unavailable: ${this.lastRemoteFailure ?? ''}` };
      }
    }
    const baselineRows = this.deps.baseline.all();
    const baseline = new Map<string, BaselineItem>();
    for (const row of baselineRows) baseline.set(row.relPath, baselineRowToItem(row));
    const needDigest = (relPath: string): boolean => {
      const row = this.deps.baseline.byPath(relPath);
      const entry = snapshot.entries.get(relPath);
      if (row === null || entry === undefined) return true;
      return row.localIno !== entry.ino || row.localSize !== entry.size || row.localMtimeMs !== entry.mtimeMs || row.localSha1 === null;
    };
    const local = this.withHiddenPaths(await localViewFromSnapshot(snapshot, this.deps.digests, needDigest, this.localRootAvailable), snapshot, baseline);
    const remote = this.deps.mirror.view();
    const sets = this.deps.quarantine.sets();
    const plan = reconcile({ baseline, local, remote, quarantinedPaths: sets.paths, quarantinedUids: sets.uids });
    this.deps.scans.markCompleted('local', snapshot.scannedAt);
    this.status = {
      ...this.status,
      pending: {
        uploads: plan.operations.filter((o) => o.kind === 'upload').length,
        downloads: plan.operations.filter((o) => o.kind === 'download').length,
        other: plan.operations.filter((o) => o.kind !== 'upload' && o.kind !== 'download').length,
      },
    };
    for (const b of plan.blocked) this.deps.audit.append({ kind: 'safety', op: 'blocked', message: `${b.reason}: ${b.detail}`, ...(b.relPath !== undefined ? { path: b.relPath } : {}), ...(b.remoteUid !== undefined ? { nodeUid: b.remoteUid } : {}), outcome: 'skipped' });

    // Conflicts first (they only rename locally and detach baseline rows).
    if (plan.conflicts.length > 0) {
      await this.deps.conflicts.handleNew(plan.conflicts);
      // Re-plan so the renamed copies are included in this cycle.
      const snapshot2 = await this.rescanLocal();
      const base2 = new Map<string, BaselineItem>();
      for (const row of this.deps.baseline.all()) base2.set(row.relPath, baselineRowToItem(row));
      const local2 = this.withHiddenPaths(await localViewFromSnapshot(snapshot2, this.deps.digests, needDigest, this.localRootAvailable), snapshot2, base2);
      const replanned = reconcile({ baseline: base2, local: local2, remote: this.deps.mirror.view(), quarantinedPaths: sets.paths, quarantinedUids: sets.uids });
      return this.gateAndExecute(replanned);
    }
    return this.gateAndExecute(plan);
  }

  private async rescanLocal(): Promise<LocalSnapshot> {
    this.deps.watcher.requestFullScan('after conflict handling');
    await this.deps.watcher.flush();
    const snap = this.deps.watcher.currentSnapshot;
    if (snap === null) throw new Error('local snapshot unavailable after rescan');
    this.lastSnapshot = snap;
    return snap;
  }

  private async gateAndExecute(plan: Plan): Promise<CycleResult> {
    if (plan.operations.length === 0 && plan.withheld.length === 0) {
      this.finishCycle(true);
      return { plan, summary: null, held: false, skipped: null };
    }
    const remoteItems = this.deps.mirror.view().items;
    const plannedDownloadBytes = plan.operations.reduce((n, o) => (o.kind === 'download' ? n + (remoteItems.get(o.remoteUid)?.size ?? 0) : n), 0);
    const preflight = await this.deps.preflight(plannedDownloadBytes);
    if (!preflight.ok) {
      this.deps.audit.append({ kind: 'safety', op: 'preflight', message: `preflight failed: ${preflight.reason}: ${preflight.detail}`, outcome: 'failed' });
      this.setStateSafely('error', `${preflight.reason}: ${preflight.detail}`);
      return { plan, summary: null, held: false, skipped: `preflight: ${preflight.reason}` };
    }
    const gate = this.deps.gate.evaluate(plan, this.deps.baseline.count());
    if (gate.status === 'held') {
      // Unaffected operations still run.
      const affected = new Set(gate.held.verdict.affected.map((o) => o.id));
      const safe = plan.operations.filter((o) => !affected.has(o.id));
      let summary: ExecutionSummary | null = null;
      if (safe.length > 0) summary = await this.executePlan({ ...plan, operations: safe });
      this.setStateSafely('awaiting_confirmation', gate.held.verdict.reason);
      this.publish();
      return { plan, summary, held: true, skipped: null };
    }
    const summary = await this.executePlan(gate.plan);
    this.finishCycle(summary.failed === 0 && summary.stoppedEarly === null);
    return { plan, summary, held: false, skipped: null };
  }

  private async executePlan(plan: Plan): Promise<ExecutionSummary> {
    const fileTotal = plan.operations.filter((o) => o.kind === 'upload' || o.kind === 'download').length;
    this.status = { ...this.status, progress: fileTotal > 0 ? { done: 0, total: fileTotal } : null };
    this.setStateSafely('syncing');
    this.executor = new Executor(this.ctx());
    if (this.userPaused) this.executor.pause();
    try {
      const summary = await this.executor.execute(plan);
      if (summary.stoppedEarly === 'disk_full') this.setStateSafely('error', 'disk full');
      if (summary.stoppedEarly === 'auth') {
        // A transfer that the server rejected clears the session, exactly as a rejected listing does,
        // so a later login in the same process transitions back out of needs-login and resumes.
        void this.deps.session?.handleRemoteError(summary.stoppedError);
        this.setStateSafely('needs_login', 'session rejected');
      }
      // Our own local writes: refresh the snapshot now so the next cycle never sees a stale view.
      const touched = new Set<string>();
      for (const o of plan.operations) {
        if (o.kind === 'move_local' || o.kind === 'move_remote') {
          touched.add(o.from);
          touched.add(o.to);
        } else touched.add(o.relPath);
      }
      await this.deps.watcher.refreshNow([...touched]);
      this.lastSnapshot = this.deps.watcher.currentSnapshot ?? this.lastSnapshot;
      return summary;
    } finally {
      this.executor = null;
      this.transfers.clear();
    }
  }

  private finishCycle(success: boolean): void {
    if (success) {
      this.status = { ...this.status, lastSuccessfulSyncAt: this.now() };
      const backups = this.deps.executorContext.store.discardPendingBackups();
      if (backups.length > 0) this.deps.audit.append({ kind: 'engine', message: `discarded ${String(backups.length)} migration backup(s) after a successful cycle` });
    }
    if (this.status.state === 'error' || this.status.state === 'needs_login' || this.status.state === 'paused' || this.status.state === 'stopped') {
      this.publish();
      return;
    }
    this.status = { ...this.status, progress: null };
    this.setStateSafely(this.restingState());
  }

  private onExecutorEvent(e: ExecutorEvent): void {
    switch (e.type) {
      case 'operation_started':
        if (e.operation.kind === 'upload' || e.operation.kind === 'download') {
          this.transfers.set(e.operation.id, { id: e.operation.id, kind: e.operation.kind, relPath: e.operation.relPath, bytes: 0, total: undefined, startedAt: this.now(), speed: 0 });
        }
        break;
      case 'transfer_progress': {
        const t = this.transfers.get(e.operation.id);
        if (t !== undefined) {
          const elapsed = Math.max(1, this.now() - t.startedAt) / 1000;
          this.transfers.set(t.id, { ...t, bytes: e.bytes, total: e.total, speed: e.bytes / elapsed });
        }
        break;
      }
      case 'operation_completed':
      case 'operation_failed':
      case 'operation_skipped':
        if (e.type === 'operation_completed' && (e.operation.kind === 'upload' || e.operation.kind === 'download')) {
          const progress = this.status.progress;
          if (progress !== null) this.status = { ...this.status, progress: { done: progress.done + 1, total: progress.total } };
        }
        if (e.type !== 'operation_failed' || !e.retryable) this.transfers.delete(e.operation.id);
        break;
      case 'paused_for':
      case 'quarantined':
        break;
    }
    this.emit('status', this.getStatus());
    if (e.type === 'quarantined') this.emit('notify', { kind: 'quarantined', message: `Quarantined ${e.relPath ?? e.nodeUid ?? 'item'}: ${e.reason}` });
  }

  // ---- user controls -----------------------------------------------------

  pause(): void {
    this.userPaused = true;
    this.executor?.pause();
    this.deps.audit.append({ kind: 'user', op: 'pause', message: 'user paused syncing' });
    if (this.cycleRunning === null) this.setStateSafely('paused', 'paused by user');
    else this.setStateSafely('paused', 'pausing after the current operation');
  }

  resume(): void {
    if (!this.userPaused) return;
    this.userPaused = false;
    this.deps.audit.append({ kind: 'user', op: 'resume', message: 'user resumed syncing' });
    if (this.status.state === 'paused') this.setStateSafely('idle');
    void this.runCycle('resumed');
  }

  syncNow(): Promise<CycleResult | null> {
    this.deps.audit.append({ kind: 'user', op: 'sync_now', message: 'user requested a sync' });
    if (this.userPaused) return Promise.resolve(null);
    return this.runCycle('sync now');
  }

  async confirmHeldPlan(id: string): Promise<CycleResult | null> {
    const plan = this.deps.gate.confirm(id);
    const summary = await this.executePlan(plan);
    this.finishCycle(summary.failed === 0);
    return { plan, summary, held: false, skipped: null };
  }

  rejectHeldPlan(id: string): Operation[] {
    const affected = this.deps.gate.reject(id);
    this.setStateSafely(this.restingState());
    return affected;
  }

  async resolveConflict(id: number, choice: Resolution): Promise<void> {
    const ops = await this.deps.conflicts.resolve(id, choice);
    if (ops.length > 0) await this.executePlan({ ...emptyPlan(), operations: ops });
    this.trigger('conflict resolved');
    this.publish();
  }

  releaseQuarantine(id: number): void {
    this.deps.quarantine.release(id);
    this.trigger('quarantine released');
    this.publish();
  }
}

function emptyPlan(): Plan {
  return { operations: [], conflicts: [], blocked: [], withheld: [], requiresConfirmation: null, firstSync: false, stats: { deletes: 0, replaces: 0, transfers: 0 } };
}

function describeOp(o: Operation): string {
  return o.kind === 'move_local' || o.kind === 'move_remote' ? `${o.kind} ${o.from} -> ${o.to}` : `${o.kind} ${o.relPath}`;
}

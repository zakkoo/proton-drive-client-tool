import type { AuditLog } from '../audit/logger.js';
import type { DigestProvider } from '../local/digest.js';
import type { Operation, Plan } from '../reconcile/types.js';
import type { RemoteDrive, RemoteNode } from '../remote/interface.js';
import type { Logger } from '../remote/proton/logger.js';
import type { RecycleBin } from '../safety/recycle.js';
import type { QuarantineService } from '../safety/quarantine.js';
import type { BaselineRepo } from '../state/baseline.ts';
import type { JournalRepo } from '../state/journal.ts';
import type { StateStore } from '../state/store.ts';

/** Thrown by test hooks to simulate a process crash; the executor never catches it. */
export class SimulatedCrashError extends Error {
  constructor(step: string) {
    super(`simulated crash at ${step}`);
    this.name = 'SimulatedCrashError';
  }
}

/**
 * Named steps the executor passes through for every operation. The
 * fault-injection harness can crash at any of them.
 */
export type ExecutorStep =
  | 'journal_planned'
  | 'precheck'
  | 'journal_started'
  | 'act'
  | 'verify'
  | 'commit'
  | 'journal_completed'
  | 'journal_failed';

export interface ExecutorHooks {
  /** Called before each step; throwing simulates a crash at that point. */
  beforeStep?: (step: ExecutorStep, operation: Operation, attempt: number) => void | Promise<void>;
}

export type ExecutorEvent =
  | { type: 'operation_started'; operation: Operation; attempt: number }
  | { type: 'operation_completed'; operation: Operation }
  | { type: 'operation_skipped'; operation: Operation; reason: string }
  | { type: 'operation_failed'; operation: Operation; error: string; retryable: boolean }
  | { type: 'transfer_progress'; operation: Operation; bytes: number; total: number | undefined }
  | { type: 'paused_for'; reason: 'disk_full' | 'auth' }
  | { type: 'quarantined'; relPath: string | null; nodeUid: string | null; reason: string };

export interface ExecutorConfig {
  concurrency: number;
  maxRetries: number;
  dryRun: boolean;
}

export type RemoteChange = { type: 'upsert'; node: RemoteNode } | { type: 'remove'; uid: string };

export interface ExecutorContext {
  root: string;
  remoteRootUid: string;
  remote: RemoteDrive;
  store: StateStore;
  baseline: BaselineRepo;
  journal: JournalRepo;
  quarantine: QuarantineService;
  recycle: RecycleBin;
  audit: AuditLog;
  logger: Logger;
  digests: DigestProvider;
  config: ExecutorConfig;
  onEvent?: (event: ExecutorEvent) => void;
  /** Our own completed remote mutations, so the caller's remote view never lags behind our work. */
  onRemoteChange?: (change: RemoteChange) => void;
  hooks?: ExecutorHooks;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ExecutionSummary {
  completed: number;
  skipped: number;
  failed: number;
  /** Set when execution stopped early (pause, cancel, or a pause-worthy condition). */
  stoppedEarly: 'paused' | 'cancelled' | 'disk_full' | 'auth' | null;
  /** The error that caused an 'auth' stop, so the engine can clear the session. */
  stoppedError?: unknown;
}

export type PlanForExecution = Pick<Plan, 'operations'>;

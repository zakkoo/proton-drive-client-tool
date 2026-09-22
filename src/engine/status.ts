/**
 * Engine state machine and status object shared by the tray, the CLI and the
 * control socket.
 */

export type EngineState =
  | 'starting'
  | 'idle'
  | 'scanning'
  | 'syncing'
  | 'paused'
  | 'offline'
  | 'throttled'
  | 'attention'
  | 'awaiting_confirmation'
  | 'error'
  | 'needs_login'
  | 'stopped';

export interface TransferStatus {
  id: string;
  kind: 'upload' | 'download';
  relPath: string;
  bytes: number;
  total: number | undefined;
  startedAt: number;
  /** Bytes per second over the transfer so far. */
  speed: number;
}

export interface AttentionSummary {
  conflicts: number;
  quarantined: number;
  heldPlan: { id: string; reason: string; affected: string[] } | null;
}

/** Files finished and files to transfer in the current run. Null when no file run is active. */
export interface RunProgress {
  done: number;
  total: number;
}

export interface EngineStatus {
  state: EngineState;
  reason: string | null;
  since: number;
  dryRun: boolean;
  /** The remote event stream is silent or failing; full listings are used instead. */
  degraded: boolean;
  lastSuccessfulSyncAt: number | null;
  lastCycleAt: number | null;
  pending: { uploads: number; downloads: number; other: number };
  /** Upload and download progress for the current run. Not local files over remote files. */
  progress: RunProgress | null;
  transfers: TransferStatus[];
  attention: AttentionSummary;
  counts: { baseline: number; localFiles: number; remoteFiles: number };
  /** Short human-readable lines for the tray tooltip. */
  summaryLines: string[];
}

/** The one line a person reads while a file run is moving. Null when there is nothing to count. */
export function glanceText(status: Pick<EngineStatus, 'state' | 'progress'>): string | null {
  const progress = status.progress;
  if (progress === null || progress.total <= 0) return null;
  if (status.state === 'syncing') return `Sync (${String(progress.done)}/${String(progress.total)})`;
  if (status.state === 'paused') return `Paused (${String(progress.done)}/${String(progress.total)})`;
  return null;
}

/** Every allowed transition; anything else is a programming error. */
const TRANSITIONS: Record<EngineState, readonly EngineState[]> = {
  starting: ['scanning', 'needs_login', 'error', 'paused', 'stopped', 'offline'],
  scanning: ['syncing', 'idle', 'attention', 'awaiting_confirmation', 'offline', 'error', 'paused', 'needs_login', 'stopped', 'throttled'],
  syncing: ['idle', 'attention', 'awaiting_confirmation', 'offline', 'error', 'paused', 'needs_login', 'stopped', 'throttled', 'scanning'],
  idle: ['scanning', 'syncing', 'attention', 'paused', 'offline', 'error', 'needs_login', 'stopped', 'throttled', 'awaiting_confirmation'],
  attention: ['scanning', 'syncing', 'idle', 'paused', 'offline', 'error', 'needs_login', 'stopped', 'awaiting_confirmation', 'throttled'],
  awaiting_confirmation: ['scanning', 'syncing', 'idle', 'attention', 'paused', 'offline', 'error', 'needs_login', 'stopped'],
  paused: ['scanning', 'idle', 'attention', 'stopped', 'needs_login', 'error'],
  offline: ['scanning', 'idle', 'attention', 'paused', 'error', 'needs_login', 'stopped', 'throttled'],
  throttled: ['scanning', 'syncing', 'idle', 'attention', 'paused', 'offline', 'error', 'needs_login', 'stopped'],
  error: ['scanning', 'paused', 'stopped', 'needs_login', 'idle'],
  needs_login: ['scanning', 'paused', 'stopped', 'error'],
  stopped: [],
};

export class IllegalStateTransitionError extends Error {
  constructor(from: EngineState, to: EngineState) {
    super(`Illegal engine state transition ${from} -> ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export function canTransition(from: EngineState, to: EngineState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function allTransitions(): { from: EngineState; to: EngineState }[] {
  const out: { from: EngineState; to: EngineState }[] = [];
  for (const from of Object.keys(TRANSITIONS) as EngineState[]) for (const to of TRANSITIONS[from]) out.push({ from, to });
  return out;
}

export function initialStatus(dryRun: boolean, now: number): EngineStatus {
  return {
    state: 'starting',
    reason: null,
    since: now,
    dryRun,
    degraded: false,
    lastSuccessfulSyncAt: null,
    lastCycleAt: null,
    pending: { uploads: 0, downloads: 0, other: 0 },
    progress: null,
    transfers: [],
    attention: { conflicts: 0, quarantined: 0, heldPlan: null },
    counts: { baseline: 0, localFiles: 0, remoteFiles: 0 },
    summaryLines: ['Starting'],
  };
}

export function summarize(status: EngineStatus): string[] {
  const lines: string[] = [];
  const label: Record<EngineState, string> = {
    starting: 'Starting',
    idle: 'In sync',
    scanning: 'Scanning',
    syncing: 'Syncing',
    paused: 'Paused',
    offline: 'Offline',
    throttled: 'Throttled by server',
    attention: 'Needs attention',
    awaiting_confirmation: 'Waiting for confirmation',
    error: 'Error',
    needs_login: 'Login required',
    stopped: 'Stopped',
  };
  const glance = glanceText(status);
  lines.push(glance ?? (status.reason !== null ? `${label[status.state]}: ${status.reason}` : label[status.state]));
  if (status.dryRun) lines.push('DRY RUN: no changes are made');
  if (status.degraded) lines.push('Event stream degraded; using periodic listings');
  if (status.transfers.length > 0) lines.push(`${String(status.transfers.length)} transfer(s) in progress`);
  const p = status.pending;
  if (p.uploads + p.downloads + p.other > 0) lines.push(`Pending: ${String(p.uploads)} up, ${String(p.downloads)} down, ${String(p.other)} other`);
  if (status.attention.conflicts > 0) lines.push(`${String(status.attention.conflicts)} conflict(s) to resolve`);
  if (status.attention.quarantined > 0) lines.push(`${String(status.attention.quarantined)} quarantined item(s)`);
  if (status.attention.heldPlan !== null) lines.push(`Held plan: ${status.attention.heldPlan.reason}`);
  const c = status.counts;
  if (c.baseline > 0 || c.localFiles > 0 || c.remoteFiles > 0) {
    lines.push(`Files: ${String(c.localFiles)} local, ${String(c.remoteFiles)} remote (${String(c.baseline)} synced)`);
  }
  if (status.lastSuccessfulSyncAt !== null) lines.push(`Last full sync: ${new Date(status.lastSuccessfulSyncAt).toISOString()}`);
  return lines;
}

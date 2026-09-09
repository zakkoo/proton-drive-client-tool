/**
 * Configuration schema, defaults, bounds and validation.
 *
 * The configuration file never contains secrets. Safety thresholds have hard
 * lower bounds: the brake cannot be disabled, and the percentage limit is
 * capped below 100 so deleting the entire tree always requires confirmation.
 */

export type CredentialsStoreKind = 'keychain' | 'unsafe_file';

export interface SafetyConfig {
  /** Halt when a plan would delete or replace more than this many items. */
  brakeMaxChanges: number;
  /** Halt when a plan would delete or replace more than this percent of the baseline. */
  brakeMaxChangePercent: number;
  /** Minimum baseline size before the percentage rule applies (count rule always applies). */
  brakePercentMinBaseline: number;
  /** Days to keep recycled local files before they are eligible for explicit purge. */
  recycleRetentionDays: number;
  /** Days to keep rotated audit logs. */
  logRetentionDays: number;
}

export interface TransferConfig {
  concurrency: number;
  /** Retry limit for transient failures per operation. */
  maxRetries: number;
}

export interface TimingConfig {
  /** Quiet period before a local change is considered settled. */
  debounceMs: number;
  /** Full local scan interval. */
  localScanIntervalMinutes: number;
  /** Full remote listing interval (safety net for the event stream). */
  remoteListingIntervalMinutes: number;
  /** After this long without events, the engine reports degraded and lists remotely. */
  eventSilenceMinutes: number;
}

export interface SyncConfig {
  version: 1;
  /** Absolute path of the local sync root. */
  localRoot: string;
  /** Remote folder path, POSIX style, e.g. /my-files or /my-files/Sync. */
  remoteRoot: string;
  /** Recorded at setup: the remote root node identifier. */
  remoteRootNodeUid?: string;
  /** Recorded at setup: the local root's file system identity. */
  localRootIdentity?: { dev: number; ino: number; birthtimeMs?: number };
  /** Glob ignore patterns (picomatch syntax), relative to the sync root. */
  ignore: string[];
  safety: SafetyConfig;
  transfers: TransferConfig;
  timing: TimingConfig;
  dryRun: boolean;
  startPaused: boolean;
  credentialsStore: CredentialsStoreKind;
  /** Only honoured together with credentialsStore = unsafe_file. */
  acknowledgeUnsafeCredentialsStore: boolean;
}

export const DEFAULT_IGNORE: readonly string[] = [
  // Our own state area.
  '.proton-sync',
  '.proton-sync/**',
  // Editor and tool temp files.
  '**/*~',
  '**/*.swp',
  '**/*.swo',
  '**/*.tmp',
  '**/*.part',
  '**/*.crdownload',
  '**/.#*',
  '**/#*#',
  '**/~$*',
  // OS metadata.
  '**/.DS_Store',
  '**/._*',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/.directory',
  '**/.Trash-*',
  '**/.Trash-*/**',
  // Sync tool state of other tools.
  '**/.sync',
  '**/.stfolder',
];

export const DEFAULTS: Omit<SyncConfig, 'localRoot' | 'remoteRoot'> = {
  version: 1,
  ignore: [...DEFAULT_IGNORE],
  safety: {
    brakeMaxChanges: 50,
    brakeMaxChangePercent: 10,
    brakePercentMinBaseline: 20,
    recycleRetentionDays: 30,
    logRetentionDays: 90,
  },
  transfers: {
    concurrency: 3,
    maxRetries: 5,
  },
  timing: {
    debounceMs: 2000,
    localScanIntervalMinutes: 60,
    remoteListingIntervalMinutes: 60,
    eventSilenceMinutes: 15,
  },
  dryRun: false,
  startPaused: false,
  credentialsStore: 'keychain',
  acknowledgeUnsafeCredentialsStore: false,
};

interface Bound {
  min: number;
  max: number;
  integer: boolean;
}

export const BOUNDS = {
  'safety.brakeMaxChanges': { min: 1, max: 100_000, integer: true },
  'safety.brakeMaxChangePercent': { min: 1, max: 99, integer: true },
  'safety.brakePercentMinBaseline': { min: 1, max: 1_000_000, integer: true },
  'safety.recycleRetentionDays': { min: 1, max: 3650, integer: true },
  'safety.logRetentionDays': { min: 1, max: 3650, integer: true },
  'transfers.concurrency': { min: 1, max: 16, integer: true },
  'transfers.maxRetries': { min: 0, max: 20, integer: true },
  'timing.debounceMs': { min: 200, max: 60_000, integer: true },
  'timing.localScanIntervalMinutes': { min: 1, max: 1440, integer: true },
  'timing.remoteListingIntervalMinutes': { min: 1, max: 1440, integer: true },
  'timing.eventSilenceMinutes': { min: 1, max: 1440, integer: true },
} as const satisfies Record<string, Bound>;

export type BoundedKey = keyof typeof BOUNDS;

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      cur[part] = created;
      cur = created;
    } else {
      cur = next;
    }
  }
  const last = parts.at(-1);
  if (last !== undefined) cur[last] = value;
}

/**
 * Validate a bounded numeric setting. Returns a problem string or null.
 */
export function checkBound(key: BoundedKey, value: unknown): string | null {
  const b: Bound = BOUNDS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${key} must be a finite number (got ${JSON.stringify(value)})`;
  }
  if (b.integer && !Number.isInteger(value)) {
    return `${key} must be an integer (got ${value})`;
  }
  if (value < b.min || value > b.max) {
    if (key === 'safety.brakeMaxChanges' && value < b.min) {
      return `${key} must be at least ${b.min}: the mass-change brake cannot be disabled`;
    }
    if (key === 'safety.brakeMaxChangePercent' && value > b.max) {
      return `${key} must be at most ${b.max}: deleting the entire tree must always require confirmation`;
    }
    return `${key} must be between ${b.min} and ${b.max} (got ${value})`;
  }
  return null;
}

function isPosixRemotePath(p: string): boolean {
  return p.startsWith('/') && !p.includes('\\') && !p.split('/').some((seg) => seg === '..' || seg === '.') && (p === '/' || !p.endsWith('/'));
}

/**
 * Parse and validate raw configuration data (e.g. parsed JSON). Missing
 * optional fields take defaults. Throws ConfigError listing every problem.
 *
 * File-system checks on localRoot are done separately (see localRoot.ts)
 * because they need I/O and context (existing roots).
 */
export function parseConfig(raw: unknown): SyncConfig {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    throw new ConfigError(['configuration must be an object']);
  }
  const merged: Record<string, unknown> = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v) && isRecord(merged[k])) {
      const existing = merged[k];
      merged[k] = isRecord(existing) ? { ...existing, ...v } : v;
    } else {
      merged[k] = v;
    }
  }

  if (merged['version'] !== 1) problems.push(`version must be 1 (got ${JSON.stringify(merged['version'])})`);

  const localRoot = merged['localRoot'];
  if (typeof localRoot !== 'string' || localRoot.trim() === '') {
    problems.push('localRoot is required and must be a non-empty string');
  } else if (!localRoot.startsWith('/')) {
    problems.push('localRoot must be an absolute path');
  }

  const remoteRoot = merged['remoteRoot'];
  if (typeof remoteRoot !== 'string' || remoteRoot.trim() === '') {
    problems.push('remoteRoot is required and must be a non-empty string');
  } else if (!isPosixRemotePath(remoteRoot)) {
    problems.push('remoteRoot must be an absolute POSIX path without trailing slash or dot segments, e.g. /my-files/Sync');
  } else if (remoteRoot === '/') {
    problems.push('remoteRoot must be a folder below /, e.g. /my-files or /my-files/Sync');
  }

  const remoteRootNodeUid = merged['remoteRootNodeUid'];
  if (remoteRootNodeUid !== undefined && (typeof remoteRootNodeUid !== 'string' || remoteRootNodeUid === '')) {
    problems.push('remoteRootNodeUid must be a non-empty string when present');
  }
  const identity = merged['localRootIdentity'];
  if (identity !== undefined) {
    if (!isRecord(identity) || !Number.isInteger(identity['dev']) || !Number.isInteger(identity['ino']) || (identity['birthtimeMs'] !== undefined && typeof identity['birthtimeMs'] !== 'number')) {
      problems.push('localRootIdentity must be { dev: integer, ino: integer, birthtimeMs?: number } when present');
    }
  }

  const ignore = merged['ignore'];
  if (!Array.isArray(ignore) || !ignore.every((p) => typeof p === 'string' && p.trim() !== '')) {
    problems.push('ignore must be an array of non-empty glob strings');
  } else {
    // Internal directory is always ignored, regardless of user configuration.
    const set = new Set(ignore);
    set.add('.proton-sync');
    set.add('.proton-sync/**');
    merged['ignore'] = [...set];
  }

  for (const key of Object.keys(BOUNDS) as BoundedKey[]) {
    const value = getPath(merged, key);
    const problem = checkBound(key, value);
    if (problem !== null) problems.push(problem);
  }
  const safety = merged['safety'];
  if (isRecord(safety)) {
    for (const k of Object.keys(safety)) {
      if (!(`safety.${k}` in BOUNDS)) problems.push(`unknown setting safety.${k}`);
    }
  }

  for (const flag of ['dryRun', 'startPaused', 'acknowledgeUnsafeCredentialsStore'] as const) {
    if (typeof merged[flag] !== 'boolean') problems.push(`${flag} must be a boolean`);
  }

  const store = merged['credentialsStore'];
  if (store !== 'keychain' && store !== 'unsafe_file') {
    problems.push(`credentialsStore must be "keychain" or "unsafe_file" (got ${JSON.stringify(store)})`);
  } else if (store === 'unsafe_file' && merged['acknowledgeUnsafeCredentialsStore'] !== true) {
    problems.push(
      'credentialsStore "unsafe_file" stores the session in PLAINTEXT on disk and requires acknowledgeUnsafeCredentialsStore: true',
    );
  }

  const known = new Set([
    'version', 'localRoot', 'remoteRoot', 'remoteRootNodeUid', 'localRootIdentity', 'ignore', 'safety', 'transfers',
    'timing', 'dryRun', 'startPaused', 'credentialsStore', 'acknowledgeUnsafeCredentialsStore',
  ]);
  for (const k of Object.keys(merged)) {
    if (!known.has(k)) problems.push(`unknown setting ${k}`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return merged as unknown as SyncConfig;
}

/**
 * Apply a single change to an existing config and re-validate. On failure the
 * previous configuration is returned unchanged along with the problems.
 */
export function withSetting(
  config: SyncConfig,
  dotted: string,
  value: unknown,
): { config: SyncConfig; problems: string[] } {
  const draft = structuredClone(config) as unknown as Record<string, unknown>;
  setPath(draft, dotted, value);
  try {
    return { config: parseConfig(draft), problems: [] };
  } catch (error) {
    if (error instanceof ConfigError) return { config, problems: [...error.problems] };
    throw error;
  }
}

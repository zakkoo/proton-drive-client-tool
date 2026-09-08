import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import type { SecretRegistry } from './redact.js';
import { redact, secretRegistry } from './redact.js';
import type { AuditEntry, AuditEntryInput } from './types.js';

export interface AuditLogOptions {
  /** Directory holding the active log and rotated logs. Created if missing. */
  dir: string;
  /** Base name of the active log file. Default: audit.log */
  fileName?: string;
  /** Rotate when the active file exceeds this many bytes. Default: 10 MiB */
  maxBytes?: number;
  /** Delete rotated files older than this many days. Default: 90 */
  retentionDays?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  registry?: SecretRegistry;
}

const ROTATED_SUFFIX = /^(.*)\.(\d{8}T\d{6}\d{3}Z)(?:-(\d+))?\.log$/;

/**
 * Append-only JSON Lines audit log.
 *
 * - One entry per line; `ts` is always the first field.
 * - Writes use O_APPEND so lines are never interleaved or truncated.
 * - Rotation renames the active file and starts a fresh one; no entry is lost.
 * - Rotated files older than the retention period are removed by `purgeRotated()`,
 *   which only ever touches files produced by this logger.
 */
export class AuditLog {
  readonly dir: string;
  readonly activePath: string;
  private readonly baseName: string;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;
  private readonly registry: SecretRegistry;
  private seq = 0;
  private rotationCounter = 0;

  constructor(options: AuditLogOptions) {
    this.dir = options.dir;
    const fileName = options.fileName ?? 'audit.log';
    this.baseName = fileName.replace(/\.log$/, '');
    this.activePath = path.join(this.dir, fileName);
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.retentionMs = (options.retentionDays ?? 90) * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? secretRegistry;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Build the entry that would be written, redacted, without writing it. */
  prepare(input: AuditEntryInput): AuditEntry {
    const ts = this.now().toISOString();
    const seq = ++this.seq;
    const redacted = redact(input, this.registry) as AuditEntryInput;
    // Keep field order stable: ts, seq, kind, message, then the rest.
    const { kind, message, ...rest } = redacted;
    return { ts, seq, kind, message, ...rest };
  }

  /** Append one entry. Synchronous so ordering with the caller is exact. */
  append(input: AuditEntryInput): AuditEntry {
    const entry = this.prepare(input);
    const line = JSON.stringify(entry) + '\n';
    this.rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this.activePath, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    return entry;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      const fd = openSync(this.activePath, 'r');
      try {
        size = fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
    } catch {
      return; // no active file yet
    }
    if (size === 0 || size + incomingBytes <= this.maxBytes) {
      return;
    }
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace('.', '');
    let target = path.join(this.dir, `${this.baseName}.${stamp}.log`);
    while (existsSync(target)) {
      this.rotationCounter += 1;
      target = path.join(this.dir, `${this.baseName}.${stamp}-${this.rotationCounter}.log`);
    }
    renameSync(this.activePath, target);
  }

  /** All log files, oldest first, active file last. */
  files(): string[] {
    const rotated = readdirSync(this.dir)
      .filter((f) => {
        const m = ROTATED_SUFFIX.exec(f);
        return m !== null && m[1] === this.baseName;
      })
      .sort()
      .map((f) => path.join(this.dir, f));
    return existsSync(this.activePath) ? [...rotated, this.activePath] : rotated;
  }

  /** Read every entry across all files, oldest first. Malformed lines are reported, not dropped silently. */
  readAll(): { entries: AuditEntry[]; malformed: string[] } {
    const entries: AuditEntry[] = [];
    const malformed: string[] = [];
    for (const file of this.files()) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          malformed.push(line);
        }
      }
    }
    return { entries, malformed };
  }

  /** Delete rotated files older than the retention period. Returns removed paths. */
  purgeRotated(): string[] {
    const cutoff = this.now().getTime() - this.retentionMs;
    const removed: string[] = [];
    for (const file of this.files()) {
      if (file === this.activePath) continue;
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file);
        removed.push(file);
      }
    }
    return removed;
  }
}

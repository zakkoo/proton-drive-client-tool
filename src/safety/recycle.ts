/**
 * Local recycle bin: the only way a local user file ever leaves its place.
 *
 * Items are moved (renamed, same file system) into
 * `<root>/.proton-sync/recycle/<timestamp>/<relPath>`. Nothing here unlinks
 * user data; `purge()` is the single, explicit retention command and it logs
 * every path it removes.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type { AuditLog } from '../audit/logger.js';
import { INTERNAL_DIR_NAME } from '../config/paths.js';

export interface RecycledItem {
  /** Timestamp bucket (ms since epoch) the item was recycled in. */
  bucket: number;
  relPath: string;
  absolutePath: string;
  kind: 'file' | 'dir';
}

export class RecycleBin {
  readonly dir: string;

  constructor(
    private readonly root: string,
    private readonly retentionDays: number,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(root, INTERNAL_DIR_NAME, 'recycle');
  }

  /** Where a recycled copy of `relPath` would land right now. */
  destinationFor(relPath: string, bucket: number = this.now()): string {
    return path.join(this.dir, String(bucket), relPath);
  }

  /**
   * Move `relPath` (file or whole directory) into the bin. The destination
   * never overwrites an existing entry: a numeric suffix is added if needed.
   */
  recycle(relPath: string, reason: string): RecycledItem {
    if (relPath === '' || relPath.startsWith('..') || path.isAbsolute(relPath)) throw new Error(`Refusing to recycle invalid path ${relPath}`);
    if (relPath === INTERNAL_DIR_NAME || relPath.startsWith(`${INTERNAL_DIR_NAME}/`)) throw new Error(`Refusing to recycle the internal directory ${relPath}`);
    const source = path.join(this.root, relPath);
    const st = statSync(source);
    const bucket = this.now();
    let destination = this.destinationFor(relPath, bucket);
    mkdirSync(path.dirname(destination), { recursive: true });
    for (let i = 1; ; i++) {
      try {
        statSync(destination);
        destination = `${this.destinationFor(relPath, bucket)}.${String(i)}`;
      } catch {
        break;
      }
    }
    renameSync(source, destination);
    const kind = st.isDirectory() ? 'dir' : 'file';
    this.audit.append({ kind: 'execute', op: 'recycle_local', message: `recycled ${kind} ${relPath} (${reason})`, path: relPath, outcome: 'ok', details: { destination, bucket } });
    return { bucket, relPath, absolutePath: destination, kind };
  }

  /** Every recycled top-level entry, newest bucket first. */
  list(): RecycledItem[] {
    let buckets: string[];
    try {
      buckets = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: RecycledItem[] = [];
    for (const b of buckets.map(Number).filter((n) => Number.isFinite(n)).sort((a, c) => c - a)) {
      const bucketDir = path.join(this.dir, String(b));
      const walk = (dir: string, rel: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            out.push({ bucket: b, relPath: r, absolutePath: path.join(dir, entry.name), kind: 'dir' });
            walk(path.join(dir, entry.name), r);
          } else {
            out.push({ bucket: b, relPath: r, absolutePath: path.join(dir, entry.name), kind: 'file' });
          }
        }
      };
      walk(bucketDir, '');
    }
    return out;
  }

  /**
   * Remove buckets older than the retention period. This is the only place in
   * the application that permanently removes recycled user data, and it is
   * only ever invoked by an explicit command.
   */
  purge(): string[] {
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let buckets: string[];
    try {
      buckets = readdirSync(this.dir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of buckets) {
      const bucket = Number(name);
      if (!Number.isFinite(bucket) || bucket >= cutoff) continue;
      const bucketDir = path.join(this.dir, name);
      const paths: string[] = [];
      const walk = (dir: string, rel: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
          else paths.push(r);
        }
      };
      walk(bucketDir, '');
      for (const p of paths) {
        this.audit.append({ kind: 'safety', op: 'purge_recycle', message: `purged recycled file ${p} from bucket ${name}`, path: p, outcome: 'ok', details: { bucket } });
        removed.push(p);
      }
      rmSync(bucketDir, { recursive: true, force: true });
    }
    return removed;
  }
}

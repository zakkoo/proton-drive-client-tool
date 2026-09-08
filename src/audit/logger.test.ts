import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from './logger.js';
import { SecretRegistry } from './redact.js';
import { AUDIT_FIELDS } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  return () => new Date((t += 1000));
}

describe('AuditLog', () => {
  it('writes one JSON line per entry with ts first and stable field names', () => {
    const log = new AuditLog({ dir, now: clock(), registry: new SecretRegistry() });
    log.append({ kind: 'execute', message: 'uploaded', op: 'upload', path: 'a.txt', outcome: 'ok' });
    log.append({ kind: 'plan', message: 'planned', details: { evidence: ['local modified'] } });
    const lines = readFileSync(log.activePath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed)[0]).toBe('ts');
      for (const key of Object.keys(parsed)) {
        expect(AUDIT_FIELDS as readonly string[]).toContain(key);
      }
    }
    expect((JSON.parse(lines[0] ?? '{}') as { seq: number }).seq).toBe(1);
    expect((JSON.parse(lines[1] ?? '{}') as { seq: number }).seq).toBe(2);
  });

  it('rotates by size without losing a single entry and parses every line back', () => {
    const log = new AuditLog({ dir, maxBytes: 600, now: clock(), registry: new SecretRegistry() });
    const total = 200;
    for (let i = 0; i < total; i++) {
      log.append({ kind: 'execute', message: `entry ${i}`, path: `file-${i}.bin`, outcome: 'ok' });
    }
    const files = log.files();
    expect(files.length).toBeGreaterThan(3);
    expect(files.at(-1)).toBe(log.activePath);
    const { entries, malformed } = log.readAll();
    expect(malformed).toEqual([]);
    expect(entries).toHaveLength(total);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(new Set(entries.map((e) => e.message)).size).toBe(total);
  });

  it('never splits a line across files', () => {
    const log = new AuditLog({ dir, maxBytes: 300, now: clock(), registry: new SecretRegistry() });
    for (let i = 0; i < 50; i++) {
      log.append({ kind: 'plan', message: 'x'.repeat(50 + (i % 7)) });
    }
    for (const file of log.files()) {
      const text = readFileSync(file, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      for (const line of text.trimEnd().split('\n')) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
    }
  });

  it('purges only rotated files older than retention, never the active file', () => {
    const now = clock();
    const log = new AuditLog({ dir, maxBytes: 200, retentionDays: 30, now, registry: new SecretRegistry() });
    for (let i = 0; i < 30; i++) log.append({ kind: 'plan', message: 'y'.repeat(60) });
    const rotated = log.files().filter((f) => f !== log.activePath);
    expect(rotated.length).toBeGreaterThan(0);
    const old = new Date(Date.UTC(2020, 0, 1));
    const victim = rotated[0];
    if (victim === undefined) throw new Error('expected a rotated file');
    utimesSync(victim, old, old);
    const removed = log.purgeRotated();
    expect(removed).toEqual([victim]);
    expect(log.files()).toContain(log.activePath);
    expect(log.files()).not.toContain(victim);
  });

  it('reports malformed lines instead of dropping them silently', () => {
    const log = new AuditLog({ dir, now: clock(), registry: new SecretRegistry() });
    log.append({ kind: 'plan', message: 'ok' });
    // Simulate a torn write from a crash.
    appendFileSync(log.activePath, '{"ts":"2026-01-01T00:00:0');
    const { entries, malformed } = log.readAll();
    expect(entries).toHaveLength(1);
    expect(malformed).toHaveLength(1);
  });
});

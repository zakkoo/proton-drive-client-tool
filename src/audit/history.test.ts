import { describe, expect, it } from 'vitest';

import { history } from './history.js';
import type { AuditEntry } from './types.js';

let seq = 0;
function e(ts: string, partial: Partial<AuditEntry>): AuditEntry {
  return { ts, seq: ++seq, kind: 'execute', message: partial.message ?? 'm', ...partial };
}

describe('history', () => {
  const entries: AuditEntry[] = [
    e('2026-01-01T00:00:01Z', { op: 'upload', path: 'draft.txt', nodeUid: 'N1', message: 'created' }),
    e('2026-01-01T00:00:02Z', { op: 'upload', path: 'other.txt', nodeUid: 'N2', message: 'unrelated' }),
    e('2026-01-01T00:00:03Z', { op: 'move_remote', previousPath: 'draft.txt', path: 'notes/draft.txt', nodeUid: 'N1', message: 'moved' }),
    e('2026-01-01T00:00:04Z', { op: 'move_local', previousPath: 'notes/draft.txt', path: 'notes/final.txt', message: 'renamed (no uid in entry)' }),
    e('2026-01-01T00:00:05Z', { op: 'download', path: 'notes/final.txt', message: 'updated' }),
    e('2026-01-01T00:00:06Z', { op: 'download', path: 'draft.txt', nodeUid: 'N3', message: 'new unrelated file reusing old name' }),
  ];

  it('returns the full chain for the current path, including entries under earlier paths', () => {
    const out = history(entries, { path: 'notes/final.txt' });
    expect(out.map((x) => x.message)).toEqual([
      'created',
      'moved',
      'renamed (no uid in entry)',
      'updated',
      // Old name reused by another file also matches by path; the reader sees the uid differs.
      'new unrelated file reusing old name',
    ]);
  });

  it('follows the node uid forward through renames that carry no uid', () => {
    const out = history(entries, { nodeUid: 'N1' });
    expect(out.map((x) => x.message)).toContain('renamed (no uid in entry)');
    expect(out.map((x) => x.message)).toContain('updated');
    expect(out.map((x) => x.message)).not.toContain('unrelated');
  });

  it('returns entries in chronological order and nothing for an empty query', () => {
    const out = history(entries, { nodeUid: 'N1' });
    const ts = out.map((x) => x.ts);
    expect([...ts].sort()).toEqual(ts);
    expect(history(entries, {})).toEqual([]);
  });
});

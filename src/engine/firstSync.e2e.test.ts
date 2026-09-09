import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineHarness } from '../testing/engineHarness.js';

/**
 * First sync of two non-empty sides (spec: test-suite / First sync of two
 * non-empty sides). With no baseline and files already on both sides, one-sided
 * files are copied across, a same path with different content becomes a
 * conflict, and nothing is trashed or recycled.
 */

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  h.assertNoUserContentLost();
  await h.dispose();
});

describe('first sync of two non-empty sides', () => {
  it('copies one-sided files, conflicts same-path differences, and deletes nothing', async () => {
    // Only on the local side.
    h.write('local-only.txt', 'LO');
    h.write('nested/deep.txt', 'DEEP');
    // Only on the remote side.
    h.fake.seedFile(h.remoteRootUid, 'remote-only.txt', 'RO');
    // Same path, different content on each side.
    h.write('both.txt', 'local version');
    h.fake.seedFile(h.remoteRootUid, 'both.txt', 'remote version');

    await h.start();
    await h.waitForConvergence(15_000);

    const local = h.localFiles();
    // One-sided files reached the other side (copied, not deleted).
    expect(local.get('local-only.txt')).toBe('LO');
    expect(local.get('nested/deep.txt')).toBe('DEEP');
    expect(local.get('remote-only.txt')).toBe('RO');
    expect(h.remoteFiles().get('local-only.txt')).toBe('LO');
    expect(h.remoteFiles().get('remote-only.txt')).toBe('RO');

    // The same-path difference is a conflict: the remote copy stays at the path,
    // the local version is kept beside it, and both survive.
    const conflicts = h.bundle?.controlTarget.listConflicts() ?? [];
    expect(conflicts.map((c) => c.kind)).toContain('create_create');
    const conflictCopies = [...local.keys()].filter((k) => k.includes('.conflict-'));
    expect(conflictCopies).toHaveLength(1);
    expect([...local.values()]).toContain('local version');
    expect([...local.values()]).toContain('remote version');

    // A first sync never deletes.
    expect(h.fake.trashedUids(), 'first sync must not trash').toEqual([]);
    expect(h.bundle?.recycle.list(), 'first sync must not recycle').toEqual([]);
    expect(existsSync(path.join(h.root, 'both.txt'))).toBe(true);
    expect(readFileSync(path.join(h.root, 'both.txt'), 'utf8')).toBe('remote version');
  });
});

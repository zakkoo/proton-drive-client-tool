import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineHarness } from '../testing/engineHarness.js';

/**
 * "Absence is not a delete" (spec: test-suite / Absence is not a delete). A path
 * that vanishes from a partial view — ignored after a sync, unreadable, replaced
 * by a symlink, missing from an empty/incomplete listing, or gone because the
 * local root was swapped — must never cause a remote trash or a local recycle.
 *
 * Each scenario mutates the world after a clean sync and then forces a full
 * re-evaluation with `restart()` (a fresh watcher scan and remote refresh), so
 * the reconciler really re-sees the changed side rather than a cached snapshot.
 */

const RESTING = ['idle', 'attention', 'awaiting_confirmation', 'error', 'paused', 'needs_login', 'offline'] as const;

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  h.assertNoUserContentLost();
  await h.dispose();
});

/** Let the current/next cycle come to rest, then nudge one more and rest again. */
async function settle(): Promise<void> {
  await h.waitFor([...RESTING]);
  await h.bundle?.engine.syncNow().catch(() => undefined);
  await h.waitFor([...RESTING]);
}

describe('absence is not a delete', () => {
  it('Ignore after sync: a previously synced file added to ignore is left on both sides', async () => {
    h.write('keep.txt', 'K');
    h.write('secret.txt', 'S');
    await h.start();
    await h.waitForConvergence();
    expect(h.remotePathToUid('secret.txt')).toBeDefined();

    h.config = { ...h.config, ignore: [...h.config.ignore, 'secret.txt'] };
    await h.restart();
    await settle();

    expect(h.fake.trashedUids(), 'ignored-after-sync must not trash the remote node').toEqual([]);
    expect(existsSync(path.join(h.root, 'secret.txt')), 'the ignored local file must remain').toBe(true);
    expect(readFileSync(path.join(h.root, 'secret.txt'), 'utf8')).toBe('S');
  });

  it('Unreadable after sync: a file that becomes unreadable is not trashed remotely', async () => {
    h.write('doc.txt', 'D');
    await h.start();
    await h.waitForConvergence();

    chmodSync(path.join(h.root, 'doc.txt'), 0o000);
    try {
      await h.restart();
      await settle();
      expect(h.fake.trashedUids(), 'an unreadable local file must not trash the remote node').toEqual([]);
    } finally {
      chmodSync(path.join(h.root, 'doc.txt'), 0o644); // so dispose can clean up
    }
  });

  it('Symlink after sync: a file replaced by a symlink is not trashed remotely', async () => {
    h.write('link-me.txt', 'L');
    await h.start();
    await h.waitForConvergence();

    rmSync(path.join(h.root, 'link-me.txt'));
    symlinkSync('/etc/hostname', path.join(h.root, 'link-me.txt'));
    await h.restart();
    await settle();

    expect(h.fake.trashedUids(), 'a symlink replacing a synced file must not trash the remote node').toEqual([]);
  });

  it('Incomplete or empty remote listing: a failed then empty listing trashes and recycles nothing', async () => {
    h.write('a.txt', 'A');
    h.write('b.txt', 'B');
    await h.start();
    await h.waitForConvergence();
    const recycledBefore = h.recycledContents().length;

    // A listing that fails outright (the first refresh after restart throws).
    h.fake.injectFault('list', { kind: 'connection' });
    await h.restart();
    await settle();
    expect(h.fake.trashedUids(), 'a failed listing must not trash anything').toEqual([]);
    expect(h.recycledContents().length, 'a failed listing must not recycle anything').toBe(recycledBefore);

    // A listing that returns only the root (looks empty) while the baseline is populated.
    h.fake.listSuppressed = () => true;
    await h.restart();
    await settle();
    expect(h.fake.trashedUids(), 'an empty listing must not trash anything').toEqual([]);
    expect(h.recycledContents().length, 'an empty listing must not recycle anything').toBe(recycledBefore);
    h.fake.listSuppressed = undefined;
  });

  it('Local root replaced: swapping the root directory for a new inode pauses without deleting', async () => {
    h.write('one.txt', '1');
    h.write('two.txt', '2');
    await h.start();
    await h.waitForConvergence();

    // Replace the directory at the same path with a different filesystem object.
    rmSync(h.root, { recursive: true, force: true });
    mkdirSync(h.root);
    await h.restart();
    await settle();

    expect(h.fake.trashedUids(), 'a replaced root must not trash the remote tree').toEqual([]);
    expect(['error', 'paused', 'offline', 'needs_login'], `state was ${h.bundle?.engine.getStatus().state ?? '?'}`).toContain(h.bundle?.engine.getStatus().state);
  });

  it('Unreadable nested directory: an unlistable subtree does not mark the snapshot complete or trash its children', async () => {
    h.write('top.txt', 'T');
    h.write('nested/a.txt', 'A');
    h.write('nested/b.txt', 'B');
    await h.start();
    await h.waitForConvergence();

    // The nested directory becomes unreadable while the engine re-evaluates.
    chmodSync(path.join(h.root, 'nested'), 0o000);
    try {
      await h.restart();
      await settle();
      // Its children are absent from the scan, but an unreadable directory marks the snapshot
      // incomplete, so their absence is not trusted and nothing is trashed remotely.
      expect(h.fake.trashedUids(), 'children of an unreadable directory must not be trashed').toEqual([]);
    } finally {
      chmodSync(path.join(h.root, 'nested'), 0o755);
    }
  });

  it('Proton document: a document node is blocked, a normal file syncs, and nothing is trashed', async () => {
    h.fake.seedProtonDocument(h.remoteRootUid, 'design.protondoc');
    h.fake.seedFile(h.remoteRootUid, 'real.txt', 'R');
    await h.start();
    await h.waitFor(['idle', 'attention']);
    // Give the file time to download.
    for (let i = 0; i < 50 && !h.localFiles().has('real.txt'); i++) await new Promise((r) => setTimeout(r, 30));

    // The normal file synced; the Proton document was not downloaded and neither side was trashed.
    expect(h.localFiles().get('real.txt')).toBe('R');
    expect(h.localFiles().has('design.protondoc'), 'a Proton document is not downloaded').toBe(false);
    expect(h.fake.trashedUids(), 'a Proton document must not be trashed').toEqual([]);
    const blocked = h.audit.readAll().entries.filter((e) => e.op === 'blocked' && e.message.includes('proton_document'));
    expect(blocked.length, 'the document is recorded as blocked').toBeGreaterThanOrEqual(1);
  });

  it('Pair changed: pointing setup at a different remote folder is a first sync, not a mass delete', async () => {
    h.write('keep-a.txt', 'A');
    h.write('keep-b.txt', 'B');
    await h.start();
    await h.waitForConvergence();

    // Re-point the pair at a brand-new empty remote folder (as `setup <newFolder>` would).
    const other = h.fake.seedFolder(h.fake.rootUid, 'Other');
    h.config = { ...h.config, remoteRootNodeUid: other.uid, remoteRoot: '/my-files/Other' };
    await h.restart();
    await settle();

    // A pair change is a first sync: no deletes anywhere, and no held mass-delete plan.
    expect(h.fake.trashedUids(), 'a pair change must not trash the old folder').toEqual([]);
    expect(h.recycledContents(), 'a pair change must not recycle the local tree').toEqual([]);
    expect(existsSync(path.join(h.root, 'keep-a.txt'))).toBe(true);
    expect(existsSync(path.join(h.root, 'keep-b.txt'))).toBe(true);
    const status = h.bundle?.engine.getStatus();
    expect(status?.attention.heldPlan, 'a pair change must not hold a mass-delete plan').toBeNull();
    expect(status?.state, `state was ${status?.state ?? '?'}`).not.toBe('awaiting_confirmation');
  });
});

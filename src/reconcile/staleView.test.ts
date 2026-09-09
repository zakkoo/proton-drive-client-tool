import { describe, expect, it } from 'vitest';

import { World } from '../testing/world.js';
import { reconcile } from './reconcile.js';
import type { BaselineItem } from './types.js';

/**
 * The stale-view guard is the backstop for our own mutations (spec: test-suite
 * / the executor's onRemoteChange is unwired, so the mirror can lag). After we
 * upload a file, a remote listing that started before the upload does not show
 * it; its absence must not be read as a remote deletion and recycle the local
 * file. The guard blocks that whenever the view predates the item's last sync.
 */

function syncedWorld(): World {
  const w = new World();
  w.localWrite('keep.txt', 'K');
  w.localWrite('ours.txt', 'O');
  w.remoteWrite('keep.txt', 'K');
  w.remoteWrite('ours.txt', 'O');
  w.markAllSynced();
  return w;
}

/** Set an explicit last-sync time on every baseline row. */
function withSyncedAt(baseline: ReadonlyMap<string, BaselineItem>, t: number): Map<string, BaselineItem> {
  return new Map([...baseline].map(([p, b]) => [p, { ...b, syncedAt: t }]));
}

describe('stale view prevents recycle after our own upload (feed disabled)', () => {
  it('a remote listing older than the last sync does not recycle a file it fails to show', () => {
    const w = syncedWorld();
    const base = w.input();
    const baseline = withSyncedAt(base.baseline, 1000);

    // The remote view predates our upload of ours.txt (asOf 500 < syncedAt 1000) and omits it.
    const oursUid = [...base.remote.items.values()].find((n) => n.name === 'ours.txt')?.uid ?? '';
    const staleItems = new Map(base.remote.items);
    staleItems.delete(oursUid);

    const stale = reconcile({ ...base, baseline, remote: { ...base.remote, items: staleItems, asOf: 500 } });
    expect(stale.operations.filter((o) => o.kind === 'recycle_local'), 'a stale view must not recycle').toEqual([]);
    expect(stale.blocked.some((b) => b.reason === 'stale_view' && b.relPath === 'ours.txt'), 'the absence is blocked as stale').toBe(true);

    // Control: a fresh view (asOf 2000 > syncedAt 1000) that still lacks the node is a real delete.
    const fresh = reconcile({ ...base, baseline, remote: { ...base.remote, items: staleItems, asOf: 2000 } });
    expect(fresh.operations.some((o) => o.kind === 'recycle_local' && o.relPath === 'ours.txt'), 'a fresh view does recycle a truly deleted file').toBe(true);
  });
});

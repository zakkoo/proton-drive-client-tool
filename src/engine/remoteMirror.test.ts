import { describe, expect, it } from 'vitest';

import { FakeRemote } from '../testing/fakeRemote.js';
import { RemoteMirror } from './remoteMirror.js';
import { listRemoteTree } from './views.js';

/**
 * A failed remote refresh must never look complete (spec: test-suite / Absence
 * is not a delete — an incomplete or failed listing withholds deletes). The
 * mirror only adopts a listing that finished; a throw leaves it incomplete and
 * keeps no half listing.
 */

function seedTree(): { fake: FakeRemote; root: string } {
  const fake = new FakeRemote();
  const root = fake.seedFolder(fake.rootUid, 'Sync').uid;
  fake.seedFile(root, 'a.txt', 'A');
  const sub = fake.seedFolder(root, 'sub').uid;
  fake.seedFile(sub, 'b.txt', 'B');
  return { fake, root };
}

describe('RemoteMirror completeness', () => {
  it('a fresh mirror is incomplete until a full refresh succeeds', () => {
    const { fake, root } = seedTree();
    const mirror = new RemoteMirror(fake, root, () => 1000);
    expect(mirror.isComplete).toBe(false);
    expect(mirror.view().complete).toBe(false);
  });

  it('a failed full refresh throws, stays incomplete, and keeps no half listing', async () => {
    const { fake, root } = seedTree();
    const mirror = new RemoteMirror(fake, root, () => 1000);

    await mirror.fullRefresh();
    expect(mirror.isComplete).toBe(true);
    const completeSize = mirror.size;
    expect(completeSize).toBeGreaterThan(0);

    // The next listing fails partway (the root list rejects).
    fake.injectFault('list', { kind: 'connection' });
    await expect(mirror.fullRefresh()).rejects.toThrow();

    // The mirror is now marked incomplete and unavailable — a failed refresh cannot look complete.
    expect(mirror.isComplete).toBe(false);
    expect(mirror.view().complete).toBe(false);
    expect(mirror.view().available).toBe(false);
    // It did not adopt a partial listing: the node set was not replaced by a half result.
    expect(mirror.size).toBe(completeSize);
  });

  it('listRemoteTree throws instead of returning a partial tree', async () => {
    const { fake, root } = seedTree();
    fake.injectFault('list', { kind: 'connection' });
    await expect(listRemoteTree(fake, root)).rejects.toThrow();
  });
});

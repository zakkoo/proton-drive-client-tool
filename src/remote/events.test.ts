import { describe, expect, it } from 'vitest';

import { FakeRemote } from '../testing/fakeRemote.js';
import { RemoteChangeFeed, type EventCursorStore, type NodeRemoteEvent } from './events.js';
import { createLogger, silentSink } from './proton/logger.js';

class MemoryCursors implements EventCursorStore {
  readonly map = new Map<string, string>();
  readonly writes: string[] = [];
  get(scope: string): Promise<string | null> {
    return Promise.resolve(this.map.get(scope) ?? null);
  }
  set(scope: string, id: string): Promise<void> {
    this.map.set(scope, id);
    this.writes.push(id);
    return Promise.resolve();
  }
}

function setup(over: { onEvent?: (e: NodeRemoteEvent) => Promise<void>; onRefresh?: (r: string) => Promise<void>; now?: () => number; silenceThresholdMs?: number } = {}) {
  const fake = new FakeRemote();
  const cursors = new MemoryCursors();
  const handled: NodeRemoteEvent[] = [];
  const refreshes: string[] = [];
  const statuses: string[] = [];
  const feed = new RemoteChangeFeed({
    remote: fake,
    scopeId: fake.scopeId,
    cursors,
    logger: createLogger('feed', silentSink),
    onEvent: over.onEvent ?? ((e) => { handled.push(e); return Promise.resolve(); }),
    onRefreshRequired: over.onRefresh ?? ((r) => { refreshes.push(r); return Promise.resolve(); }),
    onStatus: (s) => statuses.push(s),
    pollIntervalMs: 10,
    ...(over.silenceThresholdMs !== undefined ? { silenceThresholdMs: over.silenceThresholdMs } : {}),
    ...(over.now !== undefined ? { now: over.now } : {}),
    // A real (tiny) delay: an instant sleep would turn start() into a tight spin loop.
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
  });
  return { fake, cursors, feed, handled, refreshes, statuses };
}

describe('RemoteChangeFeed', () => {
  it('first poll without a cursor fast-forwards and stores the latest id without emitting node events', async () => {
    const { fake, cursors, feed, handled } = setup();
    fake.seedFolder(fake.rootUid, 'pre-existing');
    const r = await feed.poll();
    expect(r.events).toBe(0);
    expect(handled).toEqual([]);
    expect(cursors.map.get(fake.scopeId)).toBe(r.cursor);
    expect(feed.currentStatus).toBe('live');
  });

  it('replays events in order and persists the cursor after each handled event', async () => {
    const { fake, cursors, feed, handled } = setup();
    await feed.poll();
    const f = fake.seedFolder(fake.rootUid, 'F');
    const a = fake.seedFile(f.uid, 'a.txt', 'a');
    fake.seedRevision(a.uid, 'a2');
    const r = await feed.poll();
    expect(r.events).toBe(3);
    expect(handled.map((e) => `${e.type}:${e.nodeUid}`)).toEqual([`node_created:${f.uid}`, `node_created:${a.uid}`, `node_updated:${a.uid}`]);
    // One cursor write per event, strictly increasing.
    const ids = cursors.writes.slice(1).map(Number);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(cursors.writes).toHaveLength(4);
    // Idle poll: nothing new, cursor unchanged.
    const idle = await feed.poll();
    expect(idle.events).toBe(0);
    expect(cursors.map.get(fake.scopeId)).toBe(r.cursor);
  });

  it('does not advance the cursor past an event whose handler failed, so it is replayed next time', async () => {
    let fail = true;
    const seen: string[] = [];
    const { fake, cursors, feed } = setup({
      onEvent: (e) => {
        if (fail && e.type === 'node_created') {
          fail = false;
          return Promise.reject(new Error('handler crashed'));
        }
        seen.push(e.nodeUid);
        return Promise.resolve();
      },
    });
    await feed.poll();
    const before = cursors.map.get(fake.scopeId);
    const f = fake.seedFolder(fake.rootUid, 'F');
    await expect(feed.poll()).rejects.toThrow('handler crashed');
    expect(cursors.map.get(fake.scopeId)).toBe(before);
    const r = await feed.poll();
    expect(r.events).toBe(1);
    expect(seen).toEqual([f.uid]);
  });

  it('requests a full refresh when the stored cursor has expired, then continues from the new position', async () => {
    const { fake, cursors, feed, refreshes, handled } = setup();
    await feed.poll();
    fake.seedFolder(fake.rootUid, 'lost');
    fake.expireOldCursors();
    const r = await feed.poll();
    expect(r.refreshRequired).toBe(true);
    expect(refreshes).toEqual(['cursor expired or bulk change']);
    expect(handled).toEqual([]);
    expect(cursors.map.get(fake.scopeId)).toBe(r.cursor);
    const g = fake.seedFolder(fake.rootUid, 'after');
    const next = await feed.poll();
    expect(next.events).toBe(1);
    expect(handled[0]?.nodeUid).toBe(g.uid);
  });

  it('goes degraded on poll failures and requests a refresh once the stream has been silent too long', async () => {
    let t = 1_000_000;
    const { fake, feed, refreshes, statuses } = setup({ now: () => t, silenceThresholdMs: 5000 });
    await feed.poll();
    for (let i = 0; i < 6; i++) fake.injectFault('events', { kind: 'connection' });
    feed.start();
    // Let the loop run a few iterations while advancing the clock past the threshold.
    for (let i = 0; i < 6; i++) {
      t += 2000;
      await new Promise((r) => setTimeout(r, 5));
    }
    await feed.stop();
    expect(statuses).toContain('degraded');
    expect(refreshes).toContain('event stream silent too long');
    expect(refreshes.filter((r) => r === 'event stream silent too long')).toHaveLength(1);
    expect(feed.currentStatus).toBe('stopped');
  });
});

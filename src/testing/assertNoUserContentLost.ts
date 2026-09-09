/**
 * The core safety invariant, shared by the engine end-to-end suite and the
 * fault-injection suite: a byte of user content that was once the tool's
 * responsibility must never be destroyed. It may move, but it must always still
 * rest somewhere the user can recover it — locally, remotely, in the local
 * recycle bin, in remote trash, or in Proton's revision history.
 */
import { readFileSync } from 'node:fs';

import type { RecycleBin } from '../safety/recycle.js';
import type { FakeRemote } from './fakeRemote.js';

/** Every place a byte of user content can legitimately rest. */
export interface ContentWorld {
  localFiles(): Map<string, string>;
  remoteFiles(): Map<string, string>;
  recycledContents(): string[];
  remoteTrashedContents(): string[];
  supersededContents(): string[];
}

/** All content currently reachable somewhere the user can recover it. */
export function reachableContents(world: ContentWorld): Set<string> {
  return new Set<string>([
    ...world.localFiles().values(),
    ...world.remoteFiles().values(),
    ...world.recycledContents(),
    ...world.remoteTrashedContents(),
    ...world.supersededContents(),
  ]);
}

/**
 * Assert that no content in `expected` has been lost. A previously synced file
 * that has silently vanished — not on either side, not recycled, not trashed,
 * not a superseded revision — fails here.
 */
export function assertNoUserContentLost(expected: Iterable<string>, world: ContentWorld): void {
  const alive = reachableContents(world);
  const lost = [...expected].filter((c) => !alive.has(c));
  if (lost.length > 0) {
    const shown = lost.map((c) => JSON.stringify(c.length > 60 ? `${c.slice(0, 60)}…` : c)).join(', ');
    throw new Error(`user content lost (not local, remote, recycled, trashed, or a superseded revision): ${shown}`);
  }
}

/**
 * Build a {@link ContentWorld} from the raw parts a harness exposes (the local
 * and remote file maps, the fake remote, and — if the engine is running — the
 * recycle bin).
 */
export function contentWorld(parts: {
  localFiles: () => Map<string, string>;
  remoteFiles: () => Map<string, string>;
  fake: FakeRemote;
  recycle: RecycleBin | null;
}): ContentWorld {
  return {
    localFiles: parts.localFiles,
    remoteFiles: parts.remoteFiles,
    recycledContents: () =>
      (parts.recycle?.list() ?? [])
        .filter((i) => i.kind === 'file')
        .map((i) => readFileSync(i.absolutePath, 'utf8')),
    remoteTrashedContents: () =>
      parts.fake.trashedUids().flatMap((uid) => {
        const c = parts.fake.contentOf(uid);
        return c === undefined ? [] : [c.toString()];
      }),
    supersededContents: () => parts.fake.supersededContents(),
  };
}

import { describe, expect, it } from 'vitest';

import { assertNoUserContentLost, reachableContents, type ContentWorld } from './assertNoUserContentLost.js';

function world(over: Partial<ContentWorld>): ContentWorld {
  return {
    localFiles: () => new Map(),
    remoteFiles: () => new Map(),
    recycledContents: () => [],
    remoteTrashedContents: () => [],
    supersededContents: () => [],
    ...over,
  };
}

describe('assertNoUserContentLost', () => {
  it('passes when content still exists on a side', () => {
    const w = world({ localFiles: () => new Map([['a.txt', 'A']]) });
    expect(() => { assertNoUserContentLost(['A'], w); }).not.toThrow();
  });

  it('counts recycle, remote trash, and superseded revisions as still reachable', () => {
    const w = world({
      recycledContents: () => ['R'],
      remoteTrashedContents: () => ['T'],
      supersededContents: () => ['S'],
    });
    expect(reachableContents(w)).toEqual(new Set(['R', 'T', 'S']));
    expect(() => { assertNoUserContentLost(['R', 'T', 'S'], w); }).not.toThrow();
  });

  it('fails when a previously present file is dropped from every resting place', () => {
    const w = world({ remoteFiles: () => new Map([['keep.txt', 'KEEP']]) });
    expect(() => { assertNoUserContentLost(['KEEP', 'DROPPED'], w); }).toThrow(/user content lost.*DROPPED/s);
  });
});

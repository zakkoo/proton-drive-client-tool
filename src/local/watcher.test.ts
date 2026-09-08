import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, silentSink } from '../remote/proton/logger.js';
import { DigestCache } from './digest.js';
import { createIgnoreMatcher } from './ignore.js';
import { LocalWatcher, type LocalWatcherEvent } from './watcher.js';

let base: string;
let root: string;
let events: LocalWatcherEvent[];
let watcher: LocalWatcher | null;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'pds-watch-'));
  root = path.join(base, 'root');
  mkdirSync(root);
  events = [];
  watcher = null;
});
afterEach(async () => {
  await watcher?.stop();
  rmSync(base, { recursive: true, force: true });
});

async function startWatcher(): Promise<LocalWatcher> {
  const digests = new DigestCache(root);
  const known = new Map<string, string>();
  watcher = new LocalWatcher({
    root,
    ignore: createIgnoreMatcher(['**/*.tmp']),
    digests,
    previousDigest: (rel) => known.get(rel),
    logger: createLogger('w', silentSink),
    onEvent: async (e) => {
      events.push(e);
      if (e.type === 'changes') {
        for (const c of e.changes) {
          if ((c.type === 'created' || c.type === 'modified') && c.entry.kind === 'file') known.set(c.entry.relPath, await digests.digestOf(c.entry));
          if (c.type === 'moved') {
            const d = known.get(c.from);
            known.delete(c.from);
            if (d !== undefined) known.set(c.to, d);
          }
          if (c.type === 'deleted') known.delete(c.previous.relPath);
        }
      }
    },
    debounceMs: 150,
    settleMs: 60,
  });
  await watcher.start();
  events = []; // drop the startup snapshot event
  return watcher;
}

const changesSeen = () => events.flatMap((e) => (e.type === 'changes' ? e.changes : []));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settleAndFlush(w: LocalWatcher, ms = 400): Promise<void> {
  await wait(ms);
  await w.flush();
}

describe('LocalWatcher', () => {
  it('emits a single created change for a new file and a single modified change for a burst of writes', async () => {
    const w = await startWatcher();
    writeFileSync(path.join(root, 'new.txt'), 'hello');
    await settleAndFlush(w);
    expect(changesSeen().map((c) => c.type)).toEqual(['created']);
    events = [];
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(root, 'new.txt'), `burst ${String(i)} `.repeat(i + 1));
      await wait(10);
    }
    await settleAndFlush(w, 600);
    const types = changesSeen().map((c) => c.type);
    expect(types).toEqual(['modified']);
  });

  it('ignores files matching ignore patterns and its own internal directory', async () => {
    const w = await startWatcher();
    writeFileSync(path.join(root, 'scratch.tmp'), 'x');
    mkdirSync(path.join(root, '.proton-sync', 'tmp'), { recursive: true });
    writeFileSync(path.join(root, '.proton-sync', 'tmp', 'partial'), 'y');
    await settleAndFlush(w);
    expect(changesSeen()).toEqual([]);
  });

  it('picks up a folder moved into the root including files created before the watch existed', async () => {
    const w = await startWatcher();
    const staging = path.join(base, 'staging');
    mkdirSync(path.join(staging, 'nested', 'deeper'), { recursive: true });
    writeFileSync(path.join(staging, 'nested', 'a.txt'), 'a');
    writeFileSync(path.join(staging, 'nested', 'deeper', 'b.txt'), 'b');
    await wait(150); // let mtimes age past the settle window
    renameSync(staging, path.join(root, 'moved-in'));
    await settleAndFlush(w, 600);
    const created = changesSeen()
      .flatMap((c) => (c.type === 'created' ? [c.entry.relPath] : []))
      .sort();
    expect(created).toEqual(['moved-in', 'moved-in/nested', 'moved-in/nested/a.txt', 'moved-in/nested/deeper', 'moved-in/nested/deeper/b.txt']);
  });

  it('reports a rename as a move once the content is known', async () => {
    const w = await startWatcher();
    writeFileSync(path.join(root, 'orig.txt'), 'stable content');
    await settleAndFlush(w);
    expect(changesSeen().map((c) => c.type)).toEqual(['created']);
    events = [];
    renameSync(path.join(root, 'orig.txt'), path.join(root, 'renamed.txt'));
    await settleAndFlush(w);
    expect(changesSeen()).toHaveLength(1);
    expect(changesSeen()[0]).toMatchObject({ type: 'moved', from: 'orig.txt', to: 'renamed.txt', contentChanged: false });
  });

  it('emits one root_unavailable condition and zero deletes when the root disappears', async () => {
    const w = await startWatcher();
    writeFileSync(path.join(root, 'keep1.txt'), '1');
    writeFileSync(path.join(root, 'keep2.txt'), '2');
    await settleAndFlush(w);
    events = [];
    rmSync(root, { recursive: true, force: true });
    await wait(200);
    w.requestFullScan('test');
    await w.flush();
    const kinds = events.map((e) => e.type);
    expect(kinds.filter((k) => k === 'root_unavailable')).toHaveLength(1);
    expect(changesSeen().filter((c) => c.type === 'deleted')).toEqual([]);
    // A second scan while still gone does not repeat the condition.
    w.requestFullScan('again');
    await w.flush();
    expect(events.filter((e) => e.type === 'root_unavailable')).toHaveLength(1);
    mkdirSync(root);
  });
});

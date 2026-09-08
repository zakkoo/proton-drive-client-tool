import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecutorEvent } from './types.js';
import { tempDir } from './localWrite.js';
import { SyncHarness } from '../testing/harness.js';
import { sha1Hex } from '../testing/fakeRemote.js';

let h: SyncHarness;
let events: ExecutorEvent[];
beforeEach(() => {
  events = [];
  h = SyncHarness.create({ onEvent: (e) => events.push(e) });
});
afterEach(() => {
  h.dispose();
});

async function syncedStart(): Promise<void> {
  h.write('a.txt', 'A');
  h.write('docs/b.txt', 'B');
  h.fake.seedFile(h.remoteRootUid, 'r.txt', 'R');
  const plan = await h.settle();
  expect(plan.operations).toEqual([]);
  h.assertBaselineConsistent();
}

describe('Executor', () => {
  it('journals planned -> in_progress -> completed and updates the baseline only at completion', async () => {
    const seen: string[] = [];
    h.reopen({
      hooks: {
        beforeStep: (step, op) => {
          if (op.kind === 'upload') seen.push(`${step}:${String(h.baseline.byPath(op.relPath) !== null)}`);
        },
      },
    });
    h.write('new.txt', 'hello');
    const { plan, summary } = await h.cycle();
    expect(plan.operations.map((o) => o.kind)).toEqual(['upload']);
    expect(summary).toEqual({ completed: 1, skipped: 0, failed: 0, stoppedEarly: null });
    // No baseline row through act/verify/commit; row present only afterwards.
    expect(seen).toEqual(['journal_planned:false', 'precheck:false', 'journal_started:false', 'act:false', 'verify:false', 'commit:false', 'journal_completed:true']);
    const entries = h.journal.byStatus('completed');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attempt).toBe(1);
    expect(h.remoteFiles().get('new.txt')).toBe('hello');
    expect(h.baseline.byPath('new.txt')?.remoteSha1).toBe(sha1Hex('hello'));
    h.assertBaselineConsistent();
  });

  it('runs a full mixed plan: uploads, downloads, folder creation, moves, recycle and trash, and converges', async () => {
    await syncedStart();
    // Local: modify a, add c under new folder, delete docs/b (recycle), rename r -> renamed.
    h.write('a.txt', 'A2');
    h.write('new/c.txt', 'C');
    rmSync(path.join(h.root, 'docs'), { recursive: true });
    renameSync(path.join(h.root, 'r.txt'), path.join(h.root, 'renamed.txt'));
    // Remote: new file d, modify nothing else.
    h.fake.seedFile(h.remoteRootUid, 'd.txt', 'D');
    const plan = await h.settle();
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect([...h.localFiles().entries()].sort()).toEqual([...h.remoteFiles().entries()].sort());
    expect(h.remoteFiles().get('a.txt')).toBe('A2');
    expect(h.remoteFiles().has('renamed.txt')).toBe(true);
    expect(h.remoteFiles().has('r.txt')).toBe(false);
    expect(h.remoteTrashedContents()).toEqual(['B']);
    expect(h.localFiles().get('d.txt')).toBe('D');
    h.assertBaselineConsistent();
    // Every journal entry is terminal.
    expect(h.journal.unresolved()).toEqual([]);
  });

  it('leaves the baseline untouched and marks the entry failed when the remote call fails', async () => {
    h.reopen({ config: { maxRetries: 0 } });
    h.write('f.txt', 'F');
    h.fake.injectFault('upload', { kind: 'connection' });
    const { summary } = await h.cycle();
    expect(summary.failed).toBe(1);
    expect(h.baseline.byPath('f.txt')).toBeNull();
    expect(h.journal.byStatus('failed')).toHaveLength(1);
    expect(h.remoteFiles().has('f.txt')).toBe(false);
    // Next cycle replans and succeeds.
    const again = await h.cycle();
    expect(again.summary.completed).toBe(1);
    h.assertBaselineConsistent();
  });

  it('skips an operation whose local precondition changed since planning, and one whose remote revision changed', async () => {
    await syncedStart();
    h.write('a.txt', 'A2');
    const plan = await h.plan();
    expect(plan.operations.map((o) => o.kind)).toEqual(['upload']);
    // Change the file after planning.
    h.write('a.txt', 'A3');
    const { summary } = await h.execute(plan);
    expect(summary).toMatchObject({ skipped: 1, completed: 0 });
    expect(h.remoteFiles().get('a.txt')).toBe('A');
    expect(h.journal.byStatus('abandoned')[0]?.error).toMatch(/precondition/);
    // Remote side: plan a download, then the remote changes again before execution.
    const rUid = h.remotePathToUid('r.txt') ?? '';
    h.fake.seedRevision(rUid, 'R2');
    const plan2 = await h.plan();
    expect(plan2.operations.map((o) => o.kind).sort()).toEqual(['download', 'upload']);
    h.fake.seedRevision(rUid, 'R3');
    const res2 = await h.execute(plan2);
    expect(res2.summary.skipped).toBe(1);
    expect(h.localFiles().get('r.txt')).toBe('R');
    // The skipped item is replanned and the world converges.
    await h.settle();
    expect(h.localFiles().get('r.txt')).toBe('R3');
    h.assertBaselineConsistent();
  });

  it('atomic download: previous version recycled, temp dir empty, mtime taken from the remote claim', async () => {
    await syncedStart();
    const rUid = h.remotePathToUid('r.txt') ?? '';
    const when = new Date('2026-05-05T05:05:05Z');
    h.fake.seedRevision(rUid, 'R2', when);
    const { summary } = await h.cycle();
    expect(summary.completed).toBe(1);
    expect(h.localFiles().get('r.txt')).toBe('R2');
    expect(h.recycledContents()).toEqual(['R']);
    expect(readdirSync(tempDir(h.root))).toEqual([]);
    expect(statSync(path.join(h.root, 'r.txt')).mtime.toISOString()).toBe(when.toISOString());
    h.assertBaselineConsistent();
  });

  it('aborts the rename when the local target changed during the download, keeping the temp file out and the target as is', async () => {
    await syncedStart();
    const rUid = h.remotePathToUid('r.txt') ?? '';
    h.fake.seedRevision(rUid, 'R2');
    h.fake.beforeDownloadComplete = () => {
      writeFileSync(path.join(h.root, 'r.txt'), 'edited meanwhile');
      return Promise.resolve();
    };
    const { summary } = await h.cycle();
    expect(summary.failed).toBe(1);
    expect(h.localFiles().get('r.txt')).toBe('edited meanwhile');
    expect(readdirSync(tempDir(h.root))).toEqual([]);
    expect(h.recycledContents()).toEqual([]);
    expect(h.journal.byStatus('failed')[0]?.error).toMatch(/changed since planning/);
    h.fake.beforeDownloadComplete = undefined;
    // Re-reconcile: both sides changed -> conflict, no overwrite.
    const plan = await h.plan();
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['content']);
  });

  it('disk full pauses execution, removes the temp file and leaves the target untouched', async () => {
    await syncedStart();
    const rUid = h.remotePathToUid('r.txt') ?? '';
    h.fake.seedRevision(rUid, 'R2');
    h.fake.injectFault('download', { kind: 'enospc' });
    const { summary } = await h.cycle();
    expect(summary.stoppedEarly).toBe('disk_full');
    expect(events.some((e) => e.type === 'paused_for' && e.reason === 'disk_full')).toBe(true);
    expect(h.localFiles().get('r.txt')).toBe('R');
    expect(existsSync(tempDir(h.root)) ? readdirSync(tempDir(h.root)) : []).toEqual([]);
  });

  it('quarantines an item whose post-transfer verification fails', async () => {
    h.write('q.txt', 'Q');
    h.fake.injectFault('upload', { kind: 'mismatch_upload' });
    const { summary } = await h.cycle();
    expect(summary.failed).toBe(1);
    expect(h.quarantine.open().map((q) => `${q.relPath ?? ''}:${q.reason}`)).toEqual(['q.txt:verification_failed']);
    expect(h.baseline.byPath('q.txt')).toBeNull();
    // Quarantined: excluded from the next plan.
    const plan = await h.plan();
    expect(plan.operations).toEqual([]);
    expect(plan.blocked.map((b) => b.reason)).toEqual(['quarantined']);
  });

  it('retries a transient failure and, after an unknown outcome, re-reads the destination instead of uploading twice', async () => {
    h.write('u.txt', 'U');
    h.fake.injectFault('upload', { kind: 'unknown_outcome' });
    const { summary } = await h.cycle();
    expect(summary.completed).toBe(1);
    expect(h.fake.allNodes().filter((n) => n.name === 'u.txt')).toHaveLength(1);
    expect(h.fake.calls.filter((c) => c.op === 'upload')).toHaveLength(1);
    const entry = h.journal.byStatus('completed')[0];
    expect(entry?.outcome).toMatchObject({ landedBeforeRetry: true });
    h.assertBaselineConsistent();
    // A plain transient failure is retried and succeeds.
    h.write('v.txt', 'V');
    h.fake.injectFault('upload', { kind: 'connection' });
    const again = await h.cycle();
    expect(again.summary.completed).toBe(1);
    expect(h.journal.byStatus('completed').at(-1)?.attempt).toBe(2);
    expect(h.remoteFiles().get('v.txt')).toBe('V');
  });

  it('gives up into a failed state when the retry limit is exhausted', async () => {
    h.reopen({ config: { maxRetries: 1 } });
    h.write('w.txt', 'W');
    h.fake.injectFault('upload', { kind: 'connection' });
    h.fake.injectFault('upload', { kind: 'connection' });
    h.fake.injectFault('upload', { kind: 'connection' });
    const { summary } = await h.cycle();
    expect(summary.failed).toBe(1);
    expect(events.filter((e) => e.type === 'operation_failed' && e.retryable)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'operation_failed' && !e.retryable)).toHaveLength(1);
  });

  it('pause stops new operations at a boundary and leaves the journal consistent', async () => {
    for (let i = 0; i < 5; i++) h.write(`p${String(i)}.txt`, String(i));
    let executorRef: { pause(): void } | null = null;
    h.reopen({
      hooks: {
        beforeStep: (step, op) => {
          if (step === 'act' && op.kind === 'upload' && 'relPath' in op && op.relPath === 'p1.txt') executorRef?.pause();
        },
      },
    });
    const plan = await h.plan();
    expect(plan.operations).toHaveLength(5);
    const { Executor } = await import('./executor.js');
    const executor = new Executor(h.ctx);
    executorRef = executor;
    const summary = await executor.execute(plan);
    expect(summary.stoppedEarly).toBe('paused');
    expect(summary.completed).toBe(2); // p0 and p1 (in flight when pause was requested) finish
    expect(h.journal.unresolved()).toEqual([]);
    expect(h.remoteFiles().size).toBe(2);
  });

  it('cancel mid-download removes the temp file and leaves the target untouched', async () => {
    await syncedStart();
    const rUid = h.remotePathToUid('r.txt') ?? '';
    h.fake.seedRevision(rUid, 'R2');
    let executorRef: { cancelAll(): void } | null = null;
    h.fake.beforeDownloadComplete = () => {
      executorRef?.cancelAll();
      return Promise.resolve();
    };
    const plan = await h.plan();
    const { Executor } = await import('./executor.js');
    const executor = new Executor(h.ctx);
    executorRef = executor;
    const summary = await executor.execute(plan);
    expect(summary.failed + summary.skipped).toBeGreaterThanOrEqual(1);
    expect(h.localFiles().get('r.txt')).toBe('R');
    expect(readdirSync(tempDir(h.root))).toEqual([]);
    expect(h.journal.unresolved()).toEqual([]);
  });

  it('dry run changes nothing on either side and logs every operation as would_do', async () => {
    h.reopen({ config: { dryRun: true } });
    h.write('x.txt', 'X');
    h.fake.seedFile(h.remoteRootUid, 'y.txt', 'Y');
    const { plan, summary } = await h.cycle();
    expect(plan.operations).toHaveLength(2);
    expect(summary).toEqual({ completed: 0, skipped: 2, failed: 0, stoppedEarly: null });
    expect(h.remoteFiles().has('x.txt')).toBe(false);
    expect(h.localFiles().has('y.txt')).toBe(false);
    expect(h.baseline.count()).toBe(0);
    expect(h.journal.unresolved()).toEqual([]);
    const would = h.audit.readAll().entries.filter((e) => e.kind === 'would_do');
    expect(would.map((e) => e.op).sort()).toEqual(['download', 'upload']);
    expect(readFileSync(path.join(h.root, 'x.txt'), 'utf8')).toBe('X');
  });
});

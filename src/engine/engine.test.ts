import { rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineHarness } from '../testing/engineHarness.js';
import { ControlClient, ControlServer } from './control.js';

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  await h.dispose();
});

describe('SyncEngine', () => {
  it('starts, scans, syncs both directions through the watcher and the event feed, and rests idle', async () => {
    h.write('local.txt', 'L');
    h.fake.seedFile(h.remoteRootUid, 'remote.txt', 'R');
    await h.start();
    await h.waitForConvergence();
    expect(h.states().slice(0, 2)).toEqual(['scanning', 'syncing']);
    expect(h.states().at(-1)).toBe('idle');
    expect(h.localFiles().get('remote.txt')).toBe('R');
    expect(h.remoteFiles().get('local.txt')).toBe('L');
    // A live local change is picked up by the watcher.
    h.write('later.txt', 'later');
    await h.waitForConvergence();
    expect(h.remoteFiles().get('later.txt')).toBe('later');
    // A remote change arrives through the event feed.
    h.fake.seedFile(h.remoteRootUid, 'fromfeed.txt', 'F');
    await h.waitForConvergence();
    expect(h.localFiles().get('fromfeed.txt')).toBe('F');
    const status = h.bundle?.engine.getStatus();
    expect(status?.lastSuccessfulSyncAt).not.toBeNull();
    expect(status?.counts.baseline).toBe(4);
    expect(status?.progress).toBeNull();
  });

  it('counts finished file transfers in the run and drops the fraction when idle', async () => {
    h.fake.seedFile(h.remoteRootUid, 'a.txt', 'A');
    h.fake.seedFile(h.remoteRootUid, 'b.txt', 'B');
    h.fake.seedFile(h.remoteRootUid, 'c.txt', 'C');
    await h.start();
    await h.waitForConvergence();
    const during = h.statuses.filter((s) => s.state === 'syncing' && s.progress !== null);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((s) => s.progress?.total === 3)).toBe(true);
    const dones = during.map((s) => s.progress?.done ?? 0);
    expect(Math.max(...dones)).toBeGreaterThan(Math.min(...dones));
    const climbed = during.find((s) => s.progress?.done === 1);
    expect(climbed?.pending.downloads).toBe(3);
    expect(h.bundle?.engine.getStatus().state).toBe('idle');
    expect(h.bundle?.engine.getStatus().progress).toBeNull();
  });

  it('records files copied by a finished check, and a failed check keeps that record', async () => {
    h.fake.seedFile(h.remoteRootUid, 'a.txt', 'A');
    await h.start();
    await h.waitForConvergence();
    expect(h.statuses.some((s) => s.lastRunFilesCopied === 1)).toBe(true);

    const before = h.live.engine.getStatus();
    expect(before.lastFullSyncAt).not.toBeNull();
    await h.live.engine.syncNow();
    await h.waitFor(['idle']);
    const empty = h.live.engine.getStatus();
    expect(empty.lastRunFilesCopied).toBe(0);
    expect(empty.summaryLines).toContainEqual(expect.stringContaining('no files copied'));
    expect(empty.lastFullSyncAt).toBe(before.lastFullSyncAt);
    const keptAt = empty.lastSuccessfulSyncAt;
    expect(keptAt).not.toBeNull();

    // A check that wants to upload, but cannot, must not replace the last finished check.
    h.live.engine.pause();
    await h.waitFor(['paused']);
    h.fake.seedPermanentDelete(h.remoteRootUid);
    h.write('bad.txt', 'B');
    const started = Date.now();
    while (Date.now() - started < 3000 && h.live.engine.getStatus().counts.localFiles < 2) await new Promise((r) => setTimeout(r, 30));
    expect(h.live.engine.getStatus().counts.localFiles).toBeGreaterThanOrEqual(2);
    h.live.engine.resume();
    await h.waitFor(['error']);
    const failed = h.live.engine.getStatus();
    expect(failed.lastSuccessfulSyncAt).toBe(keptAt);
    expect(failed.lastRunFilesCopied).toBe(0);
    expect(failed.lastFullSyncAt).toBe(before.lastFullSyncAt);
  });

  it('splits paired files, Proton documents, and files that exist on only one side', async () => {
    h.write('keep.txt', 'K');
    h.write('gone.txt', 'G');
    await h.start();
    await h.waitForConvergence();
    h.live.engine.pause();
    await h.waitFor(['paused']);

    unlinkSync(path.join(h.root, 'gone.txt'));
    h.write('only-local.txt', 'L');
    h.fake.seedFile(h.remoteRootUid, 'extra.txt', 'E');
    h.fake.seedProtonDocument(h.remoteRootUid, 'Agenda');

    const start = Date.now();
    let status = h.live.engine.getStatus();
    while (Date.now() - start < 5000) {
      status = h.live.engine.getStatus();
      const c = status.counts;
      if (c.localFiles === 2 && c.remoteFiles === 4 && c.protonDocuments === 1 && c.onlyLocal === 1 && c.onlyRemote === 1) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(status.counts).toMatchObject({
      localFiles: 2,
      remoteFiles: 4,
      pairedFiles: 2,
      protonDocuments: 1,
      onlyLocal: 1,
      onlyRemote: 1,
    });
    expect(status.protonDocumentPaths).toEqual(['Agenda']);
    expect(status.summaryLines).toEqual(expect.arrayContaining([
      'Files: 2 on this computer, 4 on Proton, 2 in sync',
      'Only on this computer: 1 file',
      'Only on Proton: 1 file',
      'Proton documents: 1 on Proton only (Docs and Sheets stay in the browser)',
    ]));
  });

  it('pause stops syncing and resume picks up the backlog; startPaused starts paused', async () => {
    await h.start();
    await h.waitFor(['idle']);
    h.bundle?.engine.pause();
    await h.waitFor(['paused']);
    h.write('while-paused.txt', 'P');
    await new Promise((r) => setTimeout(r, 400));
    expect(h.remoteFiles().has('while-paused.txt')).toBe(false);
    h.bundle?.engine.resume();
    await h.waitForConvergence();
    expect(h.remoteFiles().get('while-paused.txt')).toBe('P');

    const paused = EngineHarness.create({ startPaused: true });
    try {
      await paused.start();
      expect(paused.bundle?.engine.getStatus().state).toBe('paused');
    } finally {
      await paused.dispose();
    }
  });

  it('holds a mass deletion for confirmation, keeps syncing unaffected items, and runs it after confirm', async () => {
    for (let i = 0; i < 10; i++) h.write(`f${String(i)}.txt`, String(i));
    h.config = { ...h.config, safety: { ...h.config.safety, brakeMaxChanges: 3 } };
    await h.start();
    await h.waitForConvergence();
    for (let i = 0; i < 6; i++) await h.fake.trash([h.remotePathToUid(`f${String(i)}.txt`) ?? '']);
    h.write('unaffected.txt', 'U');
    const status = await h.waitFor(['awaiting_confirmation']);
    expect(status.attention.heldPlan?.affected).toHaveLength(6);
    // Unaffected upload runs even though the deletes are held.
    for (let i = 0; i < 100 && !h.remoteFiles().has('unaffected.txt'); i++) await new Promise((r) => setTimeout(r, 30));
    expect(h.remoteFiles().get('unaffected.txt')).toBe('U');
    expect(h.localFiles().has('f0.txt')).toBe(true);
    const id = status.attention.heldPlan?.id ?? '';
    await h.bundle?.engine.confirmHeldPlan(id);
    await h.waitForConvergence();
    expect(h.localFiles().has('f0.txt')).toBe(false);
    expect(h.bundle?.recycle.list().filter((r) => r.kind === 'file')).toHaveLength(6);
  });

  it('rejecting a held plan discards it and the engine returns to rest', async () => {
    for (let i = 0; i < 6; i++) h.write(`g${String(i)}.txt`, String(i));
    h.config = { ...h.config, safety: { ...h.config.safety, brakeMaxChanges: 2 } };
    await h.start();
    await h.waitForConvergence();
    for (let i = 0; i < 4; i++) await h.fake.trash([h.remotePathToUid(`g${String(i)}.txt`) ?? '']);
    const status = await h.waitFor(['awaiting_confirmation']);
    const affected = h.bundle?.engine.rejectHeldPlan(status.attention.heldPlan?.id ?? '') ?? [];
    expect(affected).toHaveLength(4);
    expect(h.localFiles().size).toBe(6);
    expect(['idle', 'attention', 'scanning', 'awaiting_confirmation']).toContain(h.bundle?.engine.getStatus().state);
  });

  it('surfaces conflicts as attention, resolves them through the engine, and returns to idle', async () => {
    h.write('doc.md', 'base');
    await h.start();
    await h.waitForConvergence();
    h.bundle?.engine.pause();
    await h.waitFor(['paused']);
    h.write('doc.md', 'local');
    h.fake.seedRevision(h.remotePathToUid('doc.md') ?? '', 'remote');
    h.bundle?.engine.resume();
    const status = await h.waitFor(['attention']);
    expect(status.attention.conflicts).toBe(1);
    const conflicts = h.bundle?.controlTarget.listConflicts() ?? [];
    expect(conflicts[0]?.kind).toBe('content');
    await h.waitForConvergence();
    expect(h.localFiles().size).toBe(2);
    await h.bundle?.engine.resolveConflict(conflicts[0]?.id ?? 0, 'keep_both');
    await h.waitFor(['idle']);
    expect(h.bundle?.controlTarget.listConflicts()).toEqual([]);
  });

  it('quarantines a verification failure and re-reconciles after release', async () => {
    await h.start();
    await h.waitFor(['idle']);
    h.fake.injectFault('upload', { kind: 'mismatch_upload' });
    h.write('bad.txt', 'B');
    const status = await h.waitFor(['attention']);
    expect(status.attention.quarantined).toBe(1);
    const q = h.bundle?.controlTarget.listQuarantine()[0];
    h.bundle?.engine.releaseQuarantine(q?.id ?? 0);
    await h.waitForConvergence();
    expect(h.remoteFiles().get('bad.txt')).toBe('B');
  });

  it('enters error when the sync root disappears and never deletes anything', async () => {
    h.write('keep.txt', 'K');
    await h.start();
    await h.waitForConvergence();
    rmSync(h.root, { recursive: true, force: true });
    h.fake.seedFile(h.remoteRootUid, 'poke.txt', 'poke'); // triggers a cycle via the feed
    const status = await h.waitFor(['error']);
    expect(status.reason).toMatch(/sync root/i);
    expect(h.fake.trashedUids()).toEqual([]);
    expect(h.remoteFiles().get('keep.txt')).toBe('K');
  });

  it('goes offline when the remote is unreachable during a listing and recovers', async () => {
    await h.start();
    await h.waitFor(['idle']);
    h.fake.injectFault('list', { kind: 'connection' });
    await h.bundle?.engine.onRemoteRefreshRequired('test');
    expect(h.bundle?.engine.getStatus().state).toBe('offline');
    await h.bundle?.engine.onRemoteRefreshRequired('test again');
    await h.waitFor(['idle']);
  });

  it('survives a restart with a pending change', async () => {
    h.write('a.txt', 'A');
    await h.start();
    await h.waitForConvergence();
    await h.bundle?.engine.stop();
    expect(h.bundle?.engine.getStatus().state).toBe('stopped');
    h.write('b.txt', 'B');
    await h.restart();
    await h.waitForConvergence();
    expect(h.remoteFiles().get('b.txt')).toBe('B');
  });
});

describe('control socket', () => {
  it('drives the engine entirely over the socket and pushes status events', async () => {
    h.write('x.txt', 'X');
    await h.start();
    await h.waitForConvergence();
    const socketPath = h.paths.controlSocket;
    const server = new ControlServer(socketPath, h.bundle?.controlTarget ?? (null as never));
    await server.listen();
    const client = new ControlClient(socketPath);
    const pushed: string[] = [];
    client.onStatus((s) => pushed.push(s.state));
    try {
      await client.connect();
      const status = await client.request<{ state: string }>({ cmd: 'status' });
      expect(status.state).toBe('idle');
      expect(await client.request<{ state: string }>({ cmd: 'pause' })).toMatchObject({ state: 'paused' });
      h.write('y.txt', 'Y');
      await new Promise((r) => setTimeout(r, 300));
      expect(h.remoteFiles().has('y.txt')).toBe(false);
      expect((await client.request<{ state: string }>({ cmd: 'resume' })).state).not.toBe('paused');
      await client.request({ cmd: 'sync_now' });
      await h.waitForConvergence();
      expect(h.remoteFiles().get('y.txt')).toBe('Y');
      expect(await client.request({ cmd: 'conflicts' })).toEqual([]);
      expect(await client.request({ cmd: 'quarantine' })).toEqual([]);
      expect(await client.request({ cmd: 'recycle' })).toEqual([]);
      await expect(client.request({ cmd: 'resolve', args: { id: 1, choice: 'nope' as never } })).rejects.toThrow(/choice must be/);
      await expect(client.request({ cmd: 'confirm', args: { id: 'held-99' } })).rejects.toThrow(/No held plan/);
      expect(pushed.length).toBeGreaterThan(0);
      expect(await ControlClient.probe(socketPath)).toBe(true);
      // A second server on the same live socket is refused.
      await expect(new ControlServer(socketPath, h.bundle?.controlTarget ?? (null as never)).listen()).rejects.toThrow(/Another instance/);
      expect(await client.request({ cmd: 'quit' })).toEqual({ quitting: true });
      await h.waitFor(['stopped']);
    } finally {
      client.close();
      await server.close();
    }
    expect(await ControlClient.probe(socketPath)).toBe(false);
  });
});

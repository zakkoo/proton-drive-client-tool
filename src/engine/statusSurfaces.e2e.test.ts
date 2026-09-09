import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatStatus } from '../cli/output.js';
import { buildTrayModel, dispatchMenuAction, indexMenu, type MenuAction } from '../tray/menuModel.js';
import { EngineHarness } from '../testing/engineHarness.js';
import { summarize } from './status.js';

/**
 * Status surfaces show the live engine snapshot (spec: tray-status-ui / shared
 * live snapshot). After a real sync the counts and last-sync time are present;
 * during a transfer the in-flight work is visible; and the tray Pause action
 * actually pauses the engine.
 */

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  await h.dispose();
});

function trayAction(type: MenuAction['type']): MenuAction {
  const t = h.live.controlTarget;
  const model = buildTrayModel(t.getStatus(), t.listConflicts(), t.listQuarantine());
  const item = [...indexMenu(model.menu).values()].find((i) => i.action?.type === type);
  if (item?.action === undefined) throw new Error(`no tray item for ${type}`);
  return item.action;
}

describe('status surfaces', () => {
  it('after a successful sync, status and the summary show last sync and non-empty file counts', async () => {
    h.write('a.txt', 'A');
    h.write('b.txt', 'B');
    await h.start();
    await h.waitForConvergence();

    // The remote count catches up as the event feed reflects our own uploads (sub-second); at rest
    // it must not be stuck at zero while two files exist remotely.
    let status = h.live.engine.getStatus();
    for (let i = 0; i < 100 && status.counts.remoteFiles !== 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = h.live.engine.getStatus();
    }
    expect(status.counts.baseline).toBe(2);
    expect(status.counts.localFiles).toBe(2);
    expect(status.counts.remoteFiles, 'remote count reflects the two synced files').toBe(2);
    expect(status.lastSuccessfulSyncAt, 'a last-successful-sync time is recorded').not.toBeNull();

    // summarize() (tray tooltip / CLI) is not empty of counts when files exist.
    const lines = summarize(status);
    expect(lines.some((l) => l.includes('Files: 2 local, 2 remote (2 synced)')), lines.join(' | ')).toBe(true);
    expect(lines.some((l) => l.includes('Last full sync'))).toBe(true);
    // The human CLI status shows the same.
    expect(formatStatus(status).some((l) => l.includes('Files: 2 local'))).toBe(true);
  });

  it('during a slowed transfer, the engine status and the formatter show the in-flight transfer and non-zero pending', async () => {
    // Slow the download so several progress snapshots are emitted while it is in flight.
    h.fake.beforeDownloadComplete = () => new Promise<void>((r) => setTimeout(r, 300));
    h.fake.seedFile(h.remoteRootUid, 'big.txt', 'X'.repeat(200_000));
    await h.start();
    await h.waitForConvergence(15_000);

    // The recorded status stream captured the transfer in flight, with non-zero pending.
    const inFlight = h.statuses.find((s) => s.transfers.some((t) => t.relPath === 'big.txt'));
    if (inFlight === undefined) throw new Error('no status was emitted with the download in flight');
    const transfer = inFlight.transfers.find((t) => t.relPath === 'big.txt');
    expect(transfer?.kind).toBe('download');
    expect(inFlight.pending.uploads + inFlight.pending.downloads + inFlight.pending.other, 'pending is non-zero during the cycle').toBeGreaterThan(0);
    // The formatter renders that in-flight snapshot with the transfer line.
    expect(formatStatus(inFlight).some((l) => l.includes('big.txt'))).toBe(true);
    expect(h.localFiles().get('big.txt')).toBe('X'.repeat(200_000));
  });

  it('the tray Pause action pauses the engine, and nothing uploads until Resume', async () => {
    await h.start();
    await h.waitFor(['idle']);

    await dispatchMenuAction(trayAction('pause'), h.live.controlTarget);
    await h.waitFor(['paused']);
    expect(h.live.engine.getStatus().state).toBe('paused');

    // A new local file is not uploaded while paused.
    h.write('while-paused.txt', 'P');
    await new Promise((r) => setTimeout(r, 400));
    expect(h.remoteFiles().has('while-paused.txt'), 'no upload while paused').toBe(false);
    expect(h.live.engine.getStatus().state).toBe('paused');

    // Resume from the tray -> the backlog uploads.
    await dispatchMenuAction(trayAction('resume'), h.live.controlTarget);
    await h.waitForConvergence();
    expect(h.remoteFiles().get('while-paused.txt')).toBe('P');
  });
});

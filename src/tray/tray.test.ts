import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initialStatus, type EngineStatus } from '../engine/status.js';
import type { ConflictEntry, QuarantineEntry } from '../state/misc.ts';
import { EngineHarness } from '../testing/engineHarness.js';
import { DetailPageServer } from './detailPage.js';
import { buildTrayModel, indexMenu, type MenuItem } from './menuModel.js';
import { initialTracker, notificationsFor } from './notify.js';
import { menuOnAboutToShow } from './sni.js';
import { startTray } from './index.js';

function status(over: Partial<EngineStatus>): EngineStatus {
  const s = { ...initialStatus(false, 1), ...over };
  return { ...s, summaryLines: s.summaryLines.length === 1 && s.summaryLines[0] === 'Starting' ? [s.state] : s.summaryLines };
}

const labels = (items: MenuItem[]): string[] => items.filter((i) => i.separator !== true).map((i) => i.label);

describe('tray menu model', () => {
  it('maps every engine state to an icon and an SNI status', () => {
    const states: EngineStatus['state'][] = ['starting', 'idle', 'scanning', 'syncing', 'paused', 'offline', 'throttled', 'attention', 'awaiting_confirmation', 'error', 'needs_login', 'stopped'];
    const icons = new Set<string>();
    for (const state of states) {
      const m = buildTrayModel(status({ state }), [], []);
      expect(m.iconName.length).toBeGreaterThan(0);
      icons.add(m.iconName);
      expect(m.sniStatus).toBe(['attention', 'awaiting_confirmation', 'error', 'needs_login'].includes(state) ? 'NeedsAttention' : 'Active');
    }
    expect(icons.size).toBeGreaterThanOrEqual(6);
  });

  it('offers pause or resume depending on state, and the standard actions', () => {
    const idle = buildTrayModel(status({ state: 'idle' }), [], []);
    expect(labels(idle.menu)).toEqual(expect.arrayContaining(['Pause syncing', 'Sync now', 'Open details page', 'Open sync folder', 'Open recycle folder', 'Open audit log', 'Settings…', 'Quit']));
    expect(labels(idle.menu)).not.toContain('Resume syncing');
    const paused = buildTrayModel(status({ state: 'paused' }), [], []);
    expect(labels(paused.menu)).toContain('Resume syncing');
    const syncNow = paused.menu.find((i) => i.label === 'Sync now');
    expect(syncNow?.enabled).toBe(false);
  });

  it('lists the held plan with its affected items and proceed/reject, conflicts with three resolutions, and quarantine releases', () => {
    const conflicts: ConflictEntry[] = [
      { id: 7, relPath: 'doc.md', nodeUid: 'n', kind: 'content', local: {}, remote: {}, createdAt: 1, resolvedAt: null, resolution: null },
      { id: 8, relPath: 'gone.txt', nodeUid: 'n2', kind: 'delete_vs_edit', local: {}, remote: {}, createdAt: 1, resolvedAt: null, resolution: null },
    ];
    const quarantine: QuarantineEntry[] = [{ id: 3, relPath: 'bad.bin', nodeUid: null, reason: 'digest_mismatch', details: null, createdAt: 1, releasedAt: null }];
    const s = status({ state: 'awaiting_confirmation', attention: { conflicts: 2, quarantined: 1, heldPlan: { id: 'held-1', reason: '6 deletions exceed the limit of 3', affected: ['recycle_local a', 'recycle_local b'] } } });
    const m = buildTrayModel(s, conflicts, quarantine);
    const held = m.menu.find((i) => i.label.startsWith('Held plan'));
    expect(held?.children?.map((c) => c.label)).toEqual(expect.arrayContaining(['6 deletions exceed the limit of 3', 'recycle_local a', 'recycle_local b', 'Proceed with these changes', 'Reject and keep everything']));
    expect(held?.children?.find((c) => c.label === 'Proceed with these changes')?.action).toEqual({ type: 'confirm_held', id: 'held-1' });
    const conf = m.menu.find((i) => i.label === 'Conflicts (2)');
    const doc = conf?.children?.find((c) => c.label.startsWith('doc.md'));
    expect(doc?.children?.map((c) => c.action)).toEqual([
      { type: 'resolve_conflict', id: 7, choice: 'keep_local' },
      { type: 'resolve_conflict', id: 7, choice: 'keep_remote' },
      { type: 'resolve_conflict', id: 7, choice: 'keep_both' },
    ]);
    const gone = conf?.children?.find((c) => c.label.startsWith('gone.txt'));
    expect(gone?.children?.filter((c) => c.enabled).map((c) => c.label)).toEqual(['Keep both']);
    const q = m.menu.find((i) => i.label === 'Quarantine (1)');
    expect(q?.children?.[0]?.children?.[0]?.action).toEqual({ type: 'release_quarantine', id: 3 });
    // Every id is unique across the tree.
    const ids = [...indexMenu(m.menu).keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows the live file-run line and drops it once the run is idle', () => {
    const syncing = buildTrayModel(status({
      state: 'syncing',
      progress: { done: 34, total: 5685 },
      summaryLines: [
        'Sync (34/5685)',
        'Pending: 0 up, 5685 down, 0 other',
        'Last sync: 2026-09-22T17:42:23.000Z, 2 files copied',
        'Files: 30617 on this computer, 30624 on Proton, 30617 in sync',
        'Proton documents: 7 on Proton only (Docs and Sheets stay in the browser)',
        'Notes/Agenda',
      ],
    }), [], []);
    expect(labels(syncing.menu)[0]).toBe('Sync (34/5685)');
    expect(syncing.tooltip.description).toBe('Sync (34/5685)');
    expect(labels(syncing.menu)).toContain('Files: 30617 on this computer, 30624 on Proton, 30617 in sync');
    expect(labels(syncing.menu).some((label) => label.includes('Pending:'))).toBe(false);
    expect(labels(syncing.menu)).not.toContain('Notes/Agenda');
    const idle = buildTrayModel(status({
      state: 'idle',
      progress: null,
      summaryLines: [
        'In sync',
        'Last sync: 2026-09-22T17:42:23.000Z, 12 files copied',
        'Files: 30617 on this computer, 30624 on Proton, 30617 in sync',
        'Folders: 534 in sync',
        'Proton documents: 7 on Proton only (Docs and Sheets stay in the browser)',
      ],
    }), [], []);
    expect(labels(idle.menu)[0]).toBe('In sync');
    expect(labels(idle.menu)).toContain('Last sync: 2026-09-22T17:42:23.000Z, 12 files copied');
    expect(labels(idle.menu).join(' ')).not.toContain('34/5685');
    expect(labels(idle.menu).join(' ')).not.toContain('Sync (');
    expect(idle.tooltip.description).toContain('12 files copied');
    expect(idle.tooltip.description).toContain('Files:');
    expect(idle.tooltip.description).not.toContain('Sync (');
    for (const label of ['Last sync: 2026-09-22T17:42:23.000Z, 12 files copied', 'Files: 30617 on this computer, 30624 on Proton, 30617 in sync', 'Folders: 534 in sync']) {
      expect(idle.menu.find((item) => item.label === label)?.enabled).toBe(false);
    }
  });

  it('rebuilds the open menu from the current snapshot', () => {
    let live = 'Sync (34/5685)';
    let shown = '';
    expect(menuOnAboutToShow(() => [{ id: 1, label: live, enabled: false }], (items) => {
      shown = items[0]?.label ?? '';
    })).toBe(true);
    expect(shown).toBe('Sync (34/5685)');
    live = 'In sync';
    menuOnAboutToShow(() => [{ id: 1, label: live, enabled: false }], (items) => {
      shown = items[0]?.label ?? '';
    });
    expect(shown).toBe('In sync');
  });
});

describe('notifications', () => {
  it('notify only on new conflicts, new quarantine, a new held plan, login required and errors; never on routine states', () => {
    let tracker = initialTracker(status({ state: 'idle' }));
    const step = (s: EngineStatus): string[] => {
      const r = notificationsFor(tracker, s);
      tracker = r.next;
      return r.notifications.map((n) => n.summary);
    };
    expect(step(status({ state: 'scanning' }))).toEqual([]);
    expect(step(status({ state: 'syncing' }))).toEqual([]);
    expect(step(status({ state: 'idle' }))).toEqual([]);
    expect(step(status({ state: 'attention', attention: { conflicts: 1, quarantined: 0, heldPlan: null } }))).toEqual(['Sync conflict']);
    expect(step(status({ state: 'attention', attention: { conflicts: 1, quarantined: 0, heldPlan: null } }))).toEqual([]); // same conflict again: no repeat
    expect(step(status({ state: 'attention', attention: { conflicts: 1, quarantined: 2, heldPlan: null } }))).toEqual(['2 items quarantined']);
    expect(step(status({ state: 'awaiting_confirmation', attention: { conflicts: 1, quarantined: 2, heldPlan: { id: 'h1', reason: 'too many', affected: [] } } }))).toEqual(['Confirmation required']);
    expect(step(status({ state: 'awaiting_confirmation', attention: { conflicts: 1, quarantined: 2, heldPlan: { id: 'h1', reason: 'too many', affected: [] } } }))).toEqual([]);
    expect(step(status({ state: 'needs_login', attention: { conflicts: 1, quarantined: 2, heldPlan: null } }))).toEqual(['Login required']);
    expect(step(status({ state: 'error', reason: 'disk full', attention: { conflicts: 1, quarantined: 2, heldPlan: null } }))).toEqual(['Sync stopped']);
    expect(step(status({ state: 'paused', attention: { conflicts: 0, quarantined: 0, heldPlan: null } }))).toEqual([]);
  });
});

describe('detail page and tray lifecycle', () => {
  let h: EngineHarness;
  beforeEach(() => {
    h = EngineHarness.create();
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('serves the page and state behind a token, performs actions, and rejects unknown tokens', async () => {
    h.write('doc.md', 'base');
    await h.start();
    await h.waitForConvergence();
    const bundle = h.bundle;
    if (bundle === null) throw new Error('engine not started');
    const target = bundle.controlTarget;
    const page = new DetailPageServer(target);
    await page.listen();
    try {
      const html = await fetch(page.url);
      expect(html.status).toBe(200);
      expect(await html.text()).toContain('Proton Drive Sync');
      const state = (await (await fetch(`${page.url}api/state`)).json()) as { status: EngineStatus; conflicts: unknown[]; quarantine: unknown[] };
      expect(state.status.state).toBe('idle');
      expect(state.conflicts).toEqual([]);
      const bad = await fetch(`http://127.0.0.1:${new URL(page.url).port}/wrongtoken/api/state`);
      expect(bad.status).toBe(404);
      const paused = (await (await fetch(`${page.url}api/pause`, { method: 'POST' })).json()) as { ok: boolean; status: EngineStatus };
      expect(paused.ok).toBe(true);
      await h.waitFor(['paused']);
      // Create a conflict while paused, then resolve it from the page.
      h.write('doc.md', 'local');
      h.fake.seedRevision(h.remotePathToUid('doc.md') ?? '', 'remote');
      await fetch(`${page.url}api/resume`, { method: 'POST' });
      await h.waitFor(['attention']);
      await h.waitForConvergence();
      const withConflict = (await (await fetch(`${page.url}api/state`)).json()) as { conflicts: { id: number }[] };
      expect(withConflict.conflicts).toHaveLength(1);
      const resolved = await fetch(`${page.url}api/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: withConflict.conflicts[0]?.id, choice: 'keep_both' }) });
      expect(resolved.status).toBe(200);
      await h.waitFor(['idle']);
      expect(((await (await fetch(`${page.url}api/state`)).json()) as { conflicts: unknown[] }).conflicts).toEqual([]);
      const invalid = await fetch(`${page.url}api/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, choice: 'nope' }) });
      expect(invalid.status).toBe(400);
    } finally {
      await page.close();
    }
  });

  it('startTray rejects when no session bus is reachable, and the engine keeps running', async () => {
    await h.start();
    await h.waitFor(['idle']);
    const bundle = h.bundle;
    if (bundle === null) throw new Error('engine not started');
    await expect(
      startTray({
        engine: bundle.engine,
        controlTarget: bundle.controlTarget,
        config: h.config,
        paths: h.paths,
        audit: h.audit,
        logSink: () => undefined,
        detailUrl: 'http://127.0.0.1:9/token/',
        busAddress: 'unix:path=/nonexistent/dbus-socket-for-tests',
        sniTimeoutMs: 1500,
      }),
    ).rejects.toThrow(/no tray host available/);
    // The engine is unaffected.
    h.write('after.txt', 'A');
    await h.waitForConvergence();
    expect(h.remoteFiles().get('after.txt')).toBe('A');
    expect(h.bundle?.engine.getStatus().state).toBe('idle');
  });
});

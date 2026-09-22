import { describe, expect, it } from 'vitest';

import { allTransitions, canTransition, glanceText, initialStatus, summarize, type EngineState, type LibraryCounts } from './status.js';

const STATES: EngineState[] = ['starting', 'idle', 'scanning', 'syncing', 'paused', 'offline', 'throttled', 'attention', 'awaiting_confirmation', 'error', 'needs_login', 'stopped'];

function counts(over: Partial<LibraryCounts> = {}): LibraryCounts {
  return {
    baseline: 0,
    localFiles: 0,
    remoteFiles: 0,
    pairedFiles: 0,
    pairedFolders: 0,
    protonDocuments: 0,
    onlyLocal: 0,
    onlyRemote: 0,
    ...over,
  };
}

describe('engine state machine', () => {
  it('every state is reachable and stopped is terminal', () => {
    const reachable = new Set(allTransitions().map((t) => t.to));
    for (const s of STATES) if (s !== 'starting') expect(reachable.has(s), s).toBe(true);
    for (const s of STATES) expect(canTransition('stopped', s)).toBe(s === 'stopped');
  });

  it('every state can stop, and every non-terminal state can reach paused or error', () => {
    for (const s of STATES) {
      if (s === 'stopped') continue;
      expect(canTransition(s, 'stopped'), `${s} -> stopped`).toBe(true);
      expect(canTransition(s, 'paused') || canTransition(s, 'error'), `${s} -> paused|error`).toBe(true);
    }
  });

  it('forbids going back to starting and skipping the scan before syncing from paused', () => {
    for (const s of STATES) if (s !== 'starting') expect(canTransition(s, 'starting')).toBe(false);
    expect(canTransition('paused', 'syncing')).toBe(false);
    expect(canTransition('needs_login', 'syncing')).toBe(false);
    expect(canTransition('error', 'syncing')).toBe(false);
  });

  it('starts with empty clocks and library counts', () => {
    const s = initialStatus(false, 1);
    expect(s.lastSuccessfulSyncAt).toBeNull();
    expect(s.lastRunFilesCopied).toBeNull();
    expect(s.lastFullSyncAt).toBeNull();
    expect(s.protonDocumentPaths).toEqual([]);
    expect(s.counts).toEqual(counts());
    expect(s.counts.baseline).toBe(s.counts.pairedFiles + s.counts.pairedFolders);
  });

  it('summarises status for the tray tooltip', () => {
    const s = initialStatus(true, 1);
    const lines = summarize({
      ...s,
      state: 'attention',
      reason: null,
      degraded: true,
      pending: { uploads: 2, downloads: 1, other: 0 },
      attention: { conflicts: 1, quarantined: 2, heldPlan: { id: 'held-1', reason: 'too many deletes', affected: [] } },
      lastSuccessfulSyncAt: Date.UTC(2026, 0, 1),
      lastRunFilesCopied: 0,
      lastFullSyncAt: Date.UTC(2025, 11, 1),
    });
    expect(lines[0]).toBe('Needs attention');
    expect(lines).toContain('DRY RUN: no changes are made');
    expect(lines).toContain('Event stream degraded; using periodic listings');
    expect(lines).toContain('Pending: 2 up, 1 down, 0 other');
    expect(lines).toContain('1 conflict(s) to resolve');
    expect(lines).toContain('2 quarantined item(s)');
    expect(lines).toContain('Held plan: too many deletes');
    expect(lines).toContain('Last sync: 2026-01-01T00:00:00.000Z, no files copied');
    expect(lines).toContain('Last full sync: 2025-12-01T00:00:00.000Z');
    expect(lines.join(' ')).not.toContain('synced)');
  });

  it('describes the library without adding folders into the file total', () => {
    const base = initialStatus(false, 1);
    const lines = summarize({
      ...base,
      state: 'idle',
      lastSuccessfulSyncAt: Date.UTC(2026, 8, 22, 17, 42, 23),
      lastRunFilesCopied: 2,
      lastFullSyncAt: Date.UTC(2026, 8, 22, 16, 28, 3),
      counts: counts({
        baseline: 31151,
        localFiles: 30617,
        remoteFiles: 30624,
        pairedFiles: 30617,
        pairedFolders: 534,
        protonDocuments: 7,
      }),
    });
    expect(lines).toContain('Last sync: 2026-09-22T17:42:23.000Z, 2 files copied');
    expect(lines).toContain('Last full sync: 2026-09-22T16:28:03.000Z');
    expect(lines).toContain('Files: 30617 on this computer, 30624 on Proton, 30617 in sync');
    expect(lines).toContain('Folders: 534 in sync');
    expect(lines).toContain('Proton documents: 7 on Proton only (Docs and Sheets stay in the browser)');
    expect(lines.join('\n')).not.toContain('31151');
    expect(lines.join(' ')).not.toContain('synced)');
    expect(lines.some((l) => l.startsWith('Only on'))).toBe(false);
  });

  it('uses the singular for one copied file and one file on either side', () => {
    const base = initialStatus(false, 1);
    const one = summarize({
      ...base,
      state: 'idle',
      lastSuccessfulSyncAt: Date.UTC(2026, 0, 2),
      lastRunFilesCopied: 1,
      counts: counts({ localFiles: 2, remoteFiles: 3, pairedFiles: 1, protonDocuments: 1, onlyLocal: 1, onlyRemote: 1, baseline: 1 }),
    });
    expect(one).toContain('Last sync: 2026-01-02T00:00:00.000Z, 1 file copied');
    expect(one).toContain('Proton documents: 1 on Proton only (Docs and Sheets stay in the browser)');
    expect(one).toContain('Only on this computer: 1 file');
    expect(one).toContain('Only on Proton: 1 file');
    const many = summarize({
      ...base,
      state: 'idle',
      counts: counts({ localFiles: 4, remoteFiles: 5, pairedFiles: 1, onlyLocal: 3, onlyRemote: 2, baseline: 1 }),
    });
    expect(many).toContain('Only on this computer: 3 files');
    expect(many).toContain('Only on Proton: 2 files');
    expect(many.some((l) => l.startsWith('Last sync:'))).toBe(false);
  });

  it('leads with the file-run glance and leaves pending counts unchanged', () => {
    const base = initialStatus(false, 1);
    expect(base.progress).toBeNull();
    const syncing = summarize({ ...base, state: 'syncing', progress: { done: 34, total: 5685 }, pending: { uploads: 0, downloads: 5685, other: 0 } });
    expect(syncing[0]).toBe('Sync (34/5685)');
    expect(syncing).toContain('Pending: 0 up, 5685 down, 0 other');
    const paused = summarize({ ...base, state: 'paused', progress: { done: 34, total: 5685 } });
    expect(paused[0]).toBe('Paused (34/5685)');
    const idle = summarize({ ...base, state: 'idle', progress: null, counts: counts({ baseline: 2, localFiles: 2, remoteFiles: 2, pairedFiles: 2 }) });
    expect(idle[0]).toBe('In sync');
    expect(idle.join(' ')).not.toContain('Sync (');
    expect(idle).toContain('Files: 2 on this computer, 2 on Proton, 2 in sync');
    expect(glanceText({ state: 'scanning', progress: null })).toBeNull();
    expect(glanceText({ state: 'idle', progress: { done: 10, total: 10 } })).toBeNull();
  });
});

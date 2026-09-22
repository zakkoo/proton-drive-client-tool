import { describe, expect, it } from 'vitest';

import { allTransitions, canTransition, glanceText, initialStatus, summarize, type EngineState } from './status.js';

const STATES: EngineState[] = ['starting', 'idle', 'scanning', 'syncing', 'paused', 'offline', 'throttled', 'attention', 'awaiting_confirmation', 'error', 'needs_login', 'stopped'];

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
    });
    expect(lines[0]).toBe('Needs attention');
    expect(lines).toContain('DRY RUN: no changes are made');
    expect(lines).toContain('Event stream degraded; using periodic listings');
    expect(lines).toContain('Pending: 2 up, 1 down, 0 other');
    expect(lines).toContain('1 conflict(s) to resolve');
    expect(lines).toContain('2 quarantined item(s)');
    expect(lines).toContain('Held plan: too many deletes');
    expect(lines.at(-1)).toMatch(/Last full sync: 2026-01-01/);
  });

  it('leads with the file-run glance and leaves pending counts unchanged', () => {
    const base = initialStatus(false, 1);
    expect(base.progress).toBeNull();
    const syncing = summarize({ ...base, state: 'syncing', progress: { done: 34, total: 5685 }, pending: { uploads: 0, downloads: 5685, other: 0 } });
    expect(syncing[0]).toBe('Sync (34/5685)');
    expect(syncing).toContain('Pending: 0 up, 5685 down, 0 other');
    const paused = summarize({ ...base, state: 'paused', progress: { done: 34, total: 5685 } });
    expect(paused[0]).toBe('Paused (34/5685)');
    const idle = summarize({ ...base, state: 'idle', progress: null, counts: { baseline: 2, localFiles: 2, remoteFiles: 2 } });
    expect(idle[0]).toBe('In sync');
    expect(idle.join(' ')).not.toContain('Sync (');
    expect(glanceText({ state: 'scanning', progress: null })).toBeNull();
    expect(glanceText({ state: 'idle', progress: { done: 10, total: 10 } })).toBeNull();
  });
});

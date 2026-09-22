import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Chip {
  state: string;
  urgent: boolean;
  label: string;
  tooltip: string;
}

interface ModelApi {
  chipModel(input: unknown): Chip;
  transferLine(transfer: unknown): string;
}

const sandbox: { ProtonDriveModel?: ModelApi } = {};
runInNewContext(readFileSync(path.resolve(import.meta.dirname, '../../omarchy/Model.js'), 'utf8'), sandbox);
const model = sandbox.ProtonDriveModel;
if (model === undefined) throw new Error('ProtonDriveModel was not evaluated');

const quiet = { conflicts: 0, quarantined: 0, heldPlan: null };

describe('bar chip model', () => {
  it('covers install, sign-in, setup, stopped engine, syncing, and attention', () => {
    expect(model.chipModel({ installed: false }).state).toBe('not_installed');
    expect(model.chipModel({ installed: true, doctor: { loggedIn: false, configured: false } }).state).toBe('not_signed_in');
    expect(model.chipModel({ installed: true, doctor: { loggedIn: true, configured: false } }).state).toBe('not_configured');
    expect(model.chipModel({ installed: true, doctor: { loggedIn: true, configured: true, running: false } }).state).toBe('not_running');
    expect(model.chipModel({ installed: true, status: { state: 'syncing', attention: quiet } })).toMatchObject({ state: 'syncing', urgent: false, label: 'Sync' });
    const attention = model.chipModel({
      installed: true,
      status: { state: 'idle', attention: { conflicts: 1, quarantined: 0, heldPlan: null } },
    });
    expect(attention).toMatchObject({ state: 'attention', urgent: true });
    const held = model.chipModel({
      installed: true,
      status: { state: 'syncing', attention: { conflicts: 0, quarantined: 0, heldPlan: { id: 'held-1' } } },
    });
    expect(held.state).toBe('awaiting_confirmation');
  });

  it('keeps every engine state visually distinct', () => {
    const states = ['starting', 'idle', 'scanning', 'syncing', 'paused', 'offline', 'throttled', 'attention', 'awaiting_confirmation', 'error', 'needs_login', 'stopped'];
    const labels = states.map((state) => model.chipModel({ installed: true, status: { state, attention: quiet } }).label);
    expect(new Set(labels).size).toBe(states.length);
  });

  it('formats a transfer with direction and percent', () => {
    expect(model.transferLine({ kind: 'upload', relPath: 'a.txt', bytes: 1, total: 4 })).toBe('↑ a.txt 25%');
    expect(model.transferLine({ kind: 'download', relPath: 'b.txt', bytes: 0, total: 0 })).toBe('↓ b.txt');
  });
});

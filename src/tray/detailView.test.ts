// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { initialStatus, type EngineStatus } from '../engine/status.js';
import { applySnapshot, type DetailData } from './detailView.js';

/**
 * The detail page renders the live snapshot into the visible DOM — not just a
 * JSON endpoint (spec: tray-status-ui / Detail page is a live view). A loaded
 * page for a running engine must show state, counts and lists, never a blank
 * shell.
 */

function fixture(): void {
  document.body.innerHTML = `
    <span id="state"></span><span id="reason"></span>
    <span id="counts"></span><span id="lastsync"></span>
    <p id="lines"></p><div id="held"></div>
    <table id="transfers"></table><table id="conflicts"></table>
    <table id="quarantine"></table><table id="recycle"></table>`;
}

function statusWith(over: Partial<EngineStatus>): EngineStatus {
  return { ...initialStatus(false, 0), ...over };
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

describe('applySnapshot', () => {
  it('shows state, non-empty file counts and last sync, and fills the lists', () => {
    fixture();
    const status = statusWith({
      state: 'idle',
      counts: { baseline: 5, localFiles: 5, remoteFiles: 4 },
      lastSuccessfulSyncAt: 1_700_000_000_000,
      summaryLines: ['In sync', 'Files: 5 local, 4 remote (5 synced)'],
    });
    const data: DetailData = {
      status,
      conflicts: [{ id: 1, relPath: 'c.txt', kind: 'content', local: { size: 1 }, remote: { size: 2 } }],
      quarantine: [],
      recycle: [{ bucket: 1_700_000_000_000, relPath: 'old.txt' }],
    };

    applySnapshot(document, data);

    expect(el('state').textContent).toBe('idle');
    expect(el('counts').textContent).toBe('5 local · 4 remote · 5 synced');
    expect(el('lastsync').textContent).not.toBe('never');
    expect(el('conflicts').innerHTML).toContain('c.txt');
    expect(el('recycle').innerHTML).toContain('old.txt');
    // An empty list renders a "none" row, not a blank table.
    expect(el('quarantine').innerHTML).toContain('none');
  });

  it('never leaves the page a blank shell: even a fresh status fills the fields', () => {
    fixture();
    applySnapshot(document, { status: statusWith({ counts: { baseline: 2, localFiles: 2, remoteFiles: 2 } }), conflicts: [], quarantine: [], recycle: [] });
    expect(el('state').textContent).not.toBe('');
    expect(el('counts').textContent).toBe('2 local · 2 remote · 2 synced');
    expect(el('transfers').innerHTML).toContain('none');
  });
});

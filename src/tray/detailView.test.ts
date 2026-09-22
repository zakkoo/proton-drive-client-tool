// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { formatStatus } from '../cli/output.js';
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
    <p id="lines"></p><div id="proton-documents"></div><div id="held"></div>
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
      counts: { baseline: 5, localFiles: 5, remoteFiles: 4, pairedFiles: 5, pairedFolders: 0, protonDocuments: 0, onlyLocal: 0, onlyRemote: 0 },
      lastSuccessfulSyncAt: 1_700_000_000_000,
      summaryLines: ['In sync', 'Last sync: 2023-11-14T22:13:20.000Z, 2 files copied', 'Files: 5 on this computer, 4 on Proton, 5 in sync'],
      protonDocumentPaths: [],
    });
    const data: DetailData = {
      status,
      conflicts: [{ id: 1, relPath: 'c.txt', kind: 'content', local: { size: 1 }, remote: { size: 2 } }],
      quarantine: [],
      recycle: [{ bucket: 1_700_000_000_000, relPath: 'old.txt' }],
    };

    applySnapshot(document, data);

    expect(el('state').textContent).toBe('idle');
    expect(el('lines').textContent).toContain('Last sync: 2023-11-14T22:13:20.000Z, 2 files copied');
    expect(el('lines').textContent).toContain('Files: 5 on this computer, 4 on Proton, 5 in sync');
    expect(el('lines').textContent).not.toContain('synced');
    expect(el('proton-documents').textContent).toBe('');
    expect(el('conflicts').innerHTML).toContain('c.txt');
    expect(el('recycle').innerHTML).toContain('old.txt');
    // An empty list renders a "none" row, not a blank table.
    expect(el('quarantine').innerHTML).toContain('none');
  });

  it('never leaves the page a blank shell: even a fresh status fills the fields', () => {
    fixture();
    applySnapshot(document, { status: statusWith({ counts: { baseline: 2, localFiles: 2, remoteFiles: 2, pairedFiles: 2, pairedFolders: 0, protonDocuments: 0, onlyLocal: 0, onlyRemote: 0 } }), conflicts: [], quarantine: [], recycle: [] });
    expect(el('state').textContent).not.toBe('');
    expect(el('proton-documents').textContent).toBe('');
    expect(el('transfers').innerHTML).toContain('none');
  });

  it('lists Proton document paths on the page and leaves them out of human CLI status', () => {
    fixture();
    const status = statusWith({
      state: 'idle',
      summaryLines: ['In sync', 'Proton documents: 2 on Proton only (Docs and Sheets stay in the browser)'],
      protonDocumentPaths: ['Notes/Agenda', 'Notes/Budget'],
    });
    applySnapshot(document, { status, conflicts: [], quarantine: [], recycle: [] });
    expect(el('proton-documents').textContent).toContain('Notes/Agenda');
    expect(el('proton-documents').textContent).toContain('Notes/Budget');
    const human = formatStatus(status).join('\n');
    expect(human).toContain('Proton documents: 2');
    expect(human).not.toContain('Notes/Agenda');
    expect(human).not.toContain('Notes/Budget');
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatStatus } from '../cli/output.js';
import { glanceText, initialStatus, type EngineStatus } from '../engine/status.js';
import { applySnapshot, clientScript, type DetailData } from './detailView.js';

/**
 * The detail page renders the live snapshot into the visible DOM — not just a
 * JSON endpoint (spec: tray-status-ui / Detail page is a live view). A loaded
 * page for a running engine must show state, counts and lists, never a blank
 * shell.
 */

function fixture(): void {
  document.body.innerHTML = `
    <span id="state"></span><span id="reason"></span><span id="glance"></span>
    <p id="flags"></p><p id="action-error" hidden></p>
    <div id="lines"></div><div id="proton-documents"></div><div id="held"></div>
    <div id="transfers"></div><div id="conflicts"></div>
    <div id="quarantine"></div><div id="recycle"></div>`;
  delete (document as Document & { __detailUi?: unknown }).__detailUi;
}

function statusWith(over: Partial<EngineStatus>): EngineStatus {
  return { ...initialStatus(false, 0), ...over };
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

function control<T extends Element>(id: string, selector: string, kind: new () => T): T {
  const node = el(id).querySelector(selector);
  if (!(node instanceof kind)) throw new Error(`missing ${selector} in #${id}`);
  return node;
}

function dataFor(status: EngineStatus, extra: Partial<DetailData> = {}): DetailData {
  return { status, conflicts: [], quarantine: [], recycle: [], ...extra };
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
    expect(el('lines').querySelectorAll('.reading')).toHaveLength(3);
    expect(el('lines').textContent).toContain('Last sync: 2023-11-14T22:13:20.000Z, 2 files copied');
    expect(el('lines').textContent).toContain('Files: 5 on this computer, 4 on Proton, 5 in sync');
    expect(el('lines').textContent).not.toContain('synced');
    expect(el('proton-documents').textContent).toContain('none');
    expect(el('conflicts').innerHTML).toContain('c.txt');
    expect(el('conflicts').textContent).toContain('1 B');
    expect(el('conflicts').textContent).toContain('"size": 1');
    expect(el('conflicts').innerHTML).toContain("choice:'keep_local'");
    expect(el('conflicts').innerHTML).toContain("choice:'keep_remote'");
    expect(el('conflicts').innerHTML).toContain("choice:'keep_both'");
    const recycled = el('recycle').querySelector('time');
    expect(recycled?.textContent).toContain('2023-11-14T22:13:20.000Z');
    expect(recycled?.getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
    expect(el('recycle').innerHTML).toContain('old.txt');
    expect(el('quarantine').innerHTML).toContain('none');
    expect(el('flags').textContent).toBe('');
  });

  it('never leaves the page a blank shell: even a fresh status fills the fields', () => {
    fixture();
    applySnapshot(document, { status: statusWith({ counts: { baseline: 2, localFiles: 2, remoteFiles: 2, pairedFiles: 2, pairedFolders: 0, protonDocuments: 0, onlyLocal: 0, onlyRemote: 0 } }), conflicts: [], quarantine: [], recycle: [] });
    expect(el('state').textContent).not.toBe('');
    expect(el('proton-documents').textContent).toContain('none');
    expect(el('transfers').innerHTML).toContain('none');
  });

  it('lists Proton document paths on the page and leaves them out of human CLI status', () => {
    fixture();
    const status = statusWith({
      state: 'idle',
      summaryLines: ['In sync', 'Proton documents: 2 on Proton only (Docs and Sheets stay in the browser)'],
      protonDocumentPaths: ['Notes/Agenda', 'Notes/Budget'],
    });
    applySnapshot(document, dataFor(status));
    expect(el('proton-documents').textContent).toContain('Notes/Agenda');
    expect(el('proton-documents').textContent).toContain('Notes/Budget');
    const human = formatStatus(status).join('\n');
    expect(human).toContain('Proton documents: 2');
    expect(human).not.toContain('Notes/Agenda');
    expect(human).not.toContain('Notes/Budget');
  });

  it('shows the glance string while a file run is moving and a dry-run note only when asked', () => {
    fixture();
    const syncing = statusWith({
      state: 'syncing',
      progress: { done: 34, total: 5685 },
      summaryLines: ['Last sync: 2023-11-14T22:13:20.000Z, 2 files copied'],
    });
    applySnapshot(document, dataFor(syncing));
    expect(el('glance').textContent).toBe(glanceText(syncing));
    expect(el('glance').textContent).toBe('Sync (34/5685)');
    expect(el('lines').textContent).toContain('2 files copied');
    expect(el('flags').textContent).not.toContain('Dry run');

    const paused = statusWith({ state: 'paused', progress: { done: 34, total: 5685 }, dryRun: true, degraded: true });
    applySnapshot(document, dataFor(paused));
    expect(el('glance').textContent).toBe(glanceText(paused));
    expect(el('glance').textContent).toBe('Paused (34/5685)');
    expect(el('flags').textContent).toContain('Dry run');
    expect(el('flags').textContent).toContain('The event stream is degraded');
  });

  it('pages a long Proton document list, filters it, and keeps that place across a refresh', () => {
    fixture();
    const paths = Array.from({ length: 30 }, (_, i) => `notes/file-${String(i).padStart(2, '0')}`);
    paths[29] = 'Notes/Agenda';
    const status = statusWith({ protonDocumentPaths: paths });
    const data = dataFor(status);
    applySnapshot(document, data);

    expect(el('proton-documents').textContent).toContain('30');
    expect(el('proton-documents').textContent).toContain('notes/file-00');
    expect(el('proton-documents').textContent).toContain('notes/file-24');
    expect(el('proton-documents').textContent).not.toContain('notes/file-25');

    control('proton-documents', '[data-next]', HTMLButtonElement).click();
    expect(el('proton-documents').textContent).toContain('notes/file-25');
    expect(el('proton-documents').textContent).toContain('Notes/Agenda');
    expect(el('proton-documents').textContent).not.toContain('notes/file-00');

    const filter = control('proton-documents', '[data-filter]', HTMLInputElement);
    filter.value = 'agenda';
    filter.dispatchEvent(new Event('input'));
    expect(el('proton-documents').textContent).toContain('Notes/Agenda');
    expect(el('proton-documents').textContent).toContain('30');
    expect(el('proton-documents').textContent).not.toContain('notes/file-00');
    filter.value = 'no-such-path';
    filter.dispatchEvent(new Event('input'));
    expect(el('proton-documents').textContent).toContain('nothing matches');
    expect(el('proton-documents').textContent).toContain('30');

    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    expect(el('proton-documents').textContent).toContain('notes/file-00');
    expect(el('proton-documents').textContent).not.toContain('notes/file-25');

    const broad = control('proton-documents', '[data-filter]', HTMLInputElement);
    broad.value = 'file';
    broad.dispatchEvent(new Event('input'));
    control('proton-documents', '[data-next]', HTMLButtonElement).click();
    expect(el('proton-documents').textContent).toContain('notes/file-25');
    const kept = control('proton-documents', '[data-filter]', HTMLInputElement);
    kept.focus();
    applySnapshot(document, data);
    expect(el('proton-documents').querySelector('[data-filter]')).toBe(kept);
    expect(kept.value).toBe('file');
    expect(el('proton-documents').textContent).toContain('notes/file-25');
    expect(el('proton-documents').textContent).not.toContain('notes/file-00');
  });
});

describe('clientScript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    const timer = (window as unknown as { __detailRefresh?: ReturnType<typeof setInterval> }).__detailRefresh;
    if (timer !== undefined) window.clearInterval(timer);
  });

  it('shows an action error and clears it after the next success', async () => {
    fixture();
    let pauses = 0;
    const snapshot = dataFor(statusWith({ state: 'idle' }));
    vi.stubGlobal('fetch', (input: string) => {
      const url = input;
      if (url.endsWith('/api/state')) return Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) });
      pauses += 1;
      if (pauses === 1) return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false, error: 'refused' }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
    window.eval(clientScript());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (window as unknown as { act: (name: string) => Promise<void> }).act('pause');
    expect(el('action-error').textContent).toBe('refused');
    expect(el('action-error').hidden).toBe(false);
    await (window as unknown as { act: (name: string) => Promise<void> }).act('pause');
    expect(el('action-error').textContent).toBe('');
    expect(el('action-error').hidden).toBe(true);
  });
});

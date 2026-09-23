/**
 * The detail page's snapshot-to-DOM renderer, extracted so the exact code that
 * runs in the browser is also unit-tested against a DOM (happy-dom). It is
 * self-contained (no imports, no closures) so `applySnapshot.toString()` can be
 * inlined verbatim into the served page.
 */
import type { EngineStatus } from '../engine/status.js';

export interface DetailData {
  status: EngineStatus;
  conflicts: { id: number; relPath: string; kind: string; local: unknown; remote: unknown }[];
  quarantine: { id: number; relPath: string | null; nodeUid: string | null; reason: string }[];
  recycle: { bucket: number; relPath: string }[];
}

/**
 * Render the live snapshot into the page. Must stay a pure function of
 * (document, data) with everything it needs defined inside it.
 */
export function applySnapshot(doc: Document, data: DetailData): void {
  const PAGE_SIZE = 25;
  interface SectionUi { page: number; query: string }
  interface DetailUi { actionError: string; sections: Record<string, SectionUi> }
  interface DetailWindow extends Window {
    detailNav?: (id: string, dir: number) => void;
    detailQuery?: (id: string, value: string) => void;
  }
  interface PageWindow<T> {
    shown: T[];
    total: number;
    filtered: number;
    page: number;
    pages: number;
    query: string;
    from: number;
    to: number;
  }

  const s = data.status;
  const host = doc as Document & { __detailUi?: DetailUi };
  host.__detailUi ??= { actionError: '', sections: {} };
  const ui = host.__detailUi;

  const esc = (v: unknown): string => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const js = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const set = (id: string, text: string): void => {
    const el = doc.getElementById(id);
    if (el !== null) el.textContent = text;
  };
  const sectionState = (id: string): SectionUi => {
    ui.sections[id] ??= { page: 1, query: '' };
    return ui.sections[id];
  };
  const windowOf = <T>(id: string, items: readonly T[], pathOf: (item: T) => string): PageWindow<T> => {
    const st = sectionState(id);
    const q = st.query.trim().toLowerCase();
    const matched = q === '' ? items.slice() : items.filter((item) => pathOf(item).toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
    if (st.page > pages) st.page = pages;
    if (st.page < 1) st.page = 1;
    const fromIndex = (st.page - 1) * PAGE_SIZE;
    const shown = matched.slice(fromIndex, fromIndex + PAGE_SIZE);
    return {
      shown,
      total: items.length,
      filtered: matched.length,
      page: st.page,
      pages,
      query: st.query,
      from: matched.length === 0 ? 0 : fromIndex + 1,
      to: fromIndex + shown.length,
    };
  };
  const paint = (id: string, title: string, body: string, meta: PageWindow<unknown>): void => {
    const el = doc.getElementById(id);
    if (el === null) return;
    const existing = el.querySelector('input[data-filter]');
    const focused = existing !== null && doc.activeElement === existing;
    if (existing === null) {
      el.innerHTML =
        '<h2>' + esc(title) + ' <span data-count></span></h2>' +
        '<div class="toolbar" data-toolbar>' +
        '<input data-filter type="search" aria-label="' + esc(title) + ' filter">' +
        '<button type="button" class="btn" data-prev>Previous</button>' +
        '<button type="button" class="btn" data-next>Next</button>' +
        '<span data-pager class="pager"></span></div>' +
        '<div class="scroll" data-rows></div>';
      const created = el.querySelector('[data-filter]');
      const goPrev = el.querySelector('[data-prev]');
      const goNext = el.querySelector('[data-next]');
      if (created instanceof HTMLInputElement) created.addEventListener('input', () => { view.detailQuery?.(id, created.value); });
      if (goPrev !== null) goPrev.addEventListener('click', () => { view.detailNav?.(id, -1); });
      if (goNext !== null) goNext.addEventListener('click', () => { view.detailNav?.(id, 1); });
    }
    const count = el.querySelector('[data-count]');
    if (count !== null) count.textContent = String(meta.total);
    const pager = el.querySelector('[data-pager]');
    if (pager !== null) pager.textContent = meta.filtered === 0 ? '0' : String(meta.from) + '–' + String(meta.to) + ' of ' + String(meta.filtered);
    const prev = el.querySelector('[data-prev]');
    const next = el.querySelector('[data-next]');
    if (prev instanceof HTMLButtonElement) prev.disabled = meta.page <= 1;
    if (next instanceof HTMLButtonElement) next.disabled = meta.page >= meta.pages;
    const input = el.querySelector('[data-filter]');
    if (input instanceof HTMLInputElement && !focused && input.value !== meta.query) input.value = meta.query;
    const rows = el.querySelector('[data-rows]');
    if (rows !== null) rows.innerHTML = body;
  };
  const emptyBody = (meta: PageWindow<unknown>): string => (meta.total === 0 ? '<p class="empty">none</p>' : '<p class="empty">nothing matches</p>');
  const side = (value: unknown): string => {
    const json = '<details><summary>JSON</summary><pre>' + esc(JSON.stringify(value, null, 2)) + '</pre></details>';
    if (typeof value !== 'object' || value === null) return esc(JSON.stringify(value)) + json;
    const record = value as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof record['name'] === 'string') bits.push(record['name']);
    if (typeof record['size'] === 'number') bits.push(String(record['size']) + ' B');
    const mtime = record['mtimeMs'] ?? record['mtime'];
    if (typeof mtime === 'number') bits.push(new Date(mtime).toISOString());
    if (typeof record['sha1'] === 'string' && record['sha1'] !== '') bits.push(record['sha1'].slice(0, 8));
    return esc(bits.length > 0 ? bits.join(' · ') : 'record') + json;
  };

  const view: DetailWindow = doc.defaultView ?? (globalThis as unknown as DetailWindow);
  view.detailNav = (id: string, dir: number): void => {
    const st = sectionState(id);
    st.page += dir;
    if (st.page < 1) st.page = 1;
    applySnapshot(doc, data);
  };
  view.detailQuery = (id: string, value: string): void => {
    const st = sectionState(id);
    st.query = value;
    st.page = 1;
    applySnapshot(doc, data);
  };

  set('state', s.state.replace(/_/g, ' '));
  set('reason', s.reason ?? '');
  const progress = s.progress;
  let glance = '';
  if (progress !== null && progress.total > 0 && s.state === 'syncing') glance = 'Sync (' + String(progress.done) + '/' + String(progress.total) + ')';
  if (progress !== null && progress.total > 0 && s.state === 'paused') glance = 'Paused (' + String(progress.done) + '/' + String(progress.total) + ')';
  set('glance', glance);
  const primary = s.state === 'paused' ? 'act-resume' : s.state === 'needs_login' || s.state === 'stopped' || s.state === 'error' || s.state === 'offline' ? 'act-sync' : 'act-pause';
  for (const id of ['act-pause', 'act-resume', 'act-sync']) {
    const button = doc.getElementById(id);
    if (button !== null) button.classList.toggle('primary', id === primary);
  }
  const flags = doc.getElementById('flags');
  if (flags !== null) {
    const notes: string[] = [];
    if (s.dryRun) notes.push('Dry run');
    if (s.degraded) notes.push('The event stream is degraded');
    flags.innerHTML = notes.map((note) => '<span class="note">' + esc(note) + '</span>').join('');
  }
  const lines = doc.getElementById('lines');
  if (lines !== null) lines.innerHTML = s.summaryLines.map((line) => '<p class="reading">' + esc(line) + '</p>').join('');
  const actionError = doc.getElementById('action-error');
  if (actionError !== null) {
    actionError.textContent = ui.actionError;
    actionError.hidden = ui.actionError === '';
  }

  const held = s.attention.heldPlan;
  const heldEl = doc.getElementById('held');
  if (heldEl !== null) {
    if (held === null) {
      heldEl.innerHTML = '';
      heldEl.hidden = true;
    } else {
      heldEl.hidden = false;
      if (heldEl.querySelector('[data-rows]') === null) {
        heldEl.innerHTML =
          '<div class="warn"><h2>Held plan <span data-count></span></h2><p><strong>Confirmation required:</strong> <span data-reason></span></p>' +
          '<div class="toolbar"><input data-filter type="search" aria-label="Held plan filter">' +
          '<button type="button" class="btn" data-prev>Previous</button>' +
          '<button type="button" class="btn" data-next>Next</button>' +
          '<span data-pager class="pager"></span></div><div class="scroll" data-rows></div>' +
          '<p class="actions"><button type="button" class="btn primary" data-confirm>Proceed</button><button type="button" class="btn" data-reject>Reject</button></p></div>';
        const heldFilter = heldEl.querySelector('[data-filter]');
        const heldGoPrev = heldEl.querySelector('[data-prev]');
        const heldGoNext = heldEl.querySelector('[data-next]');
        if (heldFilter instanceof HTMLInputElement) heldFilter.addEventListener('input', () => { view.detailQuery?.('held', heldFilter.value); });
        if (heldGoPrev !== null) heldGoPrev.addEventListener('click', () => { view.detailNav?.('held', -1); });
        if (heldGoNext !== null) heldGoNext.addEventListener('click', () => { view.detailNav?.('held', 1); });
      }
      const reason = heldEl.querySelector('[data-reason]');
      if (reason !== null) reason.textContent = held.reason;
      const confirm = heldEl.querySelector('[data-confirm]');
      const reject = heldEl.querySelector('[data-reject]');
      if (confirm !== null) confirm.setAttribute('onclick', "act('confirm', {id:'" + js(held.id) + "'})");
      if (reject !== null) reject.setAttribute('onclick', "act('reject', {id:'" + js(held.id) + "'})");
      const heldPage = windowOf('held', held.affected, (path) => path);
      const heldInput = heldEl.querySelector('[data-filter]');
      const heldFocused = heldInput !== null && doc.activeElement === heldInput;
      const heldCount = heldEl.querySelector('[data-count]');
      if (heldCount !== null) heldCount.textContent = String(heldPage.total);
      const heldPager = heldEl.querySelector('[data-pager]');
      if (heldPager !== null) heldPager.textContent = heldPage.filtered === 0 ? '0' : String(heldPage.from) + '–' + String(heldPage.to) + ' of ' + String(heldPage.filtered);
      const heldPrev = heldEl.querySelector('[data-prev]');
      const heldNext = heldEl.querySelector('[data-next]');
      if (heldPrev instanceof HTMLButtonElement) heldPrev.disabled = heldPage.page <= 1;
      if (heldNext instanceof HTMLButtonElement) heldNext.disabled = heldPage.page >= heldPage.pages;
      if (heldInput instanceof HTMLInputElement && !heldFocused && heldInput.value !== heldPage.query) heldInput.value = heldPage.query;
      const heldRows = heldEl.querySelector('[data-rows]');
      if (heldRows !== null) {
        heldRows.innerHTML = heldPage.filtered === 0
          ? emptyBody(heldPage)
          : '<ul>' + heldPage.shown.map((path) => '<li>' + esc(path) + '</li>').join('') + '</ul>';
      }
    }
  }

  const docs = windowOf('proton-documents', s.protonDocumentPaths, (path) => path);
  paint('proton-documents', 'Proton documents', docs.filtered === 0 ? emptyBody(docs) : '<ul>' + docs.shown.map((path) => '<li>' + esc(path) + '</li>').join('') + '</ul>', docs);

  const transfers = windowOf('transfers', s.transfers, (row) => row.relPath);
  const transferRows = transfers.shown.map((row) => {
    const pct = row.total !== undefined && row.total > 0 ? Math.round((row.bytes / row.total) * 100) : 0;
    return '<tr><td>' + (row.kind === 'upload' ? '↑ upload' : '↓ download') + '</td><td>' + esc(row.relPath) + '</td><td><div class="bar"><div style="width:' + String(pct) + '%"></div></div></td><td>' + String(Math.round(row.speed / 1024)) + ' KiB/s</td></tr>';
  }).join('');
  paint('transfers', 'Transfers', transfers.filtered === 0 ? emptyBody(transfers) : '<table><tr><th>Direction</th><th>Path</th><th>Progress</th><th>Speed</th></tr>' + transferRows + '</table>', transfers);

  const conflicts = windowOf('conflicts', data.conflicts, (row) => row.relPath);
  const conflictRows = conflicts.shown.map((row) =>
    '<tr><td>' + esc(row.relPath) + '</td><td>' + esc(row.kind) + '</td><td>' + side(row.local) + '</td><td>' + side(row.remote) + '</td><td>' +
    '<button type="button" class="btn" onclick="act(\'resolve\', {id:' + String(row.id) + ", choice:'keep_local'})\">Keep local</button>" +
    '<button type="button" class="btn" onclick="act(\'resolve\', {id:' + String(row.id) + ", choice:'keep_remote'})\">Keep remote</button>" +
    '<button type="button" class="btn" onclick="act(\'resolve\', {id:' + String(row.id) + ", choice:'keep_both'})\">Keep both</button></td></tr>").join('');
  paint('conflicts', 'Conflicts', conflicts.filtered === 0 ? emptyBody(conflicts) : '<table><tr><th>Path</th><th>Kind</th><th>Local</th><th>Remote</th><th>Resolve</th></tr>' + conflictRows + '</table>', conflicts);

  const quarantine = windowOf('quarantine', data.quarantine, (row) => row.relPath ?? '');
  const quarantineRows = quarantine.shown.map((row) =>
    '<tr><td>' + esc(row.relPath ?? '-') + '</td><td>' + esc(row.nodeUid ?? '-') + '</td><td>' + esc(row.reason) + '</td><td><button type="button" class="btn" onclick="act(\'release\', {id:' + String(row.id) + '})">Release</button></td></tr>').join('');
  paint('quarantine', 'Quarantine', quarantine.filtered === 0 ? emptyBody(quarantine) : '<table><tr><th>Path</th><th>Node</th><th>Reason</th><th></th></tr>' + quarantineRows + '</table>', quarantine);

  const recycle = windowOf('recycle', data.recycle, (row) => row.relPath);
  const recycleRows = recycle.shown.map((row) => {
    const iso = new Date(row.bucket).toISOString();
    return '<tr><td><time datetime="' + esc(iso) + '">' + esc(new Date(row.bucket).toLocaleString()) + ' ' + esc(iso) + '</time></td><td>' + esc(row.relPath) + '</td></tr>';
  }).join('');
  paint('recycle', 'Recycle bin', recycle.filtered === 0 ? emptyBody(recycle) : '<table><tr><th>Recycled at</th><th>Path</th></tr>' + recycleRows + '</table>', recycle);
}

/** The browser script for the served page: the tested renderer plus the fetch/refresh glue. */
export function clientScript(): string {
  return `${applySnapshot.toString()}
function detailUi() {
  document.__detailUi ??= { actionError: '', sections: {} };
  return document.__detailUi;
}
const base = location.pathname.replace(/\\/$/, '');
async function act(name, body) {
  let message = '';
  try {
    const response = await fetch(base + '/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) message = String(payload.error ?? 'Action failed');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  detailUi().actionError = message;
  await refresh();
}
async function refresh() {
  const response = await fetch(base + '/api/state');
  applySnapshot(document, await response.json());
}
refresh();
window.__detailRefresh = setInterval(refresh, 2000);`;
}

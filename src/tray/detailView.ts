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
  const s = data.status;
  const esc = (v: unknown): string => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const set = (id: string, text: string): void => {
    const el = doc.getElementById(id);
    if (el !== null) el.textContent = text;
  };
  const rows = (id: string, header: string[], list: unknown[], fn: (row: never) => string): void => {
    const el = doc.getElementById(id);
    if (el === null) return;
    const head = '<tr>' + header.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>';
    const body = list.length > 0 ? list.map((r) => fn(r as never)).join('') : '<tr><td class="muted" colspan="' + String(header.length) + '">none</td></tr>';
    el.innerHTML = head + body;
  };

  set('state', s.state.replace(/_/g, ' '));
  set('reason', s.reason ?? '');
  set('lines', s.summaryLines.join('\n'));
  const docs = doc.getElementById('proton-documents');
  if (docs !== null) {
    const paths = s.protonDocumentPaths;
    docs.innerHTML = paths.length === 0 ? '' : '<h2>Proton documents</h2><ul>' + paths.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>';
  }

  const held = s.attention.heldPlan;
  const heldEl = doc.getElementById('held');
  if (heldEl !== null) {
    heldEl.innerHTML =
      held === null
        ? ''
        : '<div class="warn"><b>Confirmation required:</b> ' + esc(held.reason) + '<ul>' + held.affected.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>' +
          '<button onclick="act(\'confirm\', {id:\'' + esc(held.id) + '\'})">Proceed</button>' +
          '<button onclick="act(\'reject\', {id:\'' + esc(held.id) + '\'})">Reject</button></div>';
  }

  rows('transfers', ['Direction', 'Path', 'Progress', 'Speed'], s.transfers, (t: EngineStatus['transfers'][number]) => {
    const pct = t.total !== undefined && t.total > 0 ? Math.round((t.bytes / t.total) * 100) : 0;
    return '<tr><td>' + (t.kind === 'upload' ? '↑ upload' : '↓ download') + '</td><td>' + esc(t.relPath) + '</td><td><div class="bar"><div style="width:' + String(pct) + '%"></div></div></td><td>' + String(Math.round(t.speed / 1024)) + ' KiB/s</td></tr>';
  });
  rows('conflicts', ['Path', 'Kind', 'Local', 'Remote', 'Resolve'], data.conflicts, (cf: DetailData['conflicts'][number]) =>
    '<tr><td>' + esc(cf.relPath) + '</td><td>' + esc(cf.kind) + '</td><td><code>' + esc(JSON.stringify(cf.local)) + '</code></td><td><code>' + esc(JSON.stringify(cf.remote)) + '</code></td><td>' +
    '<button onclick="act(\'resolve\', {id:' + String(cf.id) + ", choice:'keep_local'})\">Keep local</button>" +
    '<button onclick="act(\'resolve\', {id:' + String(cf.id) + ", choice:'keep_remote'})\">Keep remote</button>" +
    '<button onclick="act(\'resolve\', {id:' + String(cf.id) + ", choice:'keep_both'})\">Keep both</button></td></tr>");
  rows('quarantine', ['Path', 'Node', 'Reason', ''], data.quarantine, (q: DetailData['quarantine'][number]) =>
    '<tr><td>' + esc(q.relPath ?? '-') + '</td><td>' + esc(q.nodeUid ?? '-') + '</td><td>' + esc(q.reason) + '</td><td><button onclick="act(\'release\', {id:' + String(q.id) + '})">Release</button></td></tr>');
  rows('recycle', ['Recycled at', 'Path'], data.recycle, (i: DetailData['recycle'][number]) => '<tr><td>' + esc(new Date(i.bucket).toISOString()) + '</td><td>' + esc(i.relPath) + '</td></tr>');
}

/** The browser script for the served page: the tested renderer plus the fetch/refresh glue. */
export function clientScript(): string {
  return `${applySnapshot.toString()}
const base = location.pathname.replace(/\\/$/, '');
async function act(name, body) { await fetch(base + '/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); refresh(); }
async function refresh() { const r = await fetch(base + '/api/state'); applySnapshot(document, await r.json()); }
refresh(); setInterval(refresh, 2000);`;
}

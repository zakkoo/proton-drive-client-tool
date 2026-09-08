/**
 * Local detail page: a small HTTP server bound to 127.0.0.1 with a random
 * port and a per-run token in the path. Shows transfers, conflicts,
 * quarantine and the held plan with the same actions as the tray, rendered
 * in the default browser (dbusmenu cannot show tables).
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ControlTarget } from '../engine/control.js';

export class DetailPageServer {
  private server: Server | null = null;
  readonly token = randomBytes(16).toString('hex');
  private port = 0;

  constructor(private readonly target: ControlTarget) {}

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}/${this.token}/`;
  }

  async listen(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === null) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter((p) => p !== '');
    if (parts[0] !== this.token) {
      res.writeHead(404).end('not found');
      return;
    }
    const route = parts.slice(1).join('/');
    try {
      if (req.method === 'GET' && route === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
        return;
      }
      if (req.method === 'GET' && route === 'api/state') {
        this.json(res, {
          status: this.target.getStatus(),
          conflicts: this.target.listConflicts(),
          quarantine: this.target.listQuarantine(),
          recycle: this.target.listRecycle().filter((r) => r.kind === 'file'),
        });
        return;
      }
      if (req.method === 'POST' && route.startsWith('api/')) {
        const body = await readJson(req);
        await this.action(route.slice('api/'.length), body);
        this.json(res, { ok: true, status: this.target.getStatus() });
        return;
      }
      res.writeHead(404).end('not found');
    } catch (error) {
      this.json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async action(name: string, body: Record<string, unknown>): Promise<void> {
    const num = (k: string): number => {
      const v = body[k];
      if (typeof v !== 'number') throw new Error(`${k} must be a number`);
      return v;
    };
    const str = (k: string): string => {
      const v = body[k];
      if (typeof v !== 'string') throw new Error(`${k} must be a string`);
      return v;
    };
    switch (name) {
      case 'pause':
        this.target.pause();
        return;
      case 'resume':
        this.target.resume();
        return;
      case 'sync':
        await this.target.syncNow();
        return;
      case 'confirm':
        await this.target.confirmHeldPlan(str('id'));
        return;
      case 'reject':
        this.target.rejectHeldPlan(str('id'));
        return;
      case 'resolve': {
        const choice = str('choice');
        if (choice !== 'keep_local' && choice !== 'keep_remote' && choice !== 'keep_both') throw new Error('invalid choice');
        await this.target.resolveConflict(num('id'), choice);
        return;
      }
      case 'release':
        this.target.releaseQuarantine(num('id'));
        return;
      default:
        throw new Error(`unknown action ${name}`);
    }
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (text += c));
    req.on('end', () => {
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Proton Drive Sync</title>
<style>
body{font:14px system-ui,sans-serif;margin:2rem;max-width:960px}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3rem .5rem;border-bottom:1px solid #ddd}
.state{font-weight:600}.muted{color:#666}button{margin-right:.4rem}.bar{height:6px;background:#ddd;border-radius:3px}.bar>div{height:6px;background:#6d4aff;border-radius:3px}
.warn{background:#fff7e0;padding:.6rem 1rem;border-radius:6px}
</style></head><body>
<h1>Proton Drive Sync</h1>
<p><span class="state" id="state"></span> <span class="muted" id="reason"></span></p>
<p id="lines" class="muted"></p>
<p><button onclick="act('pause')">Pause</button><button onclick="act('resume')">Resume</button><button onclick="act('sync')">Sync now</button></p>
<div id="held"></div>
<h2>Transfers</h2><table id="transfers"></table>
<h2>Conflicts</h2><table id="conflicts"></table>
<h2>Quarantine</h2><table id="quarantine"></table>
<h2>Recycle bin</h2><table id="recycle"></table>
<script>
const base = location.pathname.replace(/\\/$/, '');
async function act(name, body) { await fetch(base + '/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); refresh(); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function rows(el, header, list, fn) { el.innerHTML = '<tr>' + header.map(h => '<th>' + h + '</th>').join('') + '</tr>' + (list.length ? list.map(fn).join('') : '<tr><td class="muted" colspan="' + header.length + '">none</td></tr>'); }
async function refresh() {
  const r = await fetch(base + '/api/state'); const d = await r.json(); const s = d.status;
  document.getElementById('state').textContent = s.state.replace(/_/g, ' ');
  document.getElementById('reason').textContent = s.reason || '';
  document.getElementById('lines').textContent = s.summaryLines.join(' · ');
  const h = s.attention.heldPlan;
  document.getElementById('held').innerHTML = h ? '<div class="warn"><b>Confirmation required:</b> ' + esc(h.reason) + '<ul>' + h.affected.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul><button onclick="act(\\'confirm\\', {id:\\'' + esc(h.id) + '\\'})">Proceed</button><button onclick="act(\\'reject\\', {id:\\'' + esc(h.id) + '\\'})">Reject</button></div>' : '';
  rows(document.getElementById('transfers'), ['Direction', 'Path', 'Progress', 'Speed'], s.transfers, t => { const pct = t.total ? Math.round(t.bytes / t.total * 100) : 0; return '<tr><td>' + (t.kind === 'upload' ? '↑ upload' : '↓ download') + '</td><td>' + esc(t.relPath) + '</td><td><div class="bar"><div style="width:' + pct + '%"></div></div></td><td>' + Math.round(t.speed / 1024) + ' KiB/s</td></tr>'; });
  rows(document.getElementById('conflicts'), ['Path', 'Kind', 'Local', 'Remote', 'Resolve'], d.conflicts, c => '<tr><td>' + esc(c.relPath) + '</td><td>' + esc(c.kind) + '</td><td><code>' + esc(JSON.stringify(c.local)) + '</code></td><td><code>' + esc(JSON.stringify(c.remote)) + '</code></td><td><button onclick="act(\\'resolve\\', {id:' + c.id + ', choice:\\'keep_local\\'})">Keep local</button><button onclick="act(\\'resolve\\', {id:' + c.id + ', choice:\\'keep_remote\\'})">Keep remote</button><button onclick="act(\\'resolve\\', {id:' + c.id + ', choice:\\'keep_both\\'})">Keep both</button></td></tr>');
  rows(document.getElementById('quarantine'), ['Path', 'Node', 'Reason', ''], d.quarantine, q => '<tr><td>' + esc(q.relPath || '-') + '</td><td>' + esc(q.nodeUid || '-') + '</td><td>' + esc(q.reason) + '</td><td><button onclick="act(\\'release\\', {id:' + q.id + '})">Release</button></td></tr>');
  rows(document.getElementById('recycle'), ['Recycled at', 'Path'], d.recycle, i => '<tr><td>' + new Date(i.bucket).toLocaleString() + '</td><td>' + esc(i.relPath) + '</td></tr>');
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;

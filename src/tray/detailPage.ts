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
import { clientScript } from './detailView.js';

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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Proton Drive Sync</title>
<style>
:root {
  --pds-mint: #cdfae4;
  --pds-lavender: #d0d8fc;
  --pds-card: #fcfdfe;
  --pds-ink: #2c3343;
  --pds-cyan: #2cd1ec;
  --pds-blue: #42aefc;
  --pds-line: #e4eaf3;
  --pds-muted: #5c6b80;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--pds-ink);
  font: 15px/1.45 ui-sans-serif, system-ui, sans-serif;
  background: linear-gradient(90deg, var(--pds-mint), var(--pds-lavender));
}
.wrap { max-width: 960px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
h1 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing: -0.02em; }
h2 { font-size: 1.05rem; margin: 0; }
.card {
  background: var(--pds-card);
  border-radius: 20px;
  padding: 1rem 1.15rem;
  margin: 0 0 .9rem;
  box-shadow: 0 10px 30px rgba(44, 51, 67, 0.08);
}
.status-row, .actions, .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .6rem; }
.pill, .btn, .note, .toolbar input { border-radius: 999px; }
.pill { display: inline-block; background: #e7f7ff; font-weight: 650; padding: .2rem .75rem; }
#glance { font-weight: 650; color: var(--pds-blue); }
#reason, .pager, .empty, .muted { color: var(--pds-muted); }
.reading { margin: .2rem 0; }
.btn {
  border: 1px solid #c9d4e4;
  background: #fff;
  color: var(--pds-ink);
  padding: .4rem .9rem;
  cursor: pointer;
}
.btn.primary { background: var(--pds-cyan); border-color: var(--pds-cyan); color: #07323a; font-weight: 650; }
.btn:disabled { opacity: .45; cursor: default; }
.toolbar { margin: .55rem 0 .7rem; }
.toolbar input { border: 1px solid #d5deea; padding: .35rem .8rem; min-width: 12rem; color: var(--pds-ink); background: #fff; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--pds-line); vertical-align: top; }
.bar { height: 8px; background: #e6eef8; border-radius: 999px; min-width: 6rem; }
.bar > div { height: 8px; background: var(--pds-blue); border-radius: 999px; }
.warn { background: #fff8e8; border-radius: 16px; padding: .8rem 1rem; }
.banner { background: #ffe8ea; color: #6d2430; border-radius: 16px; padding: .65rem 1rem; margin: 0 0 .9rem; }
.note { display: inline-block; background: #fff; padding: .15rem .65rem; }
pre { white-space: pre-wrap; word-break: break-word; margin: .4rem 0 0; font-size: .85rem; }
[hidden] { display: none !important; }
</style></head><body>
<main class="wrap">
<header class="card">
<h1>Proton Drive Sync</h1>
<p class="status-row"><span class="pill" id="state"></span><span id="glance"></span><span id="reason"></span></p>
<p id="flags"></p>
<p class="actions"><button type="button" class="btn" id="act-pause" onclick="act('pause')">Pause</button><button type="button" class="btn" id="act-resume" onclick="act('resume')">Resume</button><button type="button" class="btn" id="act-sync" onclick="act('sync')">Sync now</button></p>
</header>
<p id="action-error" class="banner" hidden></p>
<section class="card" id="held" hidden></section>
<section class="card" id="conflicts"></section>
<section class="card" id="quarantine"></section>
<section class="card" id="transfers"></section>
<section class="card" id="lines"></section>
<section class="card" id="proton-documents"></section>
<section class="card" id="recycle"></section>
</main>
<script>
${clientScript()}
</script></body></html>`;

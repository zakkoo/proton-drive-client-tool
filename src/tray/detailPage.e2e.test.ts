// @vitest-environment happy-dom
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineHarness } from '../testing/engineHarness.js';
import { DetailPageServer } from './detailPage.js';
import { applySnapshot, type DetailData } from './detailView.js';

/** A plain HTTP GET via node:http (happy-dom's fetch blocks cross-origin 127.0.0.1 requests). */
function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }); });
      })
      .on('error', reject);
  });
}

/**
 * End to end: after a real sync, the detail page's live snapshot (fetched from
 * the running server) rendered into the visible DOM shows the engine state and
 * file counts — it is not a blank shell (spec: tray-status-ui / Detail page is a
 * live view — Open details with files already synced).
 */

let h: EngineHarness;
let server: DetailPageServer;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  await server.close();
  await h.dispose();
});

describe('detail page after a sync', () => {
  it('the visible page shows the engine state and non-zero file counts', async () => {
    h.write('one.txt', '1');
    h.write('two.txt', '2');
    await h.start();
    await h.waitForConvergence();
    // Let the remote count settle as the feed reflects our uploads.
    for (let i = 0; i < 100 && h.live.engine.getStatus().counts.remoteFiles !== 2; i++) await new Promise((r) => setTimeout(r, 20));

    server = new DetailPageServer(h.live.controlTarget);
    await server.listen();

    // Fetch the live snapshot from the running server and render it into the page.
    const res = await httpGet(`${server.url}api/state`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as DetailData;

    document.body.innerHTML = `
      <span id="state"></span><span id="reason"></span>
      <span id="counts"></span><span id="lastsync"></span>
      <p id="lines"></p><div id="held"></div>
      <table id="transfers"></table><table id="conflicts"></table>
      <table id="quarantine"></table><table id="recycle"></table>`;
    applySnapshot(document, data);

    expect(document.getElementById('state')?.textContent).toBe('idle');
    expect(document.getElementById('counts')?.textContent).toBe('2 local · 2 remote · 2 synced');
    expect(document.getElementById('lastsync')?.textContent).not.toBe('never');
  });

  it('serves the page behind the run token and 404s an unknown token', async () => {
    await h.start();
    await h.waitFor(['idle']);
    server = new DetailPageServer(h.live.controlTarget);
    await server.listen();

    const ok = await httpGet(server.url);
    expect(ok.status).toBe(200);
    // The served page carries the tested renderer and the counts element.
    expect(ok.body).toContain('id="counts"');
    expect(ok.body).toContain('function applySnapshot');

    const bad = await httpGet(server.url.replace(server.token, 'deadbeef'));
    expect(bad.status).toBe(404);
  });
});

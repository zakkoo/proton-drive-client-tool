import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlClient, ControlServer } from './control.js';
import type { EngineStatus } from './status.js';
import { EngineHarness } from '../testing/engineHarness.js';

/**
 * Control socket resilience (spec: test-suite / Stop and restart — a second
 * start after a crash). A control socket file left behind by a dead process
 * must not stop the next process from listening, and status must work over the
 * fresh socket.
 */

let h: EngineHarness;
beforeEach(async () => {
  h = EngineHarness.create();
  await h.start();
  await h.waitFor(['idle', 'attention']);
});
afterEach(async () => {
  await h.dispose();
});

describe('stale control socket', () => {
  it('a leftover socket file from a dead process does not stop the next server, and status works', async () => {
    const sockPath = path.join(h.base, 'control.sock');
    // A crashed process leaves the socket path occupied.
    writeFileSync(sockPath, 'stale');
    expect(existsSync(sockPath)).toBe(true);

    const server = new ControlServer(sockPath, h.live.controlTarget);
    await server.listen(); // must clear the stale file and bind
    try {
      const client = new ControlClient(sockPath);
      await client.connect(2000);
      try {
        const status = await client.request<EngineStatus>({ cmd: 'status' });
        expect(['idle', 'attention', 'scanning', 'syncing', 'starting']).toContain(status.state);
        expect(status.counts).toBeDefined();
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
  });

  it('a still-listening socket is detected by probe so a second instance refuses to start', async () => {
    const sockPath = path.join(h.base, 'live.sock');
    const server = new ControlServer(sockPath, h.live.controlTarget);
    await server.listen();
    try {
      // A live server answers the probe (a second `run` uses this to refuse).
      expect(await ControlClient.probe(sockPath)).toBe(true);
    } finally {
      await server.close();
    }
    // Once closed, nothing answers.
    expect(await ControlClient.probe(sockPath)).toBe(false);
    // A path that was never a socket does not answer either.
    expect(await ControlClient.probe(path.join(h.base, 'never.sock'))).toBe(false);
  });
});

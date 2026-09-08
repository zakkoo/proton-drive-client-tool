import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretRegistry } from '../../audit/redact.js';
import { UnsafeFileSecretStore } from '../../config/secretStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, ProtonApiClient, SdkHttpClient } from './apiClient.js';
import { createLogger, silentSink } from './logger.js';
import { Credentials } from './sessionCredentials.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
let dir: string;
let creds: Credentials;
let sleeps: number[];

beforeEach(async () => {
  requests = [];
  sleeps = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-api-'));
  creds = new Credentials(new UnsafeFileSecretStore(dir, true, new SecretRegistry()), createLogger('t', silentSink), new SecretRegistry());
  await creds.setUserKeyPassword('kp');
  await creds.setSessionInfo({ uid: 'uid-1', accessToken: 'access-old', refreshToken: 'refresh-1' });
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => { r(); }));
  rmSync(dir, { recursive: true, force: true });
});

function client(extra: Partial<ConstructorParameters<typeof ProtonApiClient>[0]> = {}) {
  return new ProtonApiClient({
    baseUrl,
    appVersion: 'test@0.0.1',
    sdkVersion: '0.21.0',
    credentials: creds,
    logger: createLogger('api', silentSink),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    ...extra,
  });
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

describe('ProtonApiClient', () => {
  it('sends app version, sdk version, uid and bearer headers on authenticated requests', async () => {
    handler = (_req, res) => { json(res, 200, { Code: 1000 }); };
    const data = await client().requestJson<{ Code: number }>('/core/v4/users');
    expect(data.Code).toBe(1000);
    const h = requests[0]?.headers ?? {};
    expect(h['x-pm-appversion']).toBe('test@0.0.1');
    expect(h['x-pm-drive-sdk-version']).toBe('0.21.0');
    expect(h['x-pm-uid']).toBe('uid-1');
    expect(h.authorization).toBe('Bearer access-old');
    expect(requests[0]?.url).toBe('/core/v4/users');
  });

  it('omits session headers on unauthenticated requests and encodes search params', async () => {
    handler = (_req, res) => { json(res, 200, {}); };
    await client().request('/core/v4/keys/all', { authenticated: false, searchParams: { Email: 'a@b.c', InternalOnly: 1 } });
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.url).toBe('/core/v4/keys/all?Email=a%40b.c&InternalOnly=1');
  });

  it('refreshes the session once on 401 and retries with the new token', async () => {
    handler = (req, res) => {
      if (req.url === '/auth/v4/refresh') {
        json(res, 200, { UID: 'uid-1', AccessToken: 'access-new', RefreshToken: 'refresh-2' });
        return;
      }
      if (req.headers.authorization === 'Bearer access-new') json(res, 200, { ok: true });
      else json(res, 401, { Code: 401, Error: 'Invalid access token' });
    };
    const data = await client().requestJson<{ ok: boolean }>('/drive/v2/volumes');
    expect(data.ok).toBe(true);
    expect(requests.map((r) => r.url)).toEqual(['/drive/v2/volumes', '/auth/v4/refresh', '/drive/v2/volumes']);
    expect(JSON.parse(requests[1]?.body ?? '{}')).toMatchObject({ GrantType: 'refresh_token', RefreshToken: 'refresh-1' });
    expect(creds.accessToken).toBe('access-new');
    expect(creds.refreshToken).toBe('refresh-2');
  });

  it('performs a single refresh for concurrent 401s', async () => {
    let refreshes = 0;
    handler = (req, res) => {
      if (req.url === '/auth/v4/refresh') {
        refreshes++;
        setTimeout(() => { json(res, 200, { AccessToken: 'access-new' }); }, 20);
        return;
      }
      if (req.headers.authorization === 'Bearer access-new') json(res, 200, { ok: true });
      else json(res, 401, {});
    };
    const c = client();
    const results = await Promise.all([c.requestJson('/a'), c.requestJson('/b'), c.requestJson('/c')]);
    expect(results).toHaveLength(3);
    expect(refreshes).toBe(1);
  });

  it('signs out when the refresh is rejected with a 4xx, and returns the original 401', async () => {
    handler = (req, res) => {
      if (req.url === '/auth/v4/refresh') json(res, 400, { Code: 10013, Error: 'Invalid refresh token' });
      else json(res, 401, { Code: 401 });
    };
    const response = await client().request('/drive/v2/volumes');
    expect(response.status).toBe(401);
    expect(creds.isLoggedIn()).toBe(false);
    expect(creds.accessToken).toBeUndefined();
  });

  it('does not attempt refresh for auth endpoints themselves', async () => {
    handler = (_req, res) => { json(res, 401, {}); };
    await client().request('/core/v4/auth/info', { method: 'POST', json: {} });
    expect(requests.map((r) => r.url)).toEqual(['/core/v4/auth/info']);
  });

  it('pauses for Retry-After on 429, reports throttling, then retries (any method)', async () => {
    let n = 0;
    const throttle: string[] = [];
    handler = (_req, res) => {
      n++;
      if (n === 1) json(res, 429, { Code: 85131 }, { 'retry-after': '7' });
      else json(res, 200, { ok: true });
    };
    const data = await client({ onThrottle: (s) => throttle.push(s) }).requestJson<{ ok: boolean }>('/x', { method: 'POST', json: {} });
    expect(data.ok).toBe(true);
    expect(sleeps).toEqual([7000]);
    expect(throttle).toEqual(['throttled', 'unthrottled']);
    expect(n).toBe(2);
  });

  it('retries idempotent requests on 5xx with exponential backoff and gives up after maxAttempts', async () => {
    handler = (_req, res) => { json(res, 503, {}); };
    const response = await client({ maxAttempts: 3 }).request('/x');
    expect(response.status).toBe(503);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries GET on 500 but never retries POST on 500', async () => {
    let n = 0;
    handler = (_req, res) => {
      n++;
      json(res, n === 1 ? 500 : 200, { n });
    };
    const c = client();
    const ok = await c.requestJson<{ n: number }>('/get');
    expect(ok.n).toBe(2);
    n = 0;
    requests = [];
    const response = await c.request('/post', { method: 'POST', json: { a: 1 } });
    expect(response.status).toBe(500);
    expect(requests).toHaveLength(1);
  });

  it('returns 4xx other than throttling immediately, and requestJson throws ApiError with the Proton code', async () => {
    handler = (_req, res) => { json(res, 422, { Code: 2501, Error: 'Not found' }); };
    const c = client();
    const response = await c.request('/x');
    expect(response.status).toBe(422);
    expect(requests).toHaveLength(1);
    await expect(c.requestJson('/x')).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.status === 422 && e.code === 2501);
  });

  it('times out non-idempotent requests without retrying', async () => {
    handler = () => undefined; // never respond
    await expect(client().request('/slow', { method: 'POST', json: {}, timeoutMs: 50 })).rejects.toThrow(/timeout|aborted/i);
    expect(requests).toHaveLength(1);
  });

  it('honours the caller abort signal', async () => {
    handler = () => undefined;
    const ac = new AbortController();
    const p = client().request('/slow', { signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    await expect(p).rejects.toThrow('user cancelled');
  });

  it('exposes the SDK HTTP client interface', async () => {
    handler = (_req, res) => { json(res, 200, { via: 'sdk' }); };
    const sdk = new SdkHttpClient(client());
    const r = await sdk.fetchJson({ url: `${baseUrl}/drive/x`, method: 'POST', headers: new Headers(), json: { q: 1 }, timeoutMs: 5000 });
    expect(await r.json()).toEqual({ via: 'sdk' });
    expect(requests[0]?.headers['x-pm-uid']).toBe('uid-1');
    expect(requests[0]?.body).toBe('{"q":1}');
  });
});

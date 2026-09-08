import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretRegistry } from '../../audit/redact.js';
import { UnsafeFileSecretStore } from '../../config/secretStore.js';
import { AccountApi } from './accountApi.js';
import { ProtonApiClient } from './apiClient.js';
import { Auth, LoginError } from './auth.js';
import { encryptForkPayload, generateSignInUrl, parseUserKeyPassword } from './authWeb.js';
import { createLogger, silentSink } from './logger.js';
import { Credentials } from './sessionCredentials.js';
import { SessionState } from './sessionState.js';
import { Srp, type SrpPrimitives } from './srpModule.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let baseUrl: string;
let handler: Handler;
let requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
let dir: string;
let store: UnsafeFileSecretStore;
let creds: Credentials;
let registry: SecretRegistry;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

beforeEach(async () => {
  requests = [];
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
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-auth-'));
  registry = new SecretRegistry();
  store = new UnsafeFileSecretStore(dir, true, registry);
  creds = new Credentials(store, createLogger('t', silentSink), registry);
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => { r(); }));
  rmSync(dir, { recursive: true, force: true });
});

const fakeSrp: SrpPrimitives = {
  getSrp: (info, password) =>
    Promise.resolve({ clientEphemeral: `eph(${info.ServerEphemeral})`, clientProof: `proof(${password})`, expectedServerProof: 'server-proof-ok' }),
  computeKeyPassword: (password, salt) => Promise.resolve(`kp:${salt}:${password.length}`),
};

function makeAuth(opts: { accountUrl?: string } = {}) {
  const api = new ProtonApiClient({ baseUrl, appVersion: 'test', credentials: creds, logger: createLogger('api', silentSink), sleep: () => Promise.resolve() });
  const accountApi = new AccountApi(api);
  const srp = new Srp(accountApi, fakeSrp);
  let t = 0;
  const auth = new Auth(accountApi, srp, creds, createLogger('auth', silentSink), {
    authClientId: 'external-drive',
    accountUrl: opts.accountUrl ?? 'account.example.test',
    sleep: () => Promise.resolve(),
    now: () => (t += 1000),
    maxPollTimeMs: 30_000,
  });
  return { auth, api };
}

describe('authWeb payload', () => {
  it('round-trips the encrypted fork payload and rejects tampering', () => {
    const { encryptionKey, signInUrl } = generateSignInUrl('external-drive', 'USER-CODE', 'account.example.test');
    expect(signInUrl.startsWith('https://account.example.test/desktop/login?app=drive&pv=3#payload=')).toBe(true);
    expect(decodeURIComponent(signInUrl.split('#payload=')[1] ?? '')).toBe(`0:USER-CODE:${encryptionKey.toString('base64')}:external-drive`);
    const payload = encryptForkPayload(JSON.stringify({ type: 'default', keyPassword: 'derived-key-pw' }), encryptionKey);
    expect(parseUserKeyPassword(encryptionKey, payload)).toBe('derived-key-pw');
    const tampered = Buffer.from(payload, 'base64');
    tampered[15] = (tampered[15] ?? 0) ^ 0xff;
    expect(() => parseUserKeyPassword(encryptionKey, tampered.toString('base64'))).toThrow();
    expect(() => parseUserKeyPassword(encryptionKey, encryptForkPayload(JSON.stringify({ type: 'x' }), encryptionKey))).toThrow(/deserialize/);
  });
});

describe('Auth.loginViaWeb', () => {
  it('polls until approved, stores key password and session, and never echoes secrets', async () => {
    let polls = 0;
    let capturedKey: Buffer | undefined;
    const shown: string[] = [];
    handler = (req, res) => {
      if (req.url === '/auth/v4/sessions/forks') { json(res, 200, { Code: 1000, Selector: 'sel-1', UserCode: 'UC-1' }); return; }
      if (req.url === '/auth/v4/sessions/forks/sel-1') {
        polls++;
        if (polls < 3) { json(res, 422, { Code: 2011, Error: 'Not ready' }); return; }
        if (capturedKey === undefined) throw new Error('key not captured');
        json(res, 200, {
          Code: 1000,
          UID: 'uid-web',
          AccessToken: 'access-web',
          RefreshToken: 'refresh-web',
          Payload: encryptForkPayload(JSON.stringify({ keyPassword: 'kp-web' }), capturedKey),
        }); return;
      }
      json(res, 404, {});
    };
    const { auth } = makeAuth();
    const session = await auth.loginViaWeb((url) => {
      shown.push(url);
      const payload = decodeURIComponent(url.split('#payload=')[1] ?? '');
      capturedKey = Buffer.from(payload.split(':')[2] ?? '', 'base64');
    });
    expect(session).toEqual({ uid: 'uid-web', accessToken: 'access-web', refreshToken: 'refresh-web' });
    expect(polls).toBe(3);
    expect(creds.isLoggedIn()).toBe(true);
    expect(creds.getUserKeyPassword()).toBe('kp-web');
    const file = JSON.parse(readFileSync(store.file, 'utf8')) as { session: string };
    const stored = JSON.parse(file.session) as { userKeyPassword: string; session: { uid: string } };
    expect(stored.userKeyPassword).toBe('kp-web');
    expect(stored.session.uid).toBe('uid-web');
    // Secrets are registered for redaction.
    expect(registry.redactString('token access-web kp kp-web')).toBe('token [REDACTED] kp [REDACTED]');
    // The sign-in URL is the only thing shown to the user.
    expect(shown).toHaveLength(1);
  });

  it('times out when the user never approves', async () => {
    handler = (req, res) => {
      if (req.url === '/auth/v4/sessions/forks') { json(res, 200, { Selector: 's', UserCode: 'u' }); return; }
      json(res, 422, { Code: 2011 });
    };
    const { auth } = makeAuth();
    await expect(auth.loginViaWeb(() => undefined)).rejects.toSatisfy((e: unknown) => e instanceof LoginError && e.reason === 'timeout');
    expect(creds.isLoggedIn()).toBe(false);
  });
});

describe('Auth.loginViaPassword', () => {
  const infoResponse = { Code: 1000, Modulus: 'MOD', ServerEphemeral: 'SE', Version: 4, Salt: 'SALT', SRPSession: 'SRPS' };

  it('runs SRP, verifies the server proof, derives the key password and persists the session', async () => {
    handler = (req, res, body) => {
      switch (req.url ?? '') {
        case '/core/v4/auth/info':
          { json(res, 200, infoResponse); return; }
        case '/core/v4/auth': {
          const b = JSON.parse(body) as { ClientProof: string; ClientEphemeral: string; SRPSession: string };
          expect(b.ClientProof).toBe('proof(secret-pw)');
          expect(b.ClientEphemeral).toBe('eph(SE)');
          expect(b.SRPSession).toBe('SRPS');
          json(res, 200, { Code: 1000, UID: 'uid-pw', AccessToken: 'access-pw', RefreshToken: 'refresh-pw', ServerProof: 'server-proof-ok', '2FA': { Enabled: 0 } }); return;
        }
        case '/core/v4/keys/salts':
          expect(req.headers.authorization).toBe('Bearer access-pw');
          { json(res, 200, { Code: 1000, KeySalts: [{ ID: 'k1', KeySalt: 'KS' }] }); return; }
        default:
          { json(res, 404, {}); return; }
      }
    };
    const { auth } = makeAuth();
    const session = await auth.loginViaPassword('user@example.test', 'secret-pw');
    expect(session.uid).toBe('uid-pw');
    expect(creds.getUserKeyPassword()).toBe('kp:KS:9');
    expect(creds.isLoggedIn()).toBe(true);
    // The login password itself is never sent or stored.
    expect(requests.map((r) => r.body).join('')).not.toContain('secret-pw"');
    expect(readFileSync(store.file, 'utf8')).not.toContain('secret-pw');
  });

  it('rejects a wrong server proof without storing anything', async () => {
    handler = (req, res) => {
      if (req.url === '/core/v4/auth/info') { json(res, 200, infoResponse); return; }
      if (req.url === '/core/v4/auth') { json(res, 200, { UID: 'u', AccessToken: 'a', ServerProof: 'WRONG' }); return; }
      json(res, 404, {});
    };
    const { auth } = makeAuth();
    await expect(auth.loginViaPassword('u', 'p')).rejects.toSatisfy((e: unknown) => e instanceof LoginError && e.reason === 'server_proof_mismatch');
    expect(creds.isLoggedIn()).toBe(false);
  });

  it('maps a rejected proof to invalid_credentials', async () => {
    handler = (req, res) => {
      if (req.url === '/core/v4/auth/info') { json(res, 200, infoResponse); return; }
      if (req.url === '/core/v4/auth') { json(res, 422, { Code: 8002, Error: 'Incorrect login credentials' }); return; }
      json(res, 404, {});
    };
    const { auth } = makeAuth();
    await expect(auth.loginViaPassword('u', 'p')).rejects.toSatisfy((e: unknown) => e instanceof LoginError && e.reason === 'invalid_credentials');
  });

  it('requires and submits a TOTP code when 2FA is enabled, and fails cleanly without one', async () => {
    let twoFaBody = '';
    handler = (req, res, body) => {
      switch (req.url ?? '') {
        case '/core/v4/auth/info':
          { json(res, 200, infoResponse); return; }
        case '/core/v4/auth':
          { json(res, 200, { UID: 'uid-2fa', AccessToken: 'access-2fa', ServerProof: 'server-proof-ok', '2FA': { Enabled: 1, TOTP: 1 } }); return; }
        case '/core/v4/auth/2fa':
          twoFaBody = body;
          expect(req.headers.authorization).toBe('Bearer access-2fa');
          { json(res, 200, { Code: 1000, Scope: 'full' }); return; }
        case '/core/v4/keys/salts':
          { json(res, 200, { KeySalts: [{ ID: 'k', KeySalt: 'KS' }] }); return; }
        default:
          { json(res, 404, {}); return; }
      }
    };
    const { auth } = makeAuth();
    await expect(auth.loginViaPassword('u', 'p')).rejects.toSatisfy((e: unknown) => e instanceof LoginError && e.reason === 'second_factor_required');
    expect(creds.isLoggedIn()).toBe(false);
    await auth.loginViaPassword('u', 'p', () => Promise.resolve('123456'));
    expect(JSON.parse(twoFaBody)).toEqual({ TwoFactorCode: '123456' });
    expect(creds.isLoggedIn()).toBe(true);
  });
});

describe('SessionState', () => {
  it('resumes a stored session without any network call', async () => {
    await creds.setUserKeyPassword('kp');
    await creds.setSessionInfo({ uid: 'u', accessToken: 'a', refreshToken: 'r' });
    const fresh = new Credentials(store, createLogger('t', silentSink), registry);
    const state = new SessionState(fresh, createLogger('s', silentSink));
    expect(state.current).toBe('needs_login');
    expect(await state.resume()).toBe('logged_in');
    expect(requests).toHaveLength(0);
  });

  it('enters needs_login when the remote rejects the session, clearing credentials and notifying, with no other side effects', async () => {
    await creds.setUserKeyPassword('kp');
    await creds.setSessionInfo({ uid: 'u', accessToken: 'a', refreshToken: 'r' });
    handler = (req, res) => {
      if (req.url === '/auth/v4/refresh') { json(res, 400, { Code: 10013, Error: 'Invalid refresh token' }); return; }
      json(res, 401, { Code: 401, Error: 'Invalid access token' });
    };
    const { api } = makeAuth();
    const state = new SessionState(creds, createLogger('s', silentSink));
    const events: string[] = [];
    state.onChange((s, reason) => events.push(`${s}:${reason ?? ''}`));
    let caught: unknown;
    try {
      await api.requestJson('/drive/v2/volumes');
    } catch (e) {
      caught = e;
    }
    expect(await state.handleRemoteError(caught)).toBe(true);
    expect(state.current).toBe('needs_login');
    expect(creds.isLoggedIn()).toBe(false);
    expect(events).toContain('needs_login:session cleared');
    // Only the failing request and the refresh attempt were made; nothing mutating.
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /drive/v2/volumes', 'POST /auth/v4/refresh']);
    expect(await state.handleRemoteError(new Error('disk full'))).toBe(false);
  });

  it('starts logged out when nothing is stored', async () => {
    const state = new SessionState(creds, createLogger('s', silentSink));
    expect(await state.resume()).toBe('needs_login');
  });
});

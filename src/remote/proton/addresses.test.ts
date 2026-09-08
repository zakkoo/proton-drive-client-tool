import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrivateKeyReference, PublicKeyReference } from '@protontech/crypto';

import { SecretRegistry } from '../../audit/redact.js';
import { UnsafeFileSecretStore } from '../../config/secretStore.js';
import { AccountApi } from './accountApi.js';
import { Addresses, SIGNED_AND_VALID, type KeyCrypto } from './addresses.js';
import { ProtonApiClient } from './apiClient.js';
import { createLogger, silentSink } from './logger.js';
import { Credentials } from './sessionCredentials.js';

let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let dir: string;
let creds: Credentials;
let calls: string[];

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Fake key crypto: keys are strings; "armored:<name>:<passphrase>" unlocks only with the right passphrase. */
const fakeCrypto: KeyCrypto = {
  importPrivateKey: ({ armoredKey, passphrase }) => {
    const [, name, expected] = armoredKey.split(':');
    if (expected !== passphrase) return Promise.reject(new Error(`wrong passphrase for ${name ?? '?'}`));
    return Promise.resolve(`priv:${name ?? '?'}` as unknown as PrivateKeyReference);
  },
  importPublicKey: (opts) => {
    if ('armoredKey' in opts) return Promise.resolve(`pub:${opts.armoredKey}` as unknown as PublicKeyReference);
    return Promise.resolve(`pub:${Buffer.from(opts.binaryKey).toString()}` as unknown as PublicKeyReference);
  },
  exportPublicKey: ({ key }) => Promise.resolve(new Uint8Array(Buffer.from((key as unknown as string).replace('priv:', '')))),
  decryptMessage: ({ armoredMessage, armoredSignature, decryptionKeys }) => {
    calls.push(`decrypt:${armoredMessage}`);
    if (!decryptionKeys.includes('priv:user1' as unknown as PrivateKeyReference)) return Promise.reject(new Error('no key'));
    return Promise.resolve({ data: `tok(${armoredMessage})`, verificationStatus: armoredSignature === 'good-sig' ? SIGNED_AND_VALID : 0 });
  },
};

beforeEach(async () => {
  calls = [];
  server = createServer((req, res) => { handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-addr-'));
  const registry = new SecretRegistry();
  creds = new Credentials(new UnsafeFileSecretStore(dir, true, registry), createLogger('t', silentSink), registry);
  await creds.setUserKeyPassword('user-kp');
  await creds.setSessionInfo({ uid: 'u', accessToken: 'a' });
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => { r(); }));
  rmSync(dir, { recursive: true, force: true });
});

function addresses() {
  const api = new ProtonApiClient({ baseUrl, appVersion: 'test', credentials: creds, logger: createLogger('api', silentSink) });
  return new Addresses(new AccountApi(api), creds, fakeCrypto, createLogger('addr', silentSink));
}

const users = { Code: 1000, User: { ID: 'user', Keys: [{ ID: 'uk1', PrivateKey: 'armored:user1:user-kp', Primary: 1 }, { ID: 'uk-old', PrivateKey: 'armored:userold:other-pw' }] } };
const addrs = {
  Code: 1000,
  Addresses: [
    {
      ID: 'addr1',
      Email: 'me@proton.test',
      Keys: [
        { ID: 'ak1', PrivateKey: 'armored:addr1key:tok(TOKEN1)', Token: 'TOKEN1', Signature: 'good-sig', Primary: 1 },
        { ID: 'ak-bad', PrivateKey: 'armored:bad:tok(TOKEN2)', Token: 'TOKEN2', Signature: 'bad-sig' },
        { ID: 'ak-legacy', PrivateKey: 'armored:legacy:user-kp' },
      ],
    },
    { ID: 'addr2', Email: 'alias@proton.test', Keys: [{ ID: 'ak2', PrivateKey: 'armored:addr2key:tok(TOKEN3)', Token: 'TOKEN3', Signature: 'good-sig' }] },
  ],
};

describe('Addresses', () => {
  it('unlocks user keys with the key password, then address keys via verified tokens, skipping unverifiable ones', async () => {
    handler = (req, res) => {
      if (req.url === '/core/v4/users') { json(res, 200, users); return; }
      if (req.url?.startsWith('/core/v4/addresses')) { json(res, 200, addrs); return; }
      json(res, 404, {});
    };
    const a = addresses();
    const primary = await a.getOwnPrimaryAddress();
    expect(primary.email).toBe('me@proton.test');
    expect(primary.addressId).toBe('addr1');
    // ak-bad fails signature verification and is excluded; the legacy key unlocks with the key password.
    expect(primary.keys.map((k) => k.id)).toEqual(['ak1', 'ak-legacy']);
    expect(primary.keys[0]?.key).toBe('priv:addr1key');
    const all = await a.getOwnAddresses();
    expect(all.map((x) => x.email)).toEqual(['me@proton.test', 'alias@proton.test']);
    expect(await a.getOwnAddress('alias@proton.test')).toMatchObject({ addressId: 'addr2' });
    // Address keys are decrypted once and cached.
    expect(calls.filter((c) => c === 'decrypt:TOKEN1')).toHaveLength(1);
  });

  it('returns own public keys for own emails and fetches others via the keys endpoint, empty when the address is unknown', async () => {
    handler = (req, res) => {
      if (req.url === '/core/v4/users') { json(res, 200, users); return; }
      if (req.url?.startsWith('/core/v4/addresses')) { json(res, 200, addrs); return; }
      if (req.url?.startsWith('/core/v4/keys/all?Email=friend')) { json(res, 200, { Address: { Keys: [{ PublicKey: 'F1' }, { PublicKey: 'F2' }] } }); return; }
      if (req.url?.startsWith('/core/v4/keys/all?Email=nobody')) { json(res, 422, { Code: 33102, Error: 'Address does not exist' }); return; }
      json(res, 404, {});
    };
    const a = addresses();
    expect(await a.getPublicKeys('me@proton.test')).toEqual(['pub:addr1key', 'pub:legacy']);
    expect(await a.getPublicKeys('friend@proton.test')).toEqual(['pub:F1', 'pub:F2']);
    expect(await a.hasProtonAccount('nobody@proton.test')).toBe(false);
  });

  it('fails clearly when no user key can be unlocked (stale key password) and when logged out', async () => {
    handler = (req, res) => {
      if (req.url === '/core/v4/users') { json(res, 200, { User: { Keys: [{ ID: 'uk1', PrivateKey: 'armored:user1:different-pw' }] } }); return; }
      json(res, 404, {});
    };
    const a = addresses();
    await expect(a.getOwnPrimaryAddress()).rejects.toThrow(/No user key could be unlocked/);
    await creds.signOut();
    expect(await a.getPublicKeys('anyone@proton.test')).toEqual([]);
    await expect(a.getOwnPrimaryAddress()).rejects.toThrow(/Not logged in/);
  });
});

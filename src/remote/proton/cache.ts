/**
 * SDK caches on node:sqlite, encrypted at rest. Port of `cli/src/cache`.
 *
 * Values are encrypted with HKDF-SHA256 + AES-256-GCM keyed from the random
 * cache password kept in the secret store. Losing the cache is harmless: the
 * SDK rebuilds it from the server.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access --
   SessionKey/PrivateKey types come from @protontech/crypto through generated declarations that the
   linter's project service cannot fully resolve; tsc type-checks this file without errors. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CryptoProxy } from '@protontech/crypto';
import type { CachedCryptoMaterial, EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';

type PrivateKey = NonNullable<CachedCryptoMaterial['publicShareKey']>['key'];
type SessionKey = NonNullable<CachedCryptoMaterial['shareKey']>['passphraseSessionKey'];

async function importUnlockedKey(armoredKey: string): Promise<PrivateKey> {
  const key: unknown = await CryptoProxy.importPrivateKey({ armoredKey, passphrase: null });
  return key as PrivateKey;
}

import type { Logger } from './logger.js';

const CONTEXT = Buffer.from('Drive.EncryptedCacheRepository', 'utf8');
const IV_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function encryptCacheValue(cacheKey: string, plaintext: string, ikm: Buffer): string {
  const salt = randomBytes(SALT_BYTES);
  const info = Buffer.concat([CONTEXT, Buffer.from(cacheKey, 'utf8')]);
  const derived = Buffer.from(hkdfSync('sha256', ikm, salt, info, KEY_BYTES + IV_BYTES));
  const cipher = createCipheriv('aes-256-gcm', derived.subarray(0, KEY_BYTES), derived.subarray(KEY_BYTES), { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([salt, ciphertext, cipher.getAuthTag()]).toString('base64');
}

export function decryptCacheValue(cacheKey: string, encryptedBase64: string, ikm: Buffer): string {
  const combined = Buffer.from(encryptedBase64, 'base64');
  if (combined.length < SALT_BYTES + TAG_BYTES) throw new Error('Invalid encrypted cache value');
  const salt = combined.subarray(0, SALT_BYTES);
  const ciphertext = combined.subarray(SALT_BYTES, combined.length - TAG_BYTES);
  const tag = combined.subarray(combined.length - TAG_BYTES);
  const info = Buffer.concat([CONTEXT, Buffer.from(cacheKey, 'utf8')]);
  const derived = Buffer.from(hkdfSync('sha256', ikm, salt, info, KEY_BYTES + IV_BYTES));
  const decipher = createDecipheriv('aes-256-gcm', derived.subarray(0, KEY_BYTES), derived.subarray(KEY_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export class SqliteCache implements ProtonDriveCache<string> {
  protected readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS entities_labels (label TEXT NOT NULL, key TEXT NOT NULL, UNIQUE (label, key))');
    this.db.exec('CREATE INDEX IF NOT EXISTS entities_labels_label ON entities_labels (label)');
  }

  clear(): Promise<void> {
    this.db.exec('DELETE FROM entities; DELETE FROM entities_labels;');
    return Promise.resolve();
  }

  setEntity(key: string, data: string, tags?: string[]): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO entities (key, value) VALUES (?, ?)').run(key, data);
      this.db.prepare('DELETE FROM entities_labels WHERE key = ?').run(key);
      const insert = this.db.prepare('INSERT OR REPLACE INTO entities_labels (label, key) VALUES (?, ?)');
      for (const tag of tags ?? []) insert.run(tag, key);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return Promise.resolve();
  }

  getEntity(key: string): Promise<string> {
    const row = this.db.prepare('SELECT value FROM entities WHERE key = ?').get(key) as { value: string } | undefined;
    if (row === undefined) return Promise.reject(new Error(`Entity ${key} not found`));
    return Promise.resolve(row.value);
  }

  async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<string>> {
    for (const key of keys) {
      try {
        yield { key, ok: true, value: await this.getEntity(key) };
      } catch (error) {
        yield { key, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
    const rows = this.db.prepare('SELECT key FROM entities_labels WHERE label = ?').all(tag) as { key: string }[];
    yield* this.iterateEntities(rows.map((r) => r.key));
  }

  removeEntities(keys: string[]): Promise<void> {
    const del1 = this.db.prepare('DELETE FROM entities WHERE key = ?');
    const del2 = this.db.prepare('DELETE FROM entities_labels WHERE key = ?');
    for (const key of keys) {
      del1.run(key);
      del2.run(key);
    }
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}

export class EncryptedSqliteCache extends SqliteCache {
  private keyMaterial: Promise<Buffer> | undefined;

  constructor(
    file: string,
    private readonly getPassword: () => Promise<string>,
    private readonly logger: Logger,
  ) {
    super(file);
  }

  override async setEntity(key: string, data: string, tags?: string[]): Promise<void> {
    await super.setEntity(key, encryptCacheValue(key, data, await this.material()), tags);
  }

  override async getEntity(key: string): Promise<string> {
    const encrypted = await super.getEntity(key);
    try {
      return decryptCacheValue(key, encrypted, await this.material());
    } catch (error) {
      this.logger.error(`Cache entry ${key} cannot be decrypted; clearing cache`, error);
      await this.clear();
      throw new Error(`Entity ${key} not found`);
    }
  }

  private material(): Promise<Buffer> {
    this.keyMaterial ??= this.getPassword()
      .then((p) => Buffer.from(p, 'base64'))
      .catch((error: unknown) => {
        this.keyMaterial = undefined;
        throw error;
      });
    return this.keyMaterial;
  }
}

const CRYPTO_CACHE_VERSION = 2;

interface SerializedSessionKey {
  dataBase64: string;
  algorithm: number;
  aeadAlgorithm?: number;
}

interface SerializedCryptoMaterial {
  v: number;
  nodeKeys?: {
    passphrase: string;
    armoredPrivateKey: string;
    passphraseSessionKey: SerializedSessionKey;
    contentKeyPacket?: string;
    contentKeyPacketSessionKey?: SerializedSessionKey;
    hashKeyBase64?: string;
  };
  shareKey?: { armoredPrivateKey: string; passphraseSessionKey: SerializedSessionKey };
  publicShareKey?: { armoredPrivateKey: string };
}

function serializeSessionKey(sk: SessionKey): SerializedSessionKey {
  return {
    dataBase64: Buffer.from(sk.data).toString('base64'),
    algorithm: sk.algorithm,
    ...(sk.aeadAlgorithm !== undefined ? { aeadAlgorithm: sk.aeadAlgorithm } : {}),
  };
}

function deserializeSessionKey(s: SerializedSessionKey): SessionKey {
  const out: SessionKey = {
    data: new Uint8Array(Buffer.from(s.dataBase64, 'base64')),
    algorithm: s.algorithm as unknown as SessionKey['algorithm'],
  };
  if (s.aeadAlgorithm !== undefined) out.aeadAlgorithm = s.aeadAlgorithm;
  return out;
}

async function serializeCryptoMaterial(value: CachedCryptoMaterial): Promise<string> {
  const out: SerializedCryptoMaterial = { v: CRYPTO_CACHE_VERSION };
  if (value.nodeKeys) {
    const nk = value.nodeKeys;
    out.nodeKeys = {
      passphrase: nk.passphrase,
      armoredPrivateKey: await CryptoProxy.exportPrivateKey({ privateKey: nk.key, passphrase: null }),
      passphraseSessionKey: serializeSessionKey(nk.passphraseSessionKey),
      ...(nk.contentKeyPacket ? { contentKeyPacket: Buffer.from(nk.contentKeyPacket).toString('base64') } : {}),
      ...(nk.contentKeyPacketSessionKey ? { contentKeyPacketSessionKey: serializeSessionKey(nk.contentKeyPacketSessionKey) } : {}),
      ...(nk.hashKey ? { hashKeyBase64: Buffer.from(nk.hashKey).toString('base64') } : {}),
    };
  }
  if (value.shareKey) {
    out.shareKey = {
      armoredPrivateKey: await CryptoProxy.exportPrivateKey({ privateKey: value.shareKey.key, passphrase: null }),
      passphraseSessionKey: serializeSessionKey(value.shareKey.passphraseSessionKey),
    };
  }
  if (value.publicShareKey) {
    out.publicShareKey = { armoredPrivateKey: await CryptoProxy.exportPrivateKey({ privateKey: value.publicShareKey.key, passphrase: null }) };
  }
  return JSON.stringify(out);
}

async function deserializeCryptoMaterial(json: string): Promise<CachedCryptoMaterial> {
  const parsed = JSON.parse(json) as SerializedCryptoMaterial;
  if (parsed.v !== CRYPTO_CACHE_VERSION) throw new Error(`Unsupported crypto cache version ${String(parsed.v)}`);
  const value: CachedCryptoMaterial = {};
  if (parsed.nodeKeys) {
    const nk = parsed.nodeKeys;
    value.nodeKeys = {
      passphrase: nk.passphrase,
      key: await importUnlockedKey(nk.armoredPrivateKey),
      passphraseSessionKey: deserializeSessionKey(nk.passphraseSessionKey),
      ...(nk.contentKeyPacket !== undefined ? { contentKeyPacket: new Uint8Array(Buffer.from(nk.contentKeyPacket, 'base64')) } : {}),
      ...(nk.contentKeyPacketSessionKey !== undefined ? { contentKeyPacketSessionKey: deserializeSessionKey(nk.contentKeyPacketSessionKey) } : {}),
      ...(nk.hashKeyBase64 !== undefined ? { hashKey: new Uint8Array(Buffer.from(nk.hashKeyBase64, 'base64')) } : {}),
    };
  }
  if (parsed.shareKey) {
    value.shareKey = {
      key: await importUnlockedKey(parsed.shareKey.armoredPrivateKey),
      passphraseSessionKey: deserializeSessionKey(parsed.shareKey.passphraseSessionKey),
    };
  }
  if (parsed.publicShareKey) {
    value.publicShareKey = { key: await importUnlockedKey(parsed.publicShareKey.armoredPrivateKey) };
  }
  return value;
}

/** Serialises crypto material to JSON so it can live in the (encrypted) string cache. */
export class CryptoCacheAdapter implements ProtonDriveCache<CachedCryptoMaterial> {
  constructor(private readonly cache: ProtonDriveCache<string>) {}

  async setEntity(key: string, value: CachedCryptoMaterial, tags?: string[]): Promise<void> {
    await this.cache.setEntity(key, await serializeCryptoMaterial(value), tags);
  }

  async getEntity(key: string): Promise<CachedCryptoMaterial> {
    return deserializeCryptoMaterial(await this.cache.getEntity(key));
  }

  async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<CachedCryptoMaterial>> {
    for await (const r of this.cache.iterateEntities(keys)) yield await this.convert(r);
  }

  async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<CachedCryptoMaterial>> {
    for await (const r of this.cache.iterateEntitiesByTag(tag)) yield await this.convert(r);
  }

  private async convert(r: EntityResult<string>): Promise<EntityResult<CachedCryptoMaterial>> {
    if (!r.ok) return r;
    try {
      return { key: r.key, ok: true, value: await deserializeCryptoMaterial(r.value) };
    } catch (error) {
      return { key: r.key, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  clear(): Promise<void> {
    return this.cache.clear();
  }

  removeEntities(keys: string[]): Promise<void> {
    return this.cache.removeEntities(keys);
  }
}

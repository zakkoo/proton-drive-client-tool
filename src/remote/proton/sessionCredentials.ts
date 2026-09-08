/**
 * Session state shared by the API client, the auth flow and the SDK account
 * adapter. Port of `cli/src/credentials` and the account module's
 * `SessionCredentials` interface, backed by our SecretStore.
 */
import { randomBytes } from 'node:crypto';

import { secretRegistry, type SecretRegistry } from '../../audit/redact.js';
import type { SecretStore } from '../../config/secretStore.js';
import type { Logger } from './logger.js';

export interface SessionInfo {
  uid: string;
  accessToken: string;
  refreshToken?: string;
}

export interface StoredCredentials {
  /** Random key material for the encrypted SDK caches. */
  cachePassword?: string;
  /** Derived password unlocking the user's private keys. */
  userKeyPassword: string;
  session: SessionInfo;
}

export const SESSION_SECRET_NAME = 'session';

export interface SessionCredentials {
  readonly uid: string | undefined;
  readonly accessToken: string | undefined;
  readonly refreshToken: string | undefined;
  on(event: 'sessionInfoChanged', callback: () => void): void;
  isLoggedIn(): boolean;
  getUserKeyPassword(): string | undefined;
  load(): Promise<void>;
  setUserKeyPassword(userKeyPassword: string): Promise<void>;
  setSessionInfo(info: SessionInfo): Promise<void>;
  signOut(): Promise<void>;
}

export function parseStoredCredentials(raw: string | null): StoredCredentials | null {
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  const session = c['session'];
  if (typeof session !== 'object' || session === null) return null;
  const s = session as Record<string, unknown>;
  if (typeof c['userKeyPassword'] !== 'string' || c['userKeyPassword'] === '') return null;
  if (typeof s['uid'] !== 'string' || s['uid'] === '' || typeof s['accessToken'] !== 'string' || s['accessToken'] === '') return null;
  if (s['refreshToken'] !== undefined && typeof s['refreshToken'] !== 'string') return null;
  if (c['cachePassword'] !== undefined && typeof c['cachePassword'] !== 'string') return null;
  return {
    ...(typeof c['cachePassword'] === 'string' ? { cachePassword: c['cachePassword'] } : {}),
    userKeyPassword: c['userKeyPassword'],
    session: {
      uid: s['uid'],
      accessToken: s['accessToken'],
      ...(typeof s['refreshToken'] === 'string' ? { refreshToken: s['refreshToken'] } : {}),
    },
  };
}

export class Credentials implements SessionCredentials {
  private cachePassword: string | undefined;
  private userKeyPassword: string | undefined;
  private sessionInfo: SessionInfo | undefined;
  private readonly callbacks = new Set<() => void>();

  constructor(
    private readonly store: SecretStore,
    private readonly logger: Logger,
    private readonly registry: SecretRegistry = secretRegistry,
  ) {}

  on(_event: 'sessionInfoChanged', callback: () => void): void {
    this.callbacks.add(callback);
  }

  isLoggedIn(): boolean {
    return this.userKeyPassword !== undefined && this.sessionInfo !== undefined;
  }

  getUserKeyPassword(): string | undefined {
    return this.userKeyPassword;
  }

  async getCachePassword(): Promise<string> {
    if (this.cachePassword === undefined) {
      this.cachePassword = randomBytes(32).toString('base64');
      this.registry.register(this.cachePassword);
      await this.persist();
    }
    return this.cachePassword;
  }

  get uid(): string | undefined {
    return this.sessionInfo?.uid;
  }
  get accessToken(): string | undefined {
    return this.sessionInfo?.accessToken;
  }
  get refreshToken(): string | undefined {
    return this.sessionInfo?.refreshToken;
  }

  async load(): Promise<void> {
    const raw = await this.store.get(SESSION_SECRET_NAME);
    const parsed = parseStoredCredentials(raw);
    if (parsed === null) {
      if (raw !== null) this.logger.warn('Stored session is malformed and will be ignored');
      else this.logger.debug('No stored session');
      return;
    }
    this.cachePassword = parsed.cachePassword;
    this.userKeyPassword = parsed.userKeyPassword;
    this.sessionInfo = parsed.session;
    this.registerSecrets();
    this.notify();
  }

  async setUserKeyPassword(userKeyPassword: string): Promise<void> {
    this.userKeyPassword = userKeyPassword;
    this.registerSecrets();
    await this.persist();
    this.notify();
  }

  async setSessionInfo(info: SessionInfo): Promise<void> {
    this.sessionInfo = info;
    this.registerSecrets();
    await this.persist();
    this.notify();
  }

  async signOut(): Promise<void> {
    this.logger.info('Signing out: clearing stored session');
    this.userKeyPassword = undefined;
    this.sessionInfo = undefined;
    this.cachePassword = undefined;
    await this.store.delete(SESSION_SECRET_NAME);
    this.notify();
  }

  private registerSecrets(): void {
    this.registry.register(this.userKeyPassword);
    this.registry.register(this.cachePassword);
    this.registry.register(this.sessionInfo?.accessToken);
    this.registry.register(this.sessionInfo?.refreshToken);
    this.registry.register(this.sessionInfo?.uid);
  }

  private async persist(): Promise<void> {
    if (this.userKeyPassword === undefined || this.sessionInfo === undefined) return;
    const data: StoredCredentials = {
      ...(this.cachePassword !== undefined ? { cachePassword: this.cachePassword } : {}),
      userKeyPassword: this.userKeyPassword,
      session: this.sessionInfo,
    };
    await this.store.set(SESSION_SECRET_NAME, JSON.stringify(data));
  }

  private notify(): void {
    for (const cb of this.callbacks) {
      try {
        cb();
      } catch (error) {
        this.logger.error('sessionInfoChanged listener failed', error);
      }
    }
  }
}

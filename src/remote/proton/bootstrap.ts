/**
 * Wires credentials, HTTP, auth, crypto, caches and the SDK into a runtime.
 * Port of `cli/src/init.ts`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { OpenPGPCryptoWithCryptoProxy, ProtonDriveClient, VERSION as SDK_VERSION, type OpenPGPCrypto } from '@protontech/drive-sdk';

import type { AppPaths } from '../../config/paths.js';
import type { SecretStore } from '../../config/secretStore.js';
import type { RemoteDrive } from '../interface.js';
import { SdkRemoteDrive } from '../sdkRemoteDrive.js';
import { AccountApi } from './accountApi.js';
import { Addresses, type KeyCrypto } from './addresses.js';
import { ProtonApiClient, SdkHttpClient, type ThrottleListener } from './apiClient.js';
import { Auth } from './auth.js';
import { CryptoCacheAdapter, EncryptedSqliteCache } from './cache.js';
import { createLogger, type Logger, type LogLevel, type LogSink } from './logger.js';
import { Credentials } from './sessionCredentials.js';
import { SessionState } from './sessionState.js';
import { Srp } from './srpModule.js';

/**
 * Sent as `x-pm-appversion`. Proton validates `<platform>-<product>@<version>` and the
 * browser-login fork is only approvable when the platform matches the auth client id
 * (`external-drive`). Mirrors the official CLI's third-party default
 * (`external-drive-sdkclijs@<version>`, see ProtonDriveApps/sdk cli/scripts/build-cli.mjs).
 * Verified live 2026-09-08: `proton-*` and `linux-drive@*` are rejected outright and
 * `web-drive@5.2.0.0` creates a fork the browser approval never attaches to.
 */
export const APP_VERSION = 'external-drive-sdkclijs@0.1.0';
const CLIENT_UID_PREFIX = 'proton-drive-sync';
const DEFAULT_BASE_URL = 'drive-api.proton.me';

export interface CursorStore {
  getLatestEventId(scopeId: string): Promise<string | null>;
}

export interface RuntimeOptions {
  paths: AppPaths;
  secretStore: SecretStore;
  logSink?: LogSink;
  logLevel?: LogLevel;
  baseUrl?: string;
  onThrottle?: ThrottleListener;
  /** Lets the SDK resume its event subscriptions from our persisted cursors. */
  cursorStore?: CursorStore;
}

export interface ProtonDriveRuntime {
  logger: Logger;
  credentials: Credentials;
  api: ProtonApiClient;
  auth: Auth;
  session: SessionState;
  sdk: ProtonDriveClient;
  remote: RemoteDrive;
  sdkVersion: string;
  clearCaches(): Promise<void>;
  dispose(): Promise<void>;
}

function accountUrlFromBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith('drive-api.')) return baseUrl.replace(/^drive-api\./, 'account.');
  return baseUrl.endsWith('.black') ? 'account.proton.black' : 'account.proton.me';
}

function getOrCreateClientUid(dataDir: string, logger: Logger): string {
  const file = path.join(dataDir, 'clientUid.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { clientUid?: unknown };
      if (typeof parsed.clientUid === 'string' && parsed.clientUid.startsWith(`${CLIENT_UID_PREFIX}-`)) return parsed.clientUid;
    } catch (error) {
      logger.error('Could not read client UID file; generating a new one', error);
    }
  }
  const clientUid = `${CLIENT_UID_PREFIX}-${randomUUID()}`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ clientUid }, null, 2) + '\n', { mode: 0o600 });
  return clientUid;
}

let cryptoInitialised = false;
function initOpenPgp(): OpenPGPCrypto {
  if (!cryptoInitialised) {
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    cryptoInitialised = true;
  }
  // The SDK's own class differs from its interface only under exactOptionalPropertyTypes.
  return new OpenPGPCryptoWithCryptoProxy(CryptoProxy) as unknown as OpenPGPCrypto;
}

export async function createProtonDriveRuntime(options: RuntimeOptions): Promise<ProtonDriveRuntime> {
  const { paths } = options;
  for (const dir of [paths.dataDir, paths.cacheDir, paths.stateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = (component: string): Logger => createLogger(component, options.logSink, options.logLevel);
  const logger = log('runtime');
  const baseUrl = options.baseUrl ?? process.env['PROTON_DRIVE_BASE_URL'] ?? DEFAULT_BASE_URL;

  const credentials = new Credentials(options.secretStore, log('credentials'));
  const api = new ProtonApiClient({
    baseUrl,
    appVersion: APP_VERSION,
    sdkVersion: SDK_VERSION,
    credentials,
    logger: log('http'),
    ...(options.onThrottle !== undefined ? { onThrottle: options.onThrottle } : {}),
  });
  const accountApi = new AccountApi(api);
  const srp = new Srp(accountApi);
  const auth = new Auth(accountApi, srp, credentials, log('auth'), { authClientId: 'external-drive', accountUrl: accountUrlFromBaseUrl(baseUrl) });
  const session = new SessionState(credentials, log('session'));
  await session.resume();

  const openPGPCryptoModule = initOpenPgp();
  const addresses = new Addresses(accountApi, credentials, CryptoProxy as unknown as KeyCrypto, log('addresses'));

  const entitiesCache = new EncryptedSqliteCache(path.join(paths.cacheDir, 'cache-entities.sqlite'), () => credentials.getCachePassword(), log('cache'));
  const cryptoStringCache = new EncryptedSqliteCache(path.join(paths.cacheDir, 'cache-crypto.sqlite'), () => credentials.getCachePassword(), log('cache'));
  const cryptoCache = new CryptoCacheAdapter(cryptoStringCache);

  const sdk = new ProtonDriveClient({
    httpClient: new SdkHttpClient(api),
    entitiesCache,
    cryptoCache,
    account: addresses,
    openPGPCryptoModule,
    srpModule: srp,
    config: { baseUrl, clientUid: getOrCreateClientUid(paths.dataDir, logger) },
    telemetry: { getLogger: (name: string) => log(`sdk:${name}`), recordMetric: () => undefined },
    ...(options.cursorStore !== undefined ? { latestEventIdProvider: options.cursorStore } : {}),
  });

  const remote = new SdkRemoteDrive(sdk, log('remote'));

  return {
    logger,
    credentials,
    api,
    auth,
    session,
    sdk,
    remote,
    sdkVersion: SDK_VERSION,
    clearCaches: async () => {
      await Promise.allSettled([entitiesCache.clear(), cryptoCache.clear()]);
    },
    dispose: () => {
      entitiesCache.close();
      cryptoStringCache.close();
      return Promise.resolve();
    },
  };
}

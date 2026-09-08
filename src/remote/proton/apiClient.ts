/**
 * HTTP client for the Proton API.
 *
 * Port of the account module's `apiClient.ts` (session headers, single-flight
 * token refresh on 401) with an explicit, testable policy for:
 *  - throttling (429 / 503 with Retry-After): wait and retry, any method
 *  - transient failures (408, 500, 502, 504, network errors, timeouts):
 *    exponential backoff with jitter, idempotent methods only
 *  - other 4xx: returned immediately, never retried
 *
 * Mutating requests are never retried after an unknown outcome here; that is
 * the RemoteDrive layer's job, which re-reads the node first.
 */
import type { ProtonDriveHTTPClient, ProtonDriveHTTPClientBlobRequest, ProtonDriveHTTPClientJsonRequest } from '@protontech/drive-sdk';

import type { Logger } from './logger.js';
import type { SessionCredentials } from './sessionCredentials.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

export type ThrottleListener = (state: 'throttled' | 'unthrottled', waitMs?: number) => void;

export interface ApiClientOptions {
  /** Host with or without scheme, e.g. drive-api.proton.me */
  baseUrl: string;
  appVersion: string;
  sdkVersion?: string;
  credentials: SessionCredentials;
  logger: Logger;
  fetch?: typeof fetch;
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable random for jitter. */
  random?: () => number;
  maxAttempts?: number;
  onThrottle?: ThrottleListener;
  /** Called with every response, e.g. to inspect drive requirement headers. */
  onResponse?: (response: Response) => void;
}

export interface ApiRequest {
  method?: string;
  headers?: HeadersInit;
  json?: unknown;
  body?: BodyInit;
  timeoutMs?: number;
  signal?: AbortSignal;
  authenticated?: boolean;
  /** Query string parameters. */
  searchParams?: Record<string, string | number>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Proton API error code from the JSON body, when present. */
    readonly code: number | undefined,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403 || this.code === 401 || this.code === 10013;
  }
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function shouldSkipAuthRefreshForUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  return pathname.includes('/auth/v4/refresh') || pathname.includes('/auth/v4/sessions') || pathname.includes('/core/v4/auth');
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  return error.name === 'TypeError' || 'code' in error;
}

export class ProtonApiClient {
  readonly baseUrlWithProtocol: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private activeRefresh: Promise<boolean> | null = null;
  private throttledUntil = 0;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrlWithProtocol = /^https?:\/\//.test(options.baseUrl) ? options.baseUrl : `https://${options.baseUrl}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  url(pathname: string, searchParams?: Record<string, string | number>): string {
    const u = new URL(pathname.startsWith('http') ? pathname : `${this.baseUrlWithProtocol}${pathname.startsWith('/') ? '' : '/'}${pathname}`);
    for (const [k, v] of Object.entries(searchParams ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private buildHeaders(init: HeadersInit | undefined, authenticated: boolean, hasJson: boolean): Headers {
    const headers = new Headers(init);
    headers.set('x-pm-appversion', this.options.appVersion);
    if (this.options.sdkVersion !== undefined) headers.set('x-pm-drive-sdk-version', this.options.sdkVersion);
    if (!headers.has('accept')) headers.set('accept', 'application/vnd.protonmail.v1+json');
    if (hasJson && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (authenticated) {
      const { uid, accessToken } = this.options.credentials;
      if (uid !== undefined) headers.set('x-pm-uid', uid);
      if (accessToken !== undefined) headers.set('authorization', `Bearer ${accessToken}`);
    }
    return headers;
  }

  /**
   * Perform a request. Resolves with the Response for any HTTP status once the
   * retry policy is exhausted or the status is final. Rejects on abort, on a
   * timeout of a non-idempotent request, or on persistent network failure.
   */
  async request(pathnameOrUrl: string, req: ApiRequest = {}): Promise<Response> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = this.url(pathnameOrUrl, req.searchParams);
    const authenticated = req.authenticated ?? true;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body: BodyInit | undefined = req.json !== undefined ? JSON.stringify(req.json) : req.body;
    const idempotent = IDEMPOTENT_METHODS.has(method);
    let refreshed = false;

    for (let attempt = 1; ; attempt++) {
      await this.waitIfThrottled(req.signal);
      const headers = this.buildHeaders(req.headers, authenticated, req.json !== undefined);
      const signal = req.signal !== undefined ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, signal, redirect: 'error', ...(body !== undefined ? { body } : {}) });
      } catch (error) {
        if (req.signal?.aborted === true) throw error;
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        if ((timedOut || isNetworkError(error)) && idempotent && attempt < this.maxAttempts) {
          const wait = this.backoffMs(attempt);
          this.options.logger.warn(`${method} ${url} failed (${error instanceof Error ? error.name : 'error'}), retrying in ${wait}ms`);
          await this.sleep(wait, req.signal);
          continue;
        }
        throw error;
      }
      this.options.onResponse?.(response);

      if (response.status === 401 && authenticated && !refreshed && !shouldSkipAuthRefreshForUrl(url)) {
        const rejected = headers.get('authorization')?.slice('Bearer '.length);
        refreshed = true;
        if (await this.refreshSessionIfPossible(rejected)) {
          this.options.logger.info('Session refreshed, retrying request');
          continue;
        }
        return response;
      }

      // Throttling: 429 always, 503 only when the server says how long to wait.
      const retryAfter = parseRetryAfterMs(response);
      if (response.status === 429 || (response.status === 503 && retryAfter !== undefined)) {
        if (attempt >= this.maxAttempts * 2) return response;
        const wait = Math.min(retryAfter ?? this.backoffMs(attempt), MAX_RETRY_AFTER_MS);
        // Gate other requests for the same period; this request sleeps and then clears the gate.
        this.throttledUntil = Date.now() + wait;
        this.options.onThrottle?.('throttled', wait);
        this.options.logger.warn(`${method} ${url} throttled (${response.status}), waiting ${wait}ms`);
        await this.sleep(wait, req.signal);
        this.throttledUntil = 0;
        this.options.onThrottle?.('unthrottled');
        continue;
      }

      if (TRANSIENT_STATUSES.has(response.status) && idempotent && attempt < this.maxAttempts) {
        const wait = this.backoffMs(attempt);
        this.options.logger.warn(`${method} ${url} returned ${response.status}, retrying in ${wait}ms`);
        await this.sleep(wait, req.signal);
        continue;
      }

      return response;
    }
  }

  /** Request and parse JSON; throws ApiError on any non-2xx status. */
  async requestJson<T>(pathnameOrUrl: string, req: ApiRequest = {}): Promise<T> {
    const response = await this.request(pathnameOrUrl, req);
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const details = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
      const code = typeof details?.['Code'] === 'number' ? details['Code'] : undefined;
      const message = typeof details?.['Error'] === 'string' ? details['Error'] : `HTTP ${response.status}`;
      throw new ApiError(`${req.method ?? 'GET'} ${pathnameOrUrl}: ${message}`, response.status, code, parsed);
    }
    return parsed as T;
  }

  private backoffMs(attempt: number): number {
    const base = 500 * 2 ** (attempt - 1);
    return Math.round(base + this.random() * base);
  }

  private async waitIfThrottled(signal?: AbortSignal): Promise<void> {
    const wait = this.throttledUntil - Date.now();
    if (wait > 0) await this.sleep(wait, signal);
  }

  async refreshSessionIfPossible(rejectedAccessToken?: string): Promise<boolean> {
    const current = this.options.credentials.accessToken;
    if (current !== undefined && rejectedAccessToken !== undefined && current !== rejectedAccessToken) {
      this.options.logger.debug('Skipping session refresh, another request already refreshed the session');
      return true;
    }
    this.activeRefresh ??= this.performRefresh().finally(() => {
      this.activeRefresh = null;
    });
    return this.activeRefresh;
  }

  private async performRefresh(): Promise<boolean> {
    const { refreshToken, uid } = this.options.credentials;
    if (refreshToken === undefined || uid === undefined) {
      this.options.logger.warn('Cannot refresh session: no refresh token');
      return false;
    }
    const response = await this.request('/auth/v4/refresh', {
      method: 'POST',
      json: { ResponseType: 'token', GrantType: 'refresh_token', RefreshToken: refreshToken, RedirectURI: 'https://protonmail.ch' },
    });
    if (!response.ok) {
      this.options.logger.error(`Failed to refresh session: HTTP ${response.status}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // The session is gone for good; forget it so the engine enters "needs login".
        await this.options.credentials.signOut();
      }
      return false;
    }
    const data = (await response.json()) as { UID?: string; AccessToken?: string; RefreshToken?: string };
    if (typeof data.AccessToken !== 'string') {
      this.options.logger.error('Failed to refresh session: missing AccessToken');
      return false;
    }
    await this.options.credentials.setSessionInfo({
      uid: typeof data.UID === 'string' ? data.UID : uid,
      accessToken: data.AccessToken,
      refreshToken: typeof data.RefreshToken === 'string' ? data.RefreshToken : refreshToken,
    });
    return true;
  }
}

/** Adapter exposing the client through the SDK's HTTP interface. */
export class SdkHttpClient implements ProtonDriveHTTPClient {
  constructor(private readonly api: ProtonApiClient) {}

  fetchJson(options: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    return this.api.request(options.url, {
      method: options.method,
      headers: options.headers,
      ...(options.json !== undefined ? { json: options.json } : {}),
      ...(options.body !== undefined && options.json === undefined ? { body: options.body } : {}),
      timeoutMs: options.timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  fetchBlob(options: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    return this.api.request(options.url, {
      method: options.method,
      headers: options.headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      timeoutMs: options.timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }
}

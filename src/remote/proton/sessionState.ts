/**
 * Session lifecycle as seen by the engine: resume on start, and the
 * transition to "needs login" when the remote rejects the session.
 *
 * Nothing here touches local files or remote nodes; a rejected session only
 * clears the stored credentials and notifies listeners so the engine stops.
 */
import { ApiError } from './apiClient.js';
import type { Logger } from './logger.js';
import type { SessionCredentials } from './sessionCredentials.js';

export type SessionStatus = 'logged_in' | 'needs_login';

export type SessionListener = (status: SessionStatus, reason?: string) => void;

export class SessionState {
  private status: SessionStatus;
  private readonly listeners = new Set<SessionListener>();

  constructor(
    private readonly credentials: SessionCredentials,
    private readonly logger: Logger,
  ) {
    this.status = credentials.isLoggedIn() ? 'logged_in' : 'needs_login';
    credentials.on('sessionInfoChanged', () => {
      const next: SessionStatus = credentials.isLoggedIn() ? 'logged_in' : 'needs_login';
      if (next !== this.status) this.set(next, next === 'needs_login' ? 'session cleared' : undefined);
    });
  }

  get current(): SessionStatus {
    return this.status;
  }

  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load the stored session; returns the resulting status without any network call. */
  async resume(): Promise<SessionStatus> {
    await this.credentials.load();
    const next: SessionStatus = this.credentials.isLoggedIn() ? 'logged_in' : 'needs_login';
    if (next !== this.status) this.set(next);
    else this.logger.debug(`Session status: ${next}`);
    return this.status;
  }

  /**
   * Inspect an error from a remote call. If it means the session is no
   * longer valid, clear it and move to "needs login". Returns true when the
   * error was an auth failure.
   */
  async handleRemoteError(error: unknown): Promise<boolean> {
    if (!isSessionRejected(error)) return false;
    this.logger.warn('The remote rejected the session; login is required');
    if (this.credentials.isLoggedIn()) await this.credentials.signOut();
    if (this.status !== 'needs_login') this.set('needs_login', 'session rejected by server');
    return true;
  }

  private set(status: SessionStatus, reason?: string): void {
    this.status = status;
    this.logger.info(`Session status: ${status}${reason !== undefined ? ` (${reason})` : ''}`);
    for (const l of this.listeners) {
      try {
        l(status, reason);
      } catch (error) {
        this.logger.error('session listener failed', error);
      }
    }
  }
}

export function isSessionRejected(error: unknown): boolean {
  if (error instanceof ApiError) return error.isAuthError;
  if (typeof error === 'object' && error !== null) {
    const e = error as { statusCode?: unknown; status?: unknown; name?: unknown; code?: unknown };
    const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : undefined;
    if (status === 401) return true;
    if (e.code === 401 || e.code === 10013) return true;
  }
  return false;
}

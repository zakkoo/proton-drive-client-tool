/**
 * Login flows. Port of the account module's `auth.ts`.
 *
 * - `loginViaWeb`: session fork approved in the browser (default; Proton
 *   handles the password and any second factor on its own page).
 * - `loginViaPassword`: SRP password proof, optional TOTP second factor,
 *   key password derived locally from the login password and the key salt.
 *
 * Neither flow logs or persists the login password. Only the session tokens
 * and the derived key password are stored, in the secret store.
 */
import { defaultSleep } from './apiClient.js';
import type { AccountApi} from './accountApi.js';
import { AccountApiError } from './accountApi.js';
import {
  DEFAULT_PROTON_ACCOUNT_URL,
  FORK_INITIAL_DELAY_MS,
  FORK_MAX_POLL_TIME_MS,
  FORK_POLL_INTERVAL_MS,
  generateSignInUrl,
  parseUserKeyPassword,
} from './authWeb.js';
import type { Logger } from './logger.js';
import type { SessionCredentials, SessionInfo } from './sessionCredentials.js';
import type { Srp } from './srpModule.js';

export class LoginError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid_credentials' | 'second_factor_required' | 'second_factor_invalid' | 'server_proof_mismatch' | 'timeout' | 'unsupported' | 'api',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LoginError';
  }
}

export interface AuthOptions {
  authClientId: string;
  accountUrl?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  initialDelayMs?: number;
  maxPollTimeMs?: number;
}

export class Auth {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly accountApi: AccountApi,
    private readonly srp: Srp,
    private readonly credentials: SessionCredentials,
    private readonly logger: Logger,
    private readonly options: AuthOptions,
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  isLoggedIn(): boolean {
    return this.credentials.isLoggedIn();
  }

  async loadSession(): Promise<void> {
    await this.credentials.load();
  }

  async logout(): Promise<void> {
    if (this.credentials.isLoggedIn()) {
      try {
        await this.accountApi.revokeSession();
      } catch (error) {
        this.logger.warn(`Could not revoke the session remotely: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.credentials.signOut();
  }

  /**
   * Browser login. `onSignInUrl` receives the URL to show or open; the method
   * resolves once the user approved in the browser.
   */
  async loginViaWeb(onSignInUrl: (signInUrl: string) => void | Promise<void>, signal?: AbortSignal): Promise<SessionInfo> {
    this.logger.debug('Starting browser login (session fork)');
    const fork = await this.accountApi.sessionForksInit();
    const { encryptionKey, signInUrl } = generateSignInUrl(this.options.authClientId, fork.UserCode, this.options.accountUrl ?? DEFAULT_PROTON_ACCOUNT_URL);
    await onSignInUrl(signInUrl);

    await this.sleep(this.options.initialDelayMs ?? FORK_INITIAL_DELAY_MS, signal);
    const start = this.now();
    const maxPoll = this.options.maxPollTimeMs ?? FORK_MAX_POLL_TIME_MS;
    for (;;) {
      if (this.now() - start > maxPoll) throw new LoginError('Browser login timed out', 'timeout');
      let status;
      try {
        status = await this.accountApi.sessionForksStatus(fork.Selector);
      } catch (error) {
        if (error instanceof AccountApiError && error.httpCode === 422) {
          this.logger.debug('Browser login not yet approved');
          await this.sleep(this.options.pollIntervalMs ?? FORK_POLL_INTERVAL_MS, signal);
          continue;
        }
        throw new LoginError(`Browser login failed: ${error instanceof Error ? error.message : String(error)}`, 'api', { cause: error });
      }
      const userKeyPassword = parseUserKeyPassword(encryptionKey, status.Payload);
      const session: SessionInfo = {
        uid: status.UID,
        accessToken: status.AccessToken,
        ...(status.RefreshToken !== undefined ? { refreshToken: status.RefreshToken } : {}),
      };
      // Key password first so persistence has both pieces when the session lands.
      await this.credentials.setUserKeyPassword(userKeyPassword);
      await this.credentials.setSessionInfo(session);
      this.logger.info('Browser login successful');
      return session;
    }
  }

  /**
   * Password login. `getSecondFactor` is called when the account has TOTP
   * enabled; when it is not provided the login fails with
   * `second_factor_required` and the browser flow should be used.
   */
  async loginViaPassword(username: string, password: string, getSecondFactor?: () => Promise<string>): Promise<SessionInfo> {
    this.logger.debug('Starting password login');
    const info = await this.accountApi.info(username);
    if (!info.Version || !info.Modulus || !info.SRPSession || !info.ServerEphemeral || !info.Salt) {
      throw new LoginError('Missing required auth info fields', 'api');
    }
    const proofs = await this.srp.getSrp(info.Version, info.Modulus, info.ServerEphemeral, info.Salt, password);

    let authResponse;
    try {
      authResponse = await this.accountApi.auth({
        Username: username,
        SRPSession: info.SRPSession,
        PersistentCookies: 1,
        Payload: {},
        ClientProof: proofs.clientProof,
        ClientEphemeral: proofs.clientEphemeral,
      });
    } catch (error) {
      if (error instanceof AccountApiError && (error.httpCode === 422 || error.httpCode === 401 || error.code === 8002)) {
        throw new LoginError('Invalid username or password', 'invalid_credentials', { cause: error });
      }
      throw new LoginError(`Login failed: ${error instanceof Error ? error.message : String(error)}`, 'api', { cause: error });
    }
    if (!authResponse.ServerProof) throw new LoginError('Missing ServerProof', 'api');
    if (authResponse.ServerProof !== proofs.expectedServerProof) {
      throw new LoginError('Server proof verification failed; the server may be impersonated', 'server_proof_mismatch');
    }
    if (!authResponse.UID || !authResponse.AccessToken) throw new LoginError('Missing UID or AccessToken', 'api');

    const session: SessionInfo = {
      uid: authResponse.UID,
      accessToken: authResponse.AccessToken,
      ...(authResponse.RefreshToken !== undefined ? { refreshToken: authResponse.RefreshToken } : {}),
    };
    // The session is needed for the 2FA and salts calls; it is persisted only
    // once the key password is known (see Credentials.persist).
    await this.credentials.setSessionInfo(session);

    const twoFactor = authResponse['2FA'];
    if (twoFactor !== undefined && twoFactor.Enabled !== 0) {
      if ((twoFactor.Enabled & 1) === 0) {
        await this.credentials.signOut();
        throw new LoginError('This account requires a security key (FIDO2); use the browser login', 'unsupported');
      }
      if (getSecondFactor === undefined) {
        await this.credentials.signOut();
        throw new LoginError('This account requires a second factor; provide a TOTP code or use the browser login', 'second_factor_required');
      }
      const code = await getSecondFactor();
      try {
        await this.accountApi.twoFactor(code);
      } catch (error) {
        await this.credentials.signOut();
        throw new LoginError('Second factor rejected', 'second_factor_invalid', { cause: error });
      }
    }

    const salts = await this.accountApi.salts();
    const keySalt = salts.KeySalts?.[0]?.KeySalt;
    if (typeof keySalt !== 'string' || keySalt === '') {
      await this.credentials.signOut();
      throw new LoginError('Missing key salt', 'api');
    }
    const userKeyPassword = await this.srp.computeKeyPassword(password, keySalt);
    await this.credentials.setUserKeyPassword(userKeyPassword);
    this.logger.info('Password login successful');
    return session;
  }
}

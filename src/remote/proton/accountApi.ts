/**
 * Proton core/auth API calls used by login and key loading.
 * Port of the account module's `accountApi.ts` on top of ProtonApiClient.
 */
import { ApiError, type ProtonApiClient } from './apiClient.js';

const ADDRESS_MISSING_CODE = 33_102;
const DOMAIN_EXTERNAL_CODE = 33_103;

export class AccountApiError extends Error {
  readonly httpCode: number | undefined;
  readonly code: number | undefined;
  readonly debug: unknown;
  constructor(message: string, options: { httpCode?: number; code?: number; debug?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'AccountApiError';
    this.httpCode = options.httpCode;
    this.code = options.code;
    this.debug = options.debug;
  }
}
export class AddressNotFoundError extends AccountApiError {}

function toAccountApiError(error: unknown): AccountApiError {
  if (error instanceof AccountApiError) return error;
  if (error instanceof ApiError) {
    const opts = { httpCode: error.status, ...(error.code !== undefined ? { code: error.code } : {}), debug: error.details, cause: error };
    if (error.code === ADDRESS_MISSING_CODE || error.code === DOMAIN_EXTERNAL_CODE) return new AddressNotFoundError(error.message, opts);
    return new AccountApiError(error.message, opts);
  }
  return new AccountApiError(error instanceof Error ? error.message : String(error), { cause: error });
}

export interface AuthInfoResponse {
  Code: number;
  Modulus: string;
  ServerEphemeral: string;
  Version: number;
  Salt: string;
  SRPSession: string;
  Username?: string;
}

export interface AuthResponse {
  Code: number;
  UID: string;
  AccessToken: string;
  RefreshToken?: string;
  ServerProof: string;
  Scope?: string;
  PasswordMode?: number;
  '2FA'?: { Enabled: number; TOTP?: number; FIDO2?: unknown };
}

export interface SessionForkInitResponse {
  Code: number;
  Selector: string;
  UserCode: string;
}

export interface SessionForkStatusResponse {
  Code: number;
  Payload: string;
  UID: string;
  AccessToken: string;
  RefreshToken?: string;
}

export interface UserKey {
  ID: string;
  PrivateKey: string;
  Primary?: number;
  Active?: number;
}

export interface AddressKey {
  ID: string;
  PrivateKey?: string;
  Token?: string;
  Signature?: string;
  Primary?: number;
  Active?: number;
  Flags?: number;
}

export interface Address {
  ID: string;
  Email: string;
  Status?: number;
  Type?: number;
  Order?: number;
  Keys?: AddressKey[];
}

export class AccountApi {
  constructor(private readonly api: ProtonApiClient) {}

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toAccountApiError(error);
    }
  }

  sessionForksInit(): Promise<SessionForkInitResponse> {
    return this.call(() => this.api.requestJson('/auth/v4/sessions/forks', { authenticated: false }));
  }

  sessionForksStatus(selector: string): Promise<SessionForkStatusResponse> {
    return this.call(() => this.api.requestJson(`/auth/v4/sessions/forks/${encodeURIComponent(selector)}`, { authenticated: false }));
  }

  info(username: string): Promise<AuthInfoResponse> {
    return this.call(async () => {
      const response = await this.api.requestJson<Partial<AuthInfoResponse>>('/core/v4/auth/info', {
        method: 'POST',
        authenticated: false,
        json: { Intent: 'Proton', Username: username },
      });
      if (typeof response.Modulus !== 'string') throw new AccountApiError('Invalid auth info response', { debug: response });
      return response as AuthInfoResponse;
    });
  }

  auth(data: {
    Username: string;
    SRPSession: string;
    ClientEphemeral: string;
    ClientProof: string;
    PersistentCookies: number;
    Payload: Record<string, string>;
  }): Promise<AuthResponse> {
    return this.call(() => this.api.requestJson('/core/v4/auth', { method: 'POST', authenticated: false, json: data }));
  }

  /** Second factor (TOTP). Must be called with the session obtained from `auth`. */
  twoFactor(totpCode: string): Promise<{ Code: number; Scope?: string }> {
    return this.call(() => this.api.requestJson('/core/v4/auth/2fa', { method: 'POST', json: { TwoFactorCode: totpCode } }));
  }

  users(): Promise<{ Code: number; User?: { ID?: string; Name?: string; Keys?: UserKey[] } }> {
    return this.call(() => this.api.requestJson('/core/v4/users'));
  }

  addresses(): Promise<{ Code: number; Addresses?: Address[] }> {
    return this.call(() => this.api.requestJson('/core/v4/addresses', { searchParams: { Page: 0, PageSize: 50 } }));
  }

  salts(): Promise<{ Code: number; KeySalts?: { ID: string; KeySalt: string | null }[] }> {
    return this.call(() => this.api.requestJson('/core/v4/keys/salts'));
  }

  keys(email: string): Promise<{ Code: number; Address?: { Keys?: { PublicKey: string; Flags?: number }[] } }> {
    return this.call(() => this.api.requestJson('/core/v4/keys/all', { searchParams: { Email: email, InternalOnly: 1 } }));
  }

  modulus(): Promise<{ Code: number; Modulus?: string; ModulusID?: string }> {
    return this.call(() => this.api.requestJson('/core/v4/auth/modulus'));
  }

  revokeSession(): Promise<void> {
    return this.call(async () => {
      await this.api.request('/auth/v4', { method: 'DELETE' });
    });
  }
}

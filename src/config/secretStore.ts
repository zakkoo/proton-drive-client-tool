import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { secretRegistry, type SecretRegistry } from '../audit/redact.js';
import type { CredentialsStoreKind } from './schema.js';

/** Service name under which this application stores secrets. Never shared with the Proton CLI. */
export const SECRET_SERVICE = 'proton-drive-sync';

export interface SecretStore {
  readonly kind: CredentialsStoreKind;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class SecretStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretStoreUnavailableError';
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `secret-tool` with the given arguments; `stdin` is written to the process when provided. */
export type CommandRunner = (args: string[], stdin?: string) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile('secret-tool', args, { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new SecretStoreUnavailableError('secret-tool is not installed (package libsecret)', { cause: error }));
        return;
      }
      const code = error !== null && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error === null ? 0 : null;
      resolve({ code, stdout, stderr });
    });
    if (stdin !== undefined && child.stdin !== null) {
      child.stdin.end(stdin);
    }
  });

/**
 * OS secret store via libsecret's `secret-tool`. Entries are keyed by
 * (service, account) attributes; the service is specific to this application.
 */
export class SecretToolStore implements SecretStore {
  readonly kind = 'keychain' as const;
  constructor(
    private readonly run: CommandRunner = defaultRunner,
    private readonly service: string = SECRET_SERVICE,
    private readonly registry: SecretRegistry = secretRegistry,
  ) {}

  private attrs(name: string): string[] {
    return ['service', this.service, 'account', name];
  }

  private unavailable(result: CommandResult, action: string): SecretStoreUnavailableError {
    const detail = result.stderr.trim() || `exit code ${String(result.code)}`;
    return new SecretStoreUnavailableError(
      `Could not ${action} the OS secret store: ${detail}. ` +
        'A Secret Service (e.g. gnome-keyring-daemon or KWallet) must be running on the session D-Bus. ' +
        'The session is never written to plaintext unless credentialsStore is set to "unsafe_file" with acknowledgement.',
    );
  }

  async get(name: string): Promise<string | null> {
    const result = await this.run(['lookup', ...this.attrs(name)]);
    if (result.code === 0) {
      const value = result.stdout.replace(/\n$/, '');
      this.registry.register(value);
      return value;
    }
    // secret-tool exits 1 both for "not found" (silent) and for connection failures (message on stderr).
    if (result.code === 1 && result.stderr.trim() === '') return null;
    throw this.unavailable(result, 'read');
  }

  async set(name: string, value: string): Promise<void> {
    this.registry.register(value);
    const result = await this.run(['store', `--label=Proton Drive Sync (${name})`, ...this.attrs(name)], value);
    if (result.code !== 0) throw this.unavailable(result, 'write to');
  }

  async delete(name: string): Promise<void> {
    const result = await this.run(['clear', ...this.attrs(name)]);
    if (result.code !== 0 && !(result.code === 1 && result.stderr.trim() === '')) throw this.unavailable(result, 'delete from');
  }
}

/**
 * PLAINTEXT file store. Only constructible with an explicit acknowledgement;
 * the factory below refuses to create it otherwise. Intended for tests and
 * headless machines where the user has consciously accepted the risk.
 */
export class UnsafeFileSecretStore implements SecretStore {
  readonly kind = 'unsafe_file' as const;
  readonly file: string;

  constructor(dir: string, acknowledged: boolean, private readonly registry: SecretRegistry = secretRegistry) {
    if (!acknowledged) {
      throw new SecretStoreUnavailableError(
        'Refusing to store credentials in plaintext without acknowledgeUnsafeCredentialsStore: true',
      );
    }
    this.file = path.join(dir, 'credentials.UNSAFE-PLAINTEXT.json');
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  private write(data: Record<string, string>): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(name: string): Promise<string | null> {
    const value = this.read()[name] ?? null;
    if (value !== null) this.registry.register(value);
    return Promise.resolve(value);
  }

  set(name: string, value: string): Promise<void> {
    this.registry.register(value);
    const data = this.read();
    data[name] = value;
    this.write(data);
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    const data = this.read();
    if (name in data) {
      const remaining = Object.fromEntries(Object.entries(data).filter(([k]) => k !== name));
      if (Object.keys(remaining).length === 0) unlinkSync(this.file);
      else this.write(remaining);
    }
    return Promise.resolve();
  }
}

export function createSecretStore(
  options: { kind: CredentialsStoreKind; acknowledgeUnsafe: boolean; dataDir: string },
  runner: CommandRunner = defaultRunner,
): SecretStore {
  switch (options.kind) {
    case 'keychain':
      return new SecretToolStore(runner);
    case 'unsafe_file':
      return new UnsafeFileSecretStore(options.dataDir, options.acknowledgeUnsafe);
  }
}

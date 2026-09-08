import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretRegistry } from '../audit/redact.js';
import { saveConfigFile } from './configFile.js';
import { parseConfig } from './schema.js';
import {
  createSecretStore,
  defaultRunner,
  SecretStoreUnavailableError,
  SecretToolStore,
  UnsafeFileSecretStore,
  type CommandResult,
  type CommandRunner,
} from './secretStore.js';

/** In-memory stand-in for secret-tool with the same exit-code conventions. */
function fakeSecretTool(opts: { broken?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls: string[][] = [];
  const runner: CommandRunner = (args, stdin) => {
    calls.push(args);
    if (opts.broken) {
      return Promise.resolve<CommandResult>({ code: 1, stdout: '', stderr: 'secret-tool: Could not connect: No such file or directory\n' });
    }
    const [cmd] = args;
    const key = args.slice(args.indexOf('service')).join('|');
    if (cmd === 'lookup') {
      const v = store.get(key);
      return Promise.resolve<CommandResult>(v === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: v + '\n', stderr: '' });
    }
    if (cmd === 'store') {
      store.set(key, stdin ?? '');
      return Promise.resolve<CommandResult>({ code: 0, stdout: '', stderr: '' });
    }
    if (cmd === 'clear') {
      store.delete(key);
      return Promise.resolve<CommandResult>({ code: 0, stdout: '', stderr: '' });
    }
    return Promise.resolve<CommandResult>({ code: 2, stdout: '', stderr: 'unknown command' });
  };
  return { runner, store, calls };
}

describe('SecretToolStore', () => {
  it('round-trips a secret under the application service name and registers it for redaction', async () => {
    const fake = fakeSecretTool();
    const registry = new SecretRegistry();
    const s = new SecretToolStore(fake.runner, 'proton-drive-sync', registry);
    expect(await s.get('session')).toBeNull();
    await s.set('session', 'tok-123456789');
    expect(await s.get('session')).toBe('tok-123456789');
    expect(registry.size()).toBe(1);
    await s.delete('session');
    expect(await s.get('session')).toBeNull();
    for (const call of fake.calls) {
      expect(call).toContain('service');
      expect(call[call.indexOf('service') + 1]).toBe('proton-drive-sync');
      expect(call.join(' ')).not.toContain('drive-sdk-cli');
    }
  });

  it('reports an unavailable secret service instead of returning null or falling back', async () => {
    const s = new SecretToolStore(fakeSecretTool({ broken: true }).runner, 'proton-drive-sync', new SecretRegistry());
    await expect(s.get('session')).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    await expect(s.set('session', 'x')).rejects.toThrow(/Secret Service/);
    await expect(s.get('session')).rejects.toThrow(/never written to plaintext/);
  });
});

describe('UnsafeFileSecretStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pds-secrets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cannot be created without explicit acknowledgement', () => {
    expect(() => new UnsafeFileSecretStore(dir, false, new SecretRegistry())).toThrow(SecretStoreUnavailableError);
    expect(() => createSecretStore({ kind: 'unsafe_file', acknowledgeUnsafe: false, dataDir: dir })).toThrow(/acknowledge/);
  });

  it('round-trips with owner-only permissions, a clearly labelled file name, and removes the file when empty', async () => {
    const s = new UnsafeFileSecretStore(dir, true, new SecretRegistry());
    await s.set('session', 'abc-def-ghi');
    expect(path.basename(s.file)).toContain('UNSAFE');
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(await s.get('session')).toBe('abc-def-ghi');
    await s.delete('session');
    expect(existsSync(s.file)).toBe(false);
  });

  it('keeps secrets out of the configuration file', async () => {
    const cfgFile = path.join(dir, 'config.json');
    const cfg = parseConfig({
      localRoot: '/home/u/Drive',
      remoteRoot: '/my-files',
      credentialsStore: 'unsafe_file',
      acknowledgeUnsafeCredentialsStore: true,
    });
    saveConfigFile(cfgFile, cfg);
    const s = createSecretStore({ kind: cfg.credentialsStore, acknowledgeUnsafe: cfg.acknowledgeUnsafeCredentialsStore, dataDir: path.join(dir, 'data') });
    await s.set('session', 'SESSION-SECRET-VALUE');
    expect(readFileSync(cfgFile, 'utf8')).not.toContain('SESSION-SECRET-VALUE');
    expect(readdirSync(dir)).toEqual(['config.json', 'data']);
  });
});

/** Live round-trip against the real secret service, only when one is reachable. */
function secretServiceReachable(): boolean {
  try {
    execFileSync('secret-tool', ['lookup', 'service', 'proton-drive-sync-probe', 'account', 'probe'], { stdio: 'pipe' });
    return true;
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer };
    return e.status === 1 && (e.stderr?.toString() ?? '').trim() === '';
  }
}

describe.skipIf(!secretServiceReachable())('SecretToolStore (live secret service)', () => {
  it('stores, reads and clears a secret under our own service name', async () => {
    const s = new SecretToolStore(defaultRunner, 'proton-drive-sync-test', new SecretRegistry());
    const name = `it-${String(process.pid)}`;
    try {
      await s.set(name, 'live-secret-value');
      expect(await s.get(name)).toBe('live-secret-value');
    } finally {
      await s.delete(name);
    }
    expect(await s.get(name)).toBeNull();
  });
});

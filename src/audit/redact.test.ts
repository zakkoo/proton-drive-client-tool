import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AuditLog } from './logger.js';
import { redact, REDACTED, SecretRegistry } from './redact.js';

describe('redact', () => {
  it('replaces registered secrets anywhere in strings, nested objects and arrays', () => {
    const reg = new SecretRegistry();
    reg.register('hunter2-password');
    reg.register('acc-token-1234567890');
    const out = redact(
      {
        message: 'login failed for hunter2-password',
        nested: { list: ['acc-token-1234567890', 'safe'], deeper: { text: 'x hunter2-password y' } },
      },
      reg,
    ) as { message: string; nested: { list: string[]; deeper: { text: string } } };
    expect(out.message).toBe(`login failed for ${REDACTED}`);
    expect(out.nested.list).toEqual([REDACTED, 'safe']);
    expect(out.nested.deeper.text).toBe(`x ${REDACTED} y`);
  });

  it('redacts values under secret-looking keys regardless of content', () => {
    const out = redact(
      {
        password: 'p',
        accessToken: 'a',
        refresh_token: 'r',
        keyPassword: 'k',
        Authorization: 'Basic abc',
        privateKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nxx\n-----END PGP PRIVATE KEY BLOCK-----',
        srpVerifier: 'v',
        path: 'docs/token-plan.md',
      },
      new SecretRegistry(),
    ) as Record<string, string>;
    for (const k of ['password', 'accessToken', 'refresh_token', 'keyPassword', 'Authorization', 'privateKey', 'srpVerifier']) {
      expect(out[k]).toBe(REDACTED);
    }
    // A path value is not a secret even if the word "token" appears in it.
    expect(out['path']).toBe('docs/token-plan.md');
  });

  it('masks bearer tokens, JWT-like tokens and PGP armored blocks inside free text', () => {
    const reg = new SecretRegistry();
    const text = [
      'header Bearer abcDEF123.456_xyz-789 end',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end',
      '-----BEGIN PGP MESSAGE-----\nhQEMA\n-----END PGP MESSAGE-----',
    ].join('\n');
    const out = redact(text, reg) as string;
    expect(out).not.toContain('abcDEF123');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('hQEMA');
    expect(out.split(REDACTED).length - 1).toBe(3);
  });

  it('keeps digests, node uids and ordinary metadata intact', () => {
    const reg = new SecretRegistry();
    const out = redact(
      {
        digestAfter: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
        nodeUid: 'Ab3dEfGhIjKlMnOpQrStUv~Wx1yZ2aB3cD4eF5gH6iJ',
        size: 1234,
        when: new Date('2026-01-01T00:00:00Z'),
      },
      reg,
    ) as Record<string, unknown>;
    expect(out['digestAfter']).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(out['nodeUid']).toBe('Ab3dEfGhIjKlMnOpQrStUv~Wx1yZ2aB3cD4eF5gH6iJ');
    expect(out['size']).toBe(1234);
    expect(out['when']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('redacts Error messages and cuts cycles', () => {
    const reg = new SecretRegistry();
    reg.register('supersecretvalue');
    const err = new Error('failed with supersecretvalue');
    const cyc: Record<string, unknown> = { name: 'c' };
    cyc['self'] = cyc;
    const out = redact({ err, cyc }, reg) as { err: { message: string }; cyc: { self: string } };
    expect(out.err.message).toBe(`failed with ${REDACTED}`);
    expect(out.cyc.self).toBe('[Circular]');
  });

  it('never writes a registered token, password or key to the log file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-redact-'));
    try {
      const reg = new SecretRegistry();
      const token = 'sess-token-ABCDEFGHIJKLMNOP';
      const password = 'correct horse battery staple';
      const keyPassword = 'derived-key-password-xyz';
      reg.register(token);
      reg.register(password);
      reg.register(keyPassword);
      const log = new AuditLog({ dir, registry: reg });
      log.append({
        kind: 'auth',
        message: `session rejected: ${token}`,
        error: `bad password ${password}`,
        details: { keyPassword, headers: { Authorization: `Bearer ${token}` }, note: `kp=${keyPassword}` },
      });
      const text = readFileSync(log.activePath, 'utf8');
      expect(text).not.toContain(token);
      expect(text).not.toContain(password);
      expect(text).not.toContain(keyPassword);
      expect(text).toContain(REDACTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';

import { BOUNDS, ConfigError, DEFAULTS, parseConfig, withSetting, type BoundedKey } from './schema.js';

const minimal = { localRoot: '/home/u/Drive', remoteRoot: '/my-files' };

function problemsOf(raw: unknown): string[] {
  try {
    parseConfig(raw);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return [...e.problems];
    throw e;
  }
}

describe('parseConfig', () => {
  it('fills defaults and always includes the internal directory in ignore', () => {
    const cfg = parseConfig({ ...minimal, ignore: ['*.log'] });
    expect(cfg.safety).toEqual(DEFAULTS.safety);
    expect(cfg.transfers.concurrency).toBe(3);
    expect(cfg.ignore).toContain('*.log');
    expect(cfg.ignore).toContain('.proton-sync');
    expect(cfg.ignore).toContain('.proton-sync/**');
    expect(cfg.credentialsStore).toBe('keychain');
  });

  it('requires absolute local root and a POSIX remote folder below /', () => {
    expect(problemsOf({ localRoot: 'Drive', remoteRoot: '/my-files' })).toContainEqual(expect.stringContaining('absolute'));
    expect(problemsOf({ localRoot: '/x', remoteRoot: 'my-files' })).toContainEqual(expect.stringContaining('remoteRoot'));
    expect(problemsOf({ localRoot: '/x', remoteRoot: '/' })).toContainEqual(expect.stringContaining('below /'));
    expect(problemsOf({ localRoot: '/x', remoteRoot: '/my-files/' })).toContainEqual(expect.stringContaining('trailing'));
    expect(problemsOf({ localRoot: '/x', remoteRoot: '/my-files/../x' })).toContainEqual(expect.stringContaining('dot segments'));
    expect(problemsOf({ remoteRoot: '/my-files' })).toContainEqual(expect.stringContaining('localRoot is required'));
  });

  it('rejects a disabled brake (zero or unlimited)', () => {
    expect(problemsOf({ ...minimal, safety: { brakeMaxChanges: 0 } })).toContainEqual(expect.stringContaining('cannot be disabled'));
    expect(problemsOf({ ...minimal, safety: { brakeMaxChanges: Infinity } })).toContainEqual(expect.stringContaining('finite'));
    expect(problemsOf({ ...minimal, safety: { brakeMaxChangePercent: 100 } })).toContainEqual(
      expect.stringContaining('entire tree must always require confirmation'),
    );
    expect(problemsOf({ ...minimal, safety: { brakeMaxChangePercent: 0 } })).toContainEqual(expect.stringContaining('between'));
  });

  it('rejects every bounded value outside its range and non-integers', () => {
    for (const key of Object.keys(BOUNDS) as BoundedKey[]) {
      const [section, field] = key.split('.') as [string, string];
      const b = BOUNDS[key];
      expect(problemsOf({ ...minimal, [section]: { [field]: b.min - 1 } })).toContainEqual(expect.stringContaining(key));
      expect(problemsOf({ ...minimal, [section]: { [field]: b.max + 1 } })).toContainEqual(expect.stringContaining(key));
      expect(problemsOf({ ...minimal, [section]: { [field]: b.min + 0.5 } })).toContainEqual(expect.stringContaining('integer'));
      expect(problemsOf({ ...minimal, [section]: { [field]: 'x' } })).toContainEqual(expect.stringContaining(key));
      expect(problemsOf({ ...minimal, [section]: { [field]: b.min } })).toEqual([]);
      expect(problemsOf({ ...minimal, [section]: { [field]: b.max } })).toEqual([]);
    }
  });

  it('requires explicit acknowledgement for the plaintext credentials store', () => {
    expect(problemsOf({ ...minimal, credentialsStore: 'unsafe_file' })).toContainEqual(expect.stringContaining('PLAINTEXT'));
    expect(problemsOf({ ...minimal, credentialsStore: 'unsafe_file', acknowledgeUnsafeCredentialsStore: true })).toEqual([]);
    expect(problemsOf({ ...minimal, credentialsStore: 'file' })).toContainEqual(expect.stringContaining('credentialsStore'));
  });

  it('rejects unknown settings, bad flags and bad recorded identities', () => {
    expect(problemsOf({ ...minimal, bogus: 1 })).toContainEqual('unknown setting bogus');
    expect(problemsOf({ ...minimal, safety: { nope: 1 } })).toContainEqual('unknown setting safety.nope');
    expect(problemsOf({ ...minimal, dryRun: 'yes' })).toContainEqual('dryRun must be a boolean');
    expect(problemsOf({ ...minimal, localRootIdentity: { dev: 1 } })).toContainEqual(expect.stringContaining('localRootIdentity'));
    expect(problemsOf({ ...minimal, localRootIdentity: { dev: 1, ino: 2, fsKey: '' } })).toContainEqual(expect.stringContaining('localRootIdentity'));
    expect(problemsOf({ ...minimal, localRootIdentity: { dev: 59, ino: 605696, fsKey: 'btrfs:/dev/mapper/root:subvolid=257' } })).toEqual([]);
    expect(problemsOf({ ...minimal, remoteRootNodeUid: '' })).toContainEqual(expect.stringContaining('remoteRootNodeUid'));
    expect(problemsOf({ ...minimal, version: 2 })).toContainEqual(expect.stringContaining('version'));
    expect(problemsOf(null)).toEqual(['configuration must be an object']);
  });

  it('reports all problems at once', () => {
    const problems = problemsOf({ localRoot: 'rel', remoteRoot: '/', safety: { brakeMaxChanges: 0 }, dryRun: 1 });
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe('withSetting', () => {
  it('keeps the previous value in effect when the new one is out of bounds', () => {
    const cfg = parseConfig(minimal);
    const bad = withSetting(cfg, 'transfers.concurrency', 99);
    expect(bad.problems).toContainEqual(expect.stringContaining('transfers.concurrency'));
    expect(bad.config.transfers.concurrency).toBe(3);
    const good = withSetting(cfg, 'transfers.concurrency', 5);
    expect(good.problems).toEqual([]);
    expect(good.config.transfers.concurrency).toBe(5);
    expect(cfg.transfers.concurrency).toBe(3);
  });
});

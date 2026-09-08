import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfigFile, saveConfigFile } from './configFile.js';
import { resolveAppPaths } from './paths.js';
import { ConfigError, parseConfig } from './schema.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('config file', () => {
  it('round-trips, writes owner-only, leaves no temp file, and contains no secrets section', () => {
    const file = path.join(dir, 'cfg', 'config.json');
    const cfg = parseConfig({ localRoot: '/home/u/Drive', remoteRoot: '/my-files/Sync', dryRun: true });
    saveConfigFile(file, cfg);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(file))).toEqual(['config.json']);
    const loaded = loadConfigFile(file);
    expect(loaded).toEqual(cfg);
    const text = readFileSync(file, 'utf8');
    for (const word of ['password', 'token', 'secret', 'session']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it('returns null for a missing file and throws ConfigError for invalid JSON or invalid content', () => {
    const file = path.join(dir, 'config.json');
    expect(loadConfigFile(file)).toBeNull();
    writeFileSync(file, '{ not json');
    expect(() => loadConfigFile(file)).toThrow(ConfigError);
    writeFileSync(file, JSON.stringify({ localRoot: '/x', remoteRoot: '/my-files', safety: { brakeMaxChanges: 0 } }));
    expect(() => loadConfigFile(file)).toThrow(/cannot be disabled/);
  });
});

describe('resolveAppPaths', () => {
  it('follows XDG variables and the single-directory override', () => {
    const p = resolveAppPaths({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s', XDG_RUNTIME_DIR: '/r' }, '/home/u');
    expect(p.configFile).toBe('/c/proton-drive-sync/config.json');
    expect(p.stateDb).toBe('/d/proton-drive-sync/state.db');
    expect(p.auditLogDir).toBe('/s/proton-drive-sync/audit');
    expect(p.controlSocket).toBe('/r/proton-drive-sync/control.sock');
    const o = resolveAppPaths({ PROTON_DRIVE_SYNC_DIR: '/one' }, '/home/u');
    expect(o.configFile).toBe('/one/config/config.json');
    expect(o.stateDb).toBe('/one/data/state.db');
    const d = resolveAppPaths({}, '/home/u');
    expect(d.configFile).toBe('/home/u/.config/proton-drive-sync/config.json');
  });
});

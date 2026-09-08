import os from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'proton-drive-sync';

/** Name of the state area inside the sync root (temp files, recycle). Always ignored. */
export const INTERNAL_DIR_NAME = '.proton-sync';

export interface AppPaths {
  /** $XDG_CONFIG_HOME/proton-drive-sync */
  configDir: string;
  configFile: string;
  /** $XDG_DATA_HOME/proton-drive-sync (state database, lock) */
  dataDir: string;
  /** $XDG_CACHE_HOME/proton-drive-sync (encrypted SDK caches; safe to delete) */
  cacheDir: string;
  stateDb: string;
  /** $XDG_STATE_HOME/proton-drive-sync (audit and debug logs) */
  stateDir: string;
  auditLogDir: string;
  /** $XDG_RUNTIME_DIR/proton-drive-sync (control socket) */
  runtimeDir: string;
  controlSocket: string;
}

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): AppPaths {
  const override = env['PROTON_DRIVE_SYNC_DIR'];
  const configBase = override ?? env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
  const dataBase = override ?? env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share');
  const cacheBase = override ?? env['XDG_CACHE_HOME'] ?? path.join(home, '.cache');
  const stateBase = override ?? env['XDG_STATE_HOME'] ?? path.join(home, '.local', 'state');
  const runtimeBase = override ?? env['XDG_RUNTIME_DIR'] ?? path.join(os.tmpdir(), `proton-drive-sync-${String(process.getuid?.() ?? 'u')}`);

  const configDir = override !== undefined ? path.join(override, 'config') : path.join(configBase, APP_DIR_NAME);
  const dataDir = override !== undefined ? path.join(override, 'data') : path.join(dataBase, APP_DIR_NAME);
  const cacheDir = override !== undefined ? path.join(override, 'cache') : path.join(cacheBase, APP_DIR_NAME);
  const stateDir = override !== undefined ? path.join(override, 'state') : path.join(stateBase, APP_DIR_NAME);
  const runtimeDir = override !== undefined ? path.join(override, 'run') : path.join(runtimeBase, APP_DIR_NAME);

  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    dataDir,
    stateDb: path.join(dataDir, 'state.db'),
    cacheDir,
    stateDir,
    auditLogDir: path.join(stateDir, 'audit'),
    runtimeDir,
    controlSocket: path.join(runtimeDir, 'control.sock'),
  };
}

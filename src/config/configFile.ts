import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigError, parseConfig, type SyncConfig } from './schema.js';

/** Load and validate the configuration file. Returns null when it does not exist. */
export function loadConfigFile(file: string): SyncConfig | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError([`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseConfig(raw);
}

/**
 * Write the configuration atomically (temp file + rename) with owner-only
 * permissions. The config is re-validated before writing so an invalid object
 * can never reach disk.
 */
export function saveConfigFile(file: string, config: SyncConfig): void {
  const validated = parseConfig(config);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

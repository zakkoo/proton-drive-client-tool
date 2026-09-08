/**
 * Setup: validate the sync pair and record the identities the safety checks
 * depend on (remote root node uid, local root file-system identity).
 *
 * Re-running setup with a different pair never touches the old baseline or
 * recycle directory; the engine archives them on its next start.
 */
import type { RemoteDrive } from '../remote/interface.js';
import { loadConfigFile, saveConfigFile } from './configFile.js';
import { readRootIdentity, validateLocalRoot } from './localRoot.js';
import { ConfigError, parseConfig, type SyncConfig } from './schema.js';

export interface SetupInput {
  localRoot: string;
  remoteRoot: string;
  /** Existing configuration file path; read for previous roots and written on success. */
  configFile: string;
  remote: RemoteDrive;
  /** Extra settings to merge (e.g. dryRun, credentialsStore). */
  overrides?: Partial<Omit<SyncConfig, 'localRoot' | 'remoteRoot' | 'remoteRootNodeUid' | 'localRootIdentity'>>;
  home?: string;
}

export interface SetupResult {
  config: SyncConfig;
  /** True when the pair differs from the previously configured one (fresh baseline required). */
  pairChanged: boolean;
  previous: SyncConfig | null;
}

export async function runSetup(input: SetupInput): Promise<SetupResult> {
  const previous = loadConfigFile(input.configFile);
  const samePair = previous !== null && previous.localRoot === input.localRoot && previous.remoteRoot === input.remoteRoot;
  const existingRoots = previous !== null && !samePair ? [previous.localRoot] : [];

  const problems = validateLocalRoot(input.localRoot, { existingRoots, ...(input.home !== undefined ? { home: input.home } : {}) });
  if (problems.length > 0) throw new ConfigError(problems);

  const remoteNode = await input.remote.resolvePath(input.remoteRoot);
  if (remoteNode === null) throw new ConfigError([`remote folder ${input.remoteRoot} does not exist`]);
  if (remoteNode.type !== 'folder') throw new ConfigError([`remote path ${input.remoteRoot} is not a folder`]);
  if (remoteNode.isTrashed) throw new ConfigError([`remote folder ${input.remoteRoot} is in the trash`]);
  if (remoteNode.nameStatus !== 'ok') throw new ConfigError([`remote folder ${input.remoteRoot} has an undecryptable or invalid name`]);

  const config = parseConfig({
    ...(previous ?? {}),
    ...(input.overrides ?? {}),
    localRoot: input.localRoot,
    remoteRoot: input.remoteRoot,
    remoteRootNodeUid: remoteNode.uid,
    localRootIdentity: readRootIdentity(input.localRoot),
  });
  saveConfigFile(input.configFile, config);
  return { config, pairChanged: previous !== null && !samePair, previous };
}

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeRemote } from '../testing/fakeRemote.js';
import { loadConfigFile } from './configFile.js';
import { readRootIdentity } from './localRoot.js';
import { ConfigError } from './schema.js';
import { runSetup } from './setup.js';

let base: string;
let home: string;
let configFile: string;
let fake: FakeRemote;

beforeEach(() => {
  base = mkdtempSync(path.join(os.homedir(), '.cache', 'pds-setup-'));
  home = path.join(base, 'home');
  mkdirSync(path.join(home, 'Drive'), { recursive: true });
  mkdirSync(path.join(home, 'Other'), { recursive: true });
  configFile = path.join(base, 'cfg', 'config.json');
  fake = new FakeRemote();
  fake.seedFolder(fake.rootUid, 'Sync');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('runSetup', () => {
  it('records the remote root node uid and the local root identity in the config file', async () => {
    const local = path.join(home, 'Drive');
    const { config, pairChanged } = await runSetup({ localRoot: local, remoteRoot: '/my-files/Sync', configFile, remote: fake, home });
    const sync = await fake.resolvePath('/my-files/Sync');
    expect(config.remoteRootNodeUid).toBe(sync?.uid);
    expect(config.localRootIdentity).toEqual(readRootIdentity(local));
    expect(pairChanged).toBe(false);
    expect(loadConfigFile(configFile)).toEqual(config);
  });

  it('rejects a missing remote folder, a file, a trashed folder, and an invalid local root', async () => {
    const local = path.join(home, 'Drive');
    await expect(runSetup({ localRoot: local, remoteRoot: '/my-files/Nope', configFile, remote: fake, home })).rejects.toThrow(/does not exist/);
    fake.seedFile(fake.rootUid, 'notes.txt', 'x');
    await expect(runSetup({ localRoot: local, remoteRoot: '/my-files/notes.txt', configFile, remote: fake, home })).rejects.toThrow(/not a folder/);
    const gone = fake.seedFolder(fake.rootUid, 'Gone');
    await fake.trash([gone.uid]);
    await expect(runSetup({ localRoot: local, remoteRoot: '/my-files/Gone', configFile, remote: fake, home })).rejects.toThrow(/does not exist|trash/);
    await expect(runSetup({ localRoot: home, remoteRoot: '/my-files/Sync', configFile, remote: fake, home })).rejects.toBeInstanceOf(ConfigError);
    expect(loadConfigFile(configFile)).toBeNull();
  });

  it('flags a changed pair, refuses nesting with the previous root, and keeps other settings', async () => {
    const first = path.join(home, 'Drive');
    await runSetup({ localRoot: first, remoteRoot: '/my-files/Sync', configFile, remote: fake, home, overrides: { dryRun: true } });
    mkdirSync(path.join(first, 'inner'));
    await expect(runSetup({ localRoot: path.join(first, 'inner'), remoteRoot: '/my-files/Sync', configFile, remote: fake, home })).rejects.toThrow(/inside the already configured root/);
    const second = path.join(home, 'Other');
    fake.seedFolder(fake.rootUid, 'Sync2');
    const result = await runSetup({ localRoot: second, remoteRoot: '/my-files/Sync2', configFile, remote: fake, home });
    expect(result.pairChanged).toBe(true);
    expect(result.previous?.localRoot).toBe(first);
    expect(result.config.dryRun).toBe(true);
    expect(result.config.localRoot).toBe(second);
    // Re-running with the same pair is not a change.
    expect((await runSetup({ localRoot: second, remoteRoot: '/my-files/Sync2', configFile, remote: fake, home })).pairChanged).toBe(false);
  });
});

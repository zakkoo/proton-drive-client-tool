import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptedRootIdentity, filesystemKey, readRootIdentity, sameIdentity, validateLocalRoot } from './localRoot.js';

let base: string;
let home: string;
beforeEach(() => {
  // Use a fake home outside /tmp so the system-directory rule does not interfere.
  base = mkdtempSync(path.join(os.homedir(), '.cache', 'pds-test-'));
  home = path.join(base, 'home');
  mkdirSync(path.join(home, 'Drive'), { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('validateLocalRoot', () => {
  it('accepts a writable directory under home', () => {
    expect(validateLocalRoot(path.join(home, 'Drive'), { home })).toEqual([]);
  });

  it('rejects home, its ancestors, and the filesystem root', () => {
    expect(validateLocalRoot(home, { home })).toContainEqual(expect.stringContaining('home directory itself'));
    expect(validateLocalRoot(base, { home })).toContainEqual(expect.stringContaining('contain the home directory'));
    expect(validateLocalRoot('/', { home })).toContainEqual(expect.stringContaining('filesystem root'));
  });

  it('rejects system directories', () => {
    expect(validateLocalRoot('/etc', { home })).toContainEqual(expect.stringContaining('system directory'));
    expect(validateLocalRoot('/usr/share', { home })).toContainEqual(expect.stringContaining('system directory'));
  });

  it('rejects roots equal to, inside, or containing an existing root', () => {
    const existing = path.join(home, 'Drive');
    mkdirSync(path.join(existing, 'sub'));
    mkdirSync(path.join(home, 'Other'));
    expect(validateLocalRoot(existing, { home, existingRoots: [existing] })).toContainEqual(expect.stringContaining('already configured'));
    expect(validateLocalRoot(path.join(existing, 'sub'), { home, existingRoots: [existing] })).toContainEqual(
      expect.stringContaining('inside the already configured root'),
    );
    expect(validateLocalRoot(home + '/Other', { home, existingRoots: [path.join(home, 'Other', 'x')] })).toContainEqual(
      expect.stringContaining('contains the already configured root'),
    );
    expect(validateLocalRoot(path.join(home, 'Other'), { home, existingRoots: [existing] })).toEqual([]);
  });

  it('rejects relative, missing, non-directory and unwritable paths', () => {
    expect(validateLocalRoot('Drive', { home })).toEqual(['local root must be an absolute path']);
    expect(validateLocalRoot(path.join(home, 'nope'), { home })).toContainEqual(expect.stringContaining('does not exist'));
    const file = path.join(home, 'file.txt');
    writeFileSync(file, 'x');
    expect(validateLocalRoot(file, { home })).toContainEqual(expect.stringContaining('not a directory'));
    if (process.getuid?.() !== 0) {
      const ro = path.join(home, 'ro');
      mkdirSync(ro);
      chmodSync(ro, 0o500);
      try {
        expect(validateLocalRoot(ro, { home })).toContainEqual(expect.stringContaining('not readable and writable'));
      } finally {
        chmodSync(ro, 0o700);
      }
    }
  });
});

const MOUNTINFO = [
  '799 786 0:94 / /home/zakko rw - tmpfs tmpfs rw,mode=700',
  '825 799 0:30 /@home/zakko/Projects /home/zakko/Projects rw master:201 - btrfs /dev/mapper/root rw,compress=zstd:3,subvolid=257,subvol=/@home',
  '826 799 0:30 /@home/zakko/My\\040Files /home/zakko/My\\040Files rw - btrfs /dev/mapper/root rw,subvolid=257,subvol=/@home',
  '827 799 0:40 / /mnt/other rw - btrfs /dev/mapper/other rw,subvolid=5,subvol=/',
].join('\n');

describe('readRootIdentity', () => {
  it('is stable for the same directory and differs after replacement', () => {
    const dir = path.join(home, 'Drive');
    const a = readRootIdentity(dir);
    expect(sameIdentity(a, readRootIdentity(dir))).toBe(true);
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    expect(sameIdentity(a, readRootIdentity(dir))).toBe(false);
  });
});

describe('filesystemKey', () => {
  it('uses the longest btrfs mount and keeps subvolume identity across escaped paths', () => {
    expect(filesystemKey('/home/zakko/Projects/app', MOUNTINFO)).toBe('btrfs:/dev/mapper/root:subvolid=257');
    expect(filesystemKey('/home/zakko/My Files/notes', MOUNTINFO)).toBe('btrfs:/dev/mapper/root:subvolid=257');
    expect(filesystemKey('/mnt/other/dir', MOUNTINFO)).toBe('btrfs:/dev/mapper/other:subvolid=5');
    expect(filesystemKey('/home/zakko/Pictures', MOUNTINFO)).toBeUndefined();
  });
});

describe('sameIdentity', () => {
  const btrfs = 'btrfs:/dev/mapper/root:subvolid=257';

  it('accepts a btrfs device-number change for the same inode and volume', () => {
    const recorded = { dev: 59, ino: 605696 };
    const live = { dev: 58, ino: 605696, birthtimeMs: 10, fsKey: btrfs };
    expect(sameIdentity(recorded, live)).toBe(true);
    expect(adoptedRootIdentity(recorded, live)).toEqual(live);
  });

  it('rejects a different volume, a reused inode, and a device change on a stable filesystem', () => {
    expect(sameIdentity({ dev: 59, ino: 605696, fsKey: btrfs }, { dev: 58, ino: 605696, fsKey: 'btrfs:/dev/mapper/other:subvolid=5' })).toBe(false);
    expect(sameIdentity({ dev: 59, ino: 605696, birthtimeMs: 10, fsKey: btrfs }, { dev: 58, ino: 605696, birthtimeMs: 20, fsKey: btrfs })).toBe(false);
    expect(sameIdentity({ dev: 59, ino: 605696 }, { dev: 58, ino: 605696 })).toBe(false);
    expect(adoptedRootIdentity({ dev: 59, ino: 1 }, { dev: 58, ino: 2, fsKey: btrfs })).toBeNull();
  });
});

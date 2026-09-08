import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readRootIdentity, sameIdentity, validateLocalRoot } from './localRoot.js';

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

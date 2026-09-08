import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_IGNORE } from '../config/schema.js';
import { createIgnoreMatcher } from './ignore.js';
import { invalidNameReason, RootUnavailableError, scanLocalTree } from './snapshot.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pds-scan-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ignore = createIgnoreMatcher(DEFAULT_IGNORE);

describe('createIgnoreMatcher', () => {
  it('always ignores the internal directory and applies patterns to any ancestor', () => {
    const m = createIgnoreMatcher(['**/*.tmp', 'build', 'docs/**/*.log']);
    expect(m('.proton-sync')).toBe(true);
    expect(m('.proton-sync/tmp/x')).toBe(true);
    expect(m('a/b/c.tmp')).toBe(true);
    expect(m('build')).toBe(true);
    expect(m('build/out.js')).toBe(true);
    expect(m('docs/a/b.log')).toBe(true);
    expect(m('docs/a/b.txt')).toBe(false);
    expect(m('src/main.ts')).toBe(false);
    expect(m('')).toBe(false);
  });

  it('default patterns cover editor temp files and OS metadata', () => {
    for (const p of ['x.swp', 'dir/.DS_Store', 'a/b/c~', 'Thumbs.db', 'doc.docx.part', '.#lock']) expect(ignore(p), p).toBe(true);
    for (const p of ['notes.md', 'photos/2026/a.jpg', 'code/tmp/real.txt']) expect(ignore(p), p).toBe(false);
  });
});

describe('scanLocalTree', () => {
  it('lists files and directories with identities, skips ignored paths, and reports symlinks and special files as unsyncable', async () => {
    mkdirSync(path.join(root, 'docs', 'inner'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'a.txt'), 'aaa');
    writeFileSync(path.join(root, 'docs', 'inner', 'b.txt'), 'bb');
    writeFileSync(path.join(root, 'ignored.tmp'), 'x');
    mkdirSync(path.join(root, '.proton-sync', 'tmp'), { recursive: true });
    writeFileSync(path.join(root, '.proton-sync', 'tmp', 'partial'), 'p');
    symlinkSync(path.join(root, 'docs', 'a.txt'), path.join(root, 'link.txt'));
    execFileSync('mkfifo', [path.join(root, 'pipe')]);

    const snap = await scanLocalTree(root, { ignore });
    expect([...snap.entries.keys()].sort()).toEqual(['docs', 'docs/a.txt', 'docs/inner', 'docs/inner/b.txt']);
    const a = snap.entries.get('docs/a.txt');
    expect(a).toMatchObject({ kind: 'file', size: 3 });
    expect(a?.ino).toBeGreaterThan(0);
    expect(snap.entries.get('docs')).toMatchObject({ kind: 'dir', size: 0 });
    expect(snap.unsyncable.map((u) => `${u.relPath}:${u.reason}`).sort()).toEqual(['link.txt:symlink', 'pipe:special']);
    expect(snap.complete).toBe(true);
    expect(snap.rootIdentity.ino).toBeGreaterThan(0);
  });

  it('reports unreadable files and directories without deleting or renaming anything', async () => {
    if (process.getuid?.() === 0) return; // root can read everything
    mkdirSync(path.join(root, 'locked'));
    writeFileSync(path.join(root, 'locked', 'secret.txt'), 's');
    writeFileSync(path.join(root, 'noread.txt'), 'n');
    chmodSync(path.join(root, 'noread.txt'), 0o000);
    chmodSync(path.join(root, 'locked'), 0o000);
    try {
      const snap = await scanLocalTree(root, { ignore });
      expect(snap.unsyncable.map((u) => `${u.relPath}:${u.reason}`).sort()).toEqual(['locked:unreadable', 'noread.txt:unreadable']);
      expect(snap.complete).toBe(false);
      expect(snap.entries.has('locked')).toBe(true); // the directory itself is known
    } finally {
      chmodSync(path.join(root, 'locked'), 0o700);
      chmodSync(path.join(root, 'noread.txt'), 0o600);
    }
  });

  it('throws RootUnavailableError when the root is missing or not a directory', async () => {
    await expect(scanLocalTree(path.join(root, 'nope'), { ignore })).rejects.toBeInstanceOf(RootUnavailableError);
    writeFileSync(path.join(root, 'file'), 'x');
    await expect(scanLocalTree(path.join(root, 'file'), { ignore })).rejects.toBeInstanceOf(RootUnavailableError);
  });

  it('flags names that cannot exist remotely', () => {
    expect(invalidNameReason('ok.txt')).toBeNull();
    expect(invalidNameReason('ab')).toMatch(/control/);
    expect(invalidNameReason('x'.repeat(256))).toMatch(/longer/);
    expect(invalidNameReason('..')).toMatch(/reserved/);
    expect(invalidNameReason('a\\b')).toMatch(/separator/);
  });
});

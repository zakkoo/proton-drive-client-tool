import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../audit/logger.js';
import { SecretRegistry } from '../audit/redact.js';
import { readRootIdentity } from '../config/localRoot.js';
import { DEFAULTS } from '../config/schema.js';
import { reconcile } from '../reconcile/reconcile.js';
import type { Plan } from '../reconcile/types.js';
import { QuarantineRepo } from '../state/misc.ts';
import { StateStore } from '../state/store.ts';
import { FakeRemote } from '../testing/fakeRemote.js';
import { World } from '../testing/world.js';
import { evaluateBrake, PlanGate } from './brake.js';
import { runPreflight } from './preflight.js';
import { QuarantineService } from './quarantine.js';
import { RecycleBin } from './recycle.js';

let dir: string;
let root: string;
let audit: AuditLog;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pds-safety-'));
  root = path.join(dir, 'root');
  mkdirSync(root);
  audit = new AuditLog({ dir: path.join(dir, 'audit'), registry: new SecretRegistry() });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RecycleBin', () => {
  it('moves files and whole folders into a timestamped bucket preserving the relative path, without deleting', () => {
    let t = 1_700_000_000_000;
    const bin = new RecycleBin(root, 30, audit, () => t);
    mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'a.txt'), 'A');
    writeFileSync(path.join(root, 'docs', 'deep', 'b.txt'), 'B');
    writeFileSync(path.join(root, 'top.txt'), 'T');
    const f = bin.recycle('top.txt', 'deleted remotely');
    expect(f.kind).toBe('file');
    expect(readFileSync(f.absolutePath, 'utf8')).toBe('T');
    expect(existsSync(path.join(root, 'top.txt'))).toBe(false);
    t += 1000;
    const d = bin.recycle('docs', 'deleted remotely');
    expect(d.kind).toBe('dir');
    expect(readFileSync(path.join(d.absolutePath, 'deep', 'b.txt'), 'utf8')).toBe('B');
    expect(bin.list().map((i) => `${String(i.bucket)}:${i.relPath}`).sort()).toEqual([
      '1700000000000:top.txt',
      '1700000001000:docs',
      '1700000001000:docs/a.txt',
      '1700000001000:docs/deep',
      '1700000001000:docs/deep/b.txt',
    ]);
    // Same path recycled twice in the same bucket gets a suffix instead of overwriting.
    writeFileSync(path.join(root, 'top.txt'), 'T2');
    t = 1_700_000_000_000;
    const again = bin.recycle('top.txt', 'again');
    expect(again.absolutePath.endsWith('.1')).toBe(true);
    expect(readFileSync(f.absolutePath, 'utf8')).toBe('T');
    expect(() => bin.recycle('.proton-sync', 'x')).toThrow(/internal/);
    expect(() => bin.recycle('../etc', 'x')).toThrow(/invalid/);
  });

  it('purge removes only buckets older than retention and logs every purged path', () => {
    let t = 1_700_000_000_000;
    const bin = new RecycleBin(root, 30, audit, () => t);
    writeFileSync(path.join(root, 'old.txt'), 'old');
    bin.recycle('old.txt', 'r');
    t += 31 * 24 * 3600 * 1000;
    writeFileSync(path.join(root, 'new.txt'), 'new');
    bin.recycle('new.txt', 'r');
    const removed = bin.purge();
    expect(removed).toEqual(['old.txt']);
    expect(bin.list().map((i) => i.relPath)).toEqual(['new.txt']);
    const entries = audit.readAll().entries.filter((e) => e.op === 'purge_recycle');
    expect(entries.map((e) => e.path)).toEqual(['old.txt']);
  });
});

describe('no code path unlinks user data except the purge command', () => {
  it('scans src for unlink/rm/rmdir calls outside the allow-list', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    // Files allowed to remove files, and what they remove.
    const allowed = new Map<string, string>([
      ['safety/recycle.ts', 'recycle bin purge (explicit retention command)'],
      ['remote/transfer.ts', 'own temporary download files'],
      ['audit/logger.ts', 'own rotated log files'],
      ['config/secretStore.ts', 'own credentials file'],
      ['state/store.ts', 'own lock and backup files'],
      ['state/crashChild.ts', 'test helper lock file'],
      ['execute/localWrite.ts', 'own temporary download file on failure'],
      ['execute/recovery.ts', 'own leftover temporary download files'],
      ['engine/control.ts', 'own control socket file'],
    ]);
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.includes(`${path.sep}testing${path.sep}`)) {
          const rel = path.relative(src, full);
          if (allowed.has(rel)) continue;
          const text = readFileSync(full, 'utf8');
          text.split('\n').forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '');
            if (/\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/.test(code)) offenders.push(`${rel}:${String(i + 1)}: ${line.trim()}`);
          });
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe('mass-change brake', () => {
  function bigWorld(n: number): World {
    const w = new World();
    for (let i = 0; i < n; i++) {
      w.localWrite(`f${String(i)}.txt`, 'x');
      w.remoteWrite(`f${String(i)}.txt`, 'x');
    }
    w.markAllSynced();
    return w;
  }

  it('holds a plan exceeding the count or percentage threshold, and lets small plans run', () => {
    const w = bigWorld(100);
    for (let i = 0; i < 20; i++) w.remoteTrash(`f${String(i)}.txt`);
    const plan = reconcile(w.input());
    const verdict = evaluateBrake(plan, 100, { ...DEFAULTS.safety, brakeMaxChanges: 50, brakeMaxChangePercent: 10 });
    expect(verdict.held).toBe(true);
    expect(verdict.count).toBe(20);
    expect(verdict.reason).toMatch(/20\.0% of the 100/);
    const small = bigWorld(100);
    small.remoteTrash('f1.txt');
    expect(evaluateBrake(reconcile(small.input()), 100, DEFAULTS.safety).held).toBe(false);
    // Count rule applies even when the baseline is small.
    const tiny = bigWorld(5);
    for (let i = 0; i < 3; i++) tiny.remoteTrash(`f${String(i)}.txt`);
    expect(evaluateBrake(reconcile(tiny.input()), 5, { ...DEFAULTS.safety, brakeMaxChanges: 2 }).held).toBe(true);
    // Replacements count too.
    const rep = bigWorld(10);
    for (let i = 0; i < 6; i++) rep.remoteWrite(`f${String(i)}.txt`, 'changed');
    expect(evaluateBrake(reconcile(rep.input()), 10, { ...DEFAULTS.safety, brakeMaxChanges: 5 }).held).toBe(true);
  });

  it('gate: held plan runs only after confirm (with withheld deletes) and is discarded on reject, both recorded in the audit log', () => {
    const gate = new PlanGate({ ...DEFAULTS.safety, brakeMaxChanges: 3 }, audit, () => 42);
    const w = bigWorld(20);
    for (let i = 0; i < 5; i++) w.remoteTrash(`f${String(i)}.txt`);
    const plan = reconcile(w.input());
    const result = gate.evaluate(plan, 20);
    expect(result.status).toBe('held');
    if (result.status !== 'held') throw new Error('expected held');
    expect(gate.current?.id).toBe(result.held.id);
    const confirmed = gate.confirm(result.held.id);
    expect(confirmed.operations.filter((o) => o.kind === 'recycle_local')).toHaveLength(5);
    expect(confirmed.requiresConfirmation).toBeNull();
    expect(gate.current).toBeNull();

    const w2 = bigWorld(20);
    for (let i = 0; i < 5; i++) w2.remoteTrash(`f${String(i)}.txt`);
    const held2 = gate.evaluate(reconcile(w2.input()), 20);
    if (held2.status !== 'held') throw new Error('expected held');
    const affected = gate.reject(held2.held.id);
    expect(affected).toHaveLength(5);
    expect(() => gate.confirm(held2.held.id)).toThrow(/No held plan/);

    // A held plan whose remote root is empty is confirmed including the withheld operations.
    const w3 = bigWorld(3);
    for (let i = 0; i < 3; i++) w3.remoteTrash(`f${String(i)}.txt`);
    const emptyRemote = reconcile(w3.input());
    expect(emptyRemote.requiresConfirmation).not.toBeNull();
    const held3 = gate.evaluate(emptyRemote, 3);
    if (held3.status !== 'held') throw new Error('expected held');
    expect(gate.confirm(held3.held.id).operations.filter((o) => o.kind === 'recycle_local')).toHaveLength(3);

    const ops = audit.readAll().entries.map((e) => e.op);
    expect(ops.filter((o) => o === 'brake')).toHaveLength(3);
    expect(ops).toContain('confirm_plan');
    expect(ops).toContain('reject_plan');
  });

  it('unaffected items keep syncing while a plan is held (the plan simply excludes them from held operations)', () => {
    const w = bigWorld(20);
    for (let i = 0; i < 5; i++) w.remoteTrash(`f${String(i)}.txt`);
    w.localWrite('brand-new.txt', 'n');
    const plan = reconcile(w.input());
    const verdict = evaluateBrake(plan, 20, { ...DEFAULTS.safety, brakeMaxChanges: 3 });
    const safeOps: Plan['operations'] = plan.operations.filter((o) => !verdict.affected.includes(o));
    expect(safeOps.map((o) => o.kind)).toEqual(['upload']);
  });
});

describe('first-sync protection', () => {
  it('with no baseline and both sides non-empty, produces only creates, baseline updates and conflicts, never deletes', () => {
    const w = new World();
    w.localWrite('l1.txt', 'L1');
    w.localWrite('both-same.txt', 'S');
    w.localWrite('both-diff.txt', 'local');
    w.localMkdir('dir/inner');
    w.remoteWrite('r1.txt', 'R1');
    w.remoteWrite('both-same.txt', 'S');
    w.remoteWrite('both-diff.txt', 'remote');
    w.remoteWrite('other/x.txt', 'X');
    const plan = reconcile(w.input());
    expect(plan.firstSync).toBe(true);
    const kinds = new Set(plan.operations.map((o) => o.kind));
    expect(kinds.has('recycle_local')).toBe(false);
    expect(kinds.has('trash_remote')).toBe(false);
    expect([...kinds].sort()).toEqual(['create_local_folder', 'create_remote_folder', 'download', 'update_baseline', 'upload']);
    expect(plan.conflicts.map((c) => `${c.kind}:${c.relPath}`)).toEqual(['create_create:both-diff.txt']);
    expect(plan.stats.deletes).toBe(0);
  });
});

describe('quarantine', () => {
  it('quarantined items are excluded from plans, never deleted or overwritten, and re-reconciled after release', () => {
    const store = StateStore.open(path.join(dir, 'state.db'));
    try {
      const q = new QuarantineService(new QuarantineRepo(store), audit);
      const w = new World();
      w.localWrite('bad.bin', 'B');
      w.remoteWrite('bad.bin', 'B');
      w.localWrite('ok.txt', 'O');
      w.remoteWrite('ok.txt', 'O');
      w.localWrite('keep.txt', 'K');
      w.remoteWrite('keep.txt', 'K');
      w.markAllSynced();
      const bad = w.remoteByPath('bad.bin');
      if (bad === undefined) throw new Error('missing');
      const entry = q.quarantine({ relPath: 'bad.bin', nodeUid: bad.uid, reason: 'digest_mismatch', details: { expected: 'a', actual: 'b' } });
      // Both sides now want to delete/replace it; quarantine wins.
      w.remoteTrash('bad.bin');
      w.remoteTrash('ok.txt');
      const sets = q.sets();
      const plan = reconcile(w.input({ quarantinedPaths: sets.paths, quarantinedUids: sets.uids }));
      expect(plan.operations.map((o) => `${o.kind}:${'relPath' in o ? o.relPath : ''}`)).toEqual(['recycle_local:ok.txt']);
      expect(plan.blocked.map((b) => `${b.reason}:${b.relPath ?? ''}`)).toEqual(['quarantined:bad.bin']);
      q.release(entry.id);
      expect(q.open()).toEqual([]);
      const after = reconcile(w.input({ quarantinedPaths: q.sets().paths, quarantinedUids: q.sets().uids }));
      expect(after.operations.map((o) => o.kind).sort()).toEqual(['recycle_local', 'recycle_local']);
      const ops = audit.readAll().entries.map((e) => e.op);
      expect(ops).toEqual(['quarantine', 'release_quarantine']);
    } finally {
      store.close();
    }
  });
});

describe('preflight', () => {
  it('passes for a healthy setup and pauses on each failure with the right reason', async () => {
    const fake = new FakeRemote();
    const remoteRoot = fake.seedFolder(fake.rootUid, 'Sync');
    const identity = readRootIdentity(root);
    const base = {
      root,
      expectedRootIdentity: identity,
      storeIntegrity: () => 'ok',
      remote: fake,
      expectedRemoteRootUid: remoteRoot.uid,
      plannedDownloadBytes: 1000,
      marginBytes: 100,
      freeBytes: () => Promise.resolve(10_000),
    };
    expect(await runPreflight(base)).toEqual({ ok: true, freeBytes: 10_000 });
    expect(await runPreflight({ ...base, root: path.join(dir, 'missing') })).toMatchObject({ ok: false, reason: 'sync_root_missing' });
    rmSync(root, { recursive: true });
    mkdirSync(root);
    expect(await runPreflight(base)).toMatchObject({ ok: false, reason: 'sync_root_changed' });
    const fresh = { ...base, expectedRootIdentity: readRootIdentity(root) };
    expect(await runPreflight({ ...fresh, storeIntegrity: () => 'page 3 is malformed' })).toMatchObject({ ok: false, reason: 'store_corrupt' });
    expect(await runPreflight({ ...fresh, freeBytes: () => Promise.resolve(1050) })).toMatchObject({ ok: false, reason: 'disk_space_low' });
    expect(await runPreflight({ ...fresh, expectedRemoteRootUid: 'nope' })).toMatchObject({ ok: false, reason: 'remote_root_missing' });
    await fake.trash([remoteRoot.uid]);
    expect(await runPreflight(fresh)).toMatchObject({ ok: false, reason: 'remote_root_changed' });
  });
});

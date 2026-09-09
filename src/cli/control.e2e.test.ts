import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../audit/logger.js';
import { SecretRegistry } from '../audit/redact.js';
import { loadConfigFile } from '../config/configFile.js';
import { resolveAppPaths, type AppPaths } from '../config/paths.js';
import { ControlClient } from '../engine/control.js';
import type { EngineStatus } from '../engine/status.js';
import { FakeRemote } from '../testing/fakeRemote.js';
import { dispatch, type CommandDeps, type CommandRuntime } from './commands.js';
import { parseCli } from './main.js';

/**
 * The control surfaces end to end (spec: test-suite / Conflict, brake, and
 * quarantine through the CLI; Recycle list and purge; First pair). A real engine
 * runs over the control socket against the fake remote; conflicts, held plans,
 * quarantine, recycle and the --json contracts are driven through the CLI and
 * the socket with the ids the engine actually assigns.
 */

let base: string;
let root: string;
let fake: FakeRemote;
let syncFolderUid: string;
let stdout: string[];
let stderr: string[];
let paths: AppPaths;
let engines: RunningEngine[];

function makeDeps(): CommandDeps {
  const audit = new AuditLog({ dir: paths.auditLogDir, registry: new SecretRegistry() });
  const runtime = (): CommandRuntime => ({
    remote: fake,
    session: { current: 'logged_in' },
    auth: {
      loginViaWeb: async (onUrl) => { await onUrl('https://account.example.test/desktop/login#x'); },
      loginViaPassword: () => Promise.resolve({}),
      logout: () => Promise.resolve(),
    },
    clearCaches: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  });
  let resolveRun: () => void = () => undefined;
  const runUntil = new Promise<void>((r) => (resolveRun = r));
  const deps: CommandDeps & { stopRun: () => void } = {
    ctx: { paths, config: loadConfigFile(paths.configFile), audit, logSink: () => undefined, logLevel: 'error' },
    createRuntime: () => Promise.resolve(runtime()),
    prompt: () => Promise.resolve('user@example.test'),
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    openBrowser: () => undefined,
    runUntil,
    engineTimers: { watcherDebounceMs: 80, watcherSettleMs: 25, feedPollMs: 50, triggerDebounceMs: 15 },
    stopRun: resolveRun,
  };
  return deps;
}

/** Run a one-shot command with fresh deps (a separate process would). */
async function cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  stdout = [];
  stderr = [];
  const code = await dispatch(makeDeps(), parseCli(argv));
  return { code, out: stdout, err: stderr };
}

function lastJson(): unknown {
  return JSON.parse(stdout.at(-1) ?? '{}');
}

interface RunningEngine {
  running: Promise<number>;
  stop: () => void;
  waitForStatus: (pred: (s: EngineStatus) => boolean, timeoutMs?: number) => Promise<EngineStatus>;
}

/** Start `run --no-tray` and return handles; `configure` mutates the run config (e.g. a low brake). */
function startEngine(configure?: (c: NonNullable<CommandDeps['ctx']['config']>) => NonNullable<CommandDeps['ctx']['config']>): RunningEngine {
  const deps = makeDeps() as CommandDeps & { stopRun: () => void };
  if (configure !== undefined && deps.ctx.config !== null) deps.ctx.config = configure(deps.ctx.config);
  const running = dispatch(deps, parseCli(['run', '--no-tray']));
  const waitForStatus = async (pred: (s: EngineStatus) => boolean, timeoutMs = 8000): Promise<EngineStatus> => {
    const started = Date.now();
    const client = new ControlClient(paths.controlSocket);
    try {
      for (;;) {
        try {
          await client.connect(2000);
          const s = await client.request<EngineStatus>({ cmd: 'status' });
          if (pred(s)) return s;
        } catch {
          // socket not up yet
        } finally {
          client.close();
        }
        if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for engine status');
        await new Promise((r) => setTimeout(r, 40));
      }
    } finally {
      client.close();
    }
  };
  const handle: RunningEngine = { running, stop: deps.stopRun, waitForStatus };
  engines.push(handle);
  return handle;
}

async function socketRequest<T>(req: unknown): Promise<T> {
  const client = new ControlClient(paths.controlSocket);
  await client.connect(2000);
  try {
    return await client.request<T>(req as Parameters<ControlClient['request']>[0]);
  } finally {
    client.close();
  }
}

beforeEach(async () => {
  base = mkdtempSync(path.join(os.homedir(), '.cache', 'pds-ctl-'));
  root = path.join(base, 'Drive');
  mkdirSync(root);
  fake = new FakeRemote();
  syncFolderUid = fake.seedFolder(fake.rootUid, 'Sync').uid;
  paths = resolveAppPaths({ PROTON_DRIVE_SYNC_DIR: path.join(base, 'app') }, base);
  stdout = [];
  stderr = [];
  engines = [];
  // Every scenario starts from a configured pair.
  await cli('setup', root, '/my-files/Sync');
});
afterEach(async () => {
  // Stop any engine still running (e.g. after a failed assertion) before removing its files.
  for (const e of engines) {
    e.stop();
    await e.running.catch(() => undefined);
  }
  rmSync(base, { recursive: true, force: true });
});

describe('first pair: dry-run mutates nothing', () => {
  it('run --dry-run --no-tray (without --paused) logs would-do and changes neither side nor the config', async () => {
    writeFileSync(path.join(root, 'local.txt'), 'L');
    fake.seedFile(syncFolderUid, 'remote.txt', 'R');
    const remoteNodesBefore = fake.allNodes().length;

    const engine = startEngine((c) => ({ ...c, dryRun: true }));
    // A dry run reaches idle without --paused; it is not paused.
    await engine.waitForStatus((s) => s.state === 'idle' && s.dryRun);

    // No mutations: nothing uploaded or downloaded.
    expect(fake.allNodes().length, 'no new remote node').toBe(remoteNodesBefore);
    expect(existsSync(path.join(root, 'remote.txt')), 'nothing downloaded').toBe(false);
    expect(fake.calls.some((call) => call.op === 'upload' || call.op === 'download')).toBe(false);

    engine.stop();
    expect(await engine.running).toBe(0);

    // The plan was recorded as would-do, and the config file's dryRun stayed false.
    const audit = new AuditLog({ dir: paths.auditLogDir, registry: new SecretRegistry() });
    const wouldDo = audit.readAll().entries.filter((e) => e.kind === 'would_do');
    expect(wouldDo.length, 'would-do entries recorded').toBeGreaterThanOrEqual(2);
    expect(loadConfigFile(paths.configFile)?.dryRun, 'config dryRun must remain false').toBe(false);
  });
});

describe('conflict, brake, and quarantine through the CLI and socket', () => {
  it('resolves a real content conflict via the CLI', async () => {
    writeFileSync(path.join(root, 'c.txt'), 'local version');
    fake.seedFile(syncFolderUid, 'c.txt', 'remote version');
    const engine = startEngine();
    await engine.waitForStatus((s) => s.attention.conflicts > 0);

    const listed = await cli('conflicts', '--json');
    const conflicts = (lastJson() as { id: number; relPath: string; kind: string }[]);
    expect(listed.code).toBe(0);
    expect(conflicts[0]?.kind).toBe('create_create');
    const id = conflicts[0]?.id ?? -1;

    const resolved = await cli('conflicts', 'resolve', String(id), 'keep_both');
    expect(resolved.code).toBe(0);
    // The engine state reflects the resolution: no open conflicts remain.
    const after = await socketRequest<EngineStatus>({ cmd: 'status' });
    expect(after.attention.conflicts).toBe(0);

    engine.stop();
    expect(await engine.running).toBe(0);
  });

  it('holds a mass-delete plan and rejects it via the socket, then confirms a fresh one via the CLI', async () => {
    for (let i = 0; i < 4; i++) writeFileSync(path.join(root, `f${String(i)}.txt`), `v${String(i)}`);
    // A brake that trips on two or more destructive operations.
    const lowBrake = (c: NonNullable<CommandDeps['ctx']['config']>): NonNullable<CommandDeps['ctx']['config']> => ({ ...c, safety: { ...c.safety, brakeMaxChanges: 1, brakePercentMinBaseline: 10_000 } });
    const engine = startEngine(lowBrake);
    await engine.waitForStatus((s) => s.counts.baseline === 4);

    // Delete them all at once -> a held plan (> brakeMaxChanges destructive ops).
    for (let i = 0; i < 4; i++) rmSync(path.join(root, `f${String(i)}.txt`));
    const held = await engine.waitForStatus((s) => s.attention.heldPlan !== null);
    const heldId = held.attention.heldPlan?.id ?? '';
    expect(heldId).toMatch(/^held-/);

    // Reject via the raw control socket, by the real id: nothing is trashed.
    await socketRequest({ cmd: 'reject', args: { id: heldId } });
    const afterReject = await socketRequest<EngineStatus>({ cmd: 'status' });
    expect(afterReject.attention.heldPlan, 'reject clears the held plan').toBeNull();
    expect(fake.trashedUids(), 'reject discards the deletes').toEqual([]);

    engine.stop();
    expect(await engine.running).toBe(0);

    // Restart and reproduce the held plan, then confirm it by id via the CLI: the deletes apply.
    const engine2 = startEngine(lowBrake);
    await engine2.waitForStatus((s) => s.state !== 'starting' && s.state !== 'scanning');
    const held2 = await engine2.waitForStatus((s) => s.attention.heldPlan !== null);
    const held2Id = held2.attention.heldPlan?.id ?? '';
    const confirmed = await cli('held', 'confirm', held2Id);
    expect(confirmed.code).toBe(0);
    const afterConfirm = await engine2.waitForStatus((s) => s.attention.heldPlan === null && s.state === 'idle');
    expect(afterConfirm.attention.heldPlan).toBeNull();
    expect(fake.trashedUids().length, 'confirm applies the deletes').toBe(4);

    engine2.stop();
    expect(await engine2.running).toBe(0);
  });

  it('quarantines a failed operation and releases it by its real id via the CLI', async () => {
    writeFileSync(path.join(root, 'q.txt'), 'Q');
    // The upload commits but the server reports a mismatched digest -> verification fails -> quarantine.
    fake.injectFault('upload', { kind: 'mismatch_upload' });
    const engine = startEngine();
    const withQuarantine = await engine.waitForStatus((s) => s.attention.quarantined > 0, 10_000);
    expect(withQuarantine.attention.quarantined).toBeGreaterThan(0);

    const listed = await cli('quarantine', '--json');
    const rows = (lastJson() as { id: number; relPath: string | null; reason: string }[]);
    expect(listed.code).toBe(0);
    const id = rows[0]?.id ?? -1;
    expect(id).toBeGreaterThanOrEqual(0);

    const released = await cli('quarantine', 'release', String(id));
    expect(released.code).toBe(0);
    // Nothing was trashed at any point.
    expect(fake.trashedUids()).toEqual([]);

    engine.stop();
    expect(await engine.running).toBe(0);
  });
});

describe('recycle list and purge', () => {
  it('lists a recycled file and purges only aged buckets, logging every purged path', async () => {
    // Sync two remote files down, then have another client trash one (the folder stays non-empty,
    // so this is a real recycle, not the empty-remote hold) -> the trashed file lands in the recycle bin.
    fake.seedFile(syncFolderUid, 'gone.txt', 'BYE');
    fake.seedFile(syncFolderUid, 'stay.txt', 'STAY');
    const engine = startEngine();
    await engine.waitForStatus((s) => s.counts.baseline === 2 && s.state === 'idle');
    expect(existsSync(path.join(root, 'gone.txt'))).toBe(true);
    await fake.trash([fake.allNodes().find((n) => n.name === 'gone.txt' && !n.isTrashed)?.uid ?? '']);
    await engine.waitForStatus(() => !existsSync(path.join(root, 'gone.txt')), 10_000);
    expect(existsSync(path.join(root, 'stay.txt')), 'the other file is untouched').toBe(true);
    engine.stop();
    expect(await engine.running).toBe(0);

    // Plant an aged bucket well past the 30-day retention.
    const recycleDir = path.join(root, '.proton-sync', 'recycle');
    const agedBucket = Date.now() - 40 * 24 * 60 * 60 * 1000;
    mkdirSync(path.join(recycleDir, String(agedBucket)), { recursive: true });
    writeFileSync(path.join(recycleDir, String(agedBucket), 'old.txt'), 'OLD');

    // `recycle` lists both the fresh entry and the aged one.
    const listed = await cli('recycle', '--json');
    const items = (lastJson() as { relPath: string; bucket: number }[]);
    expect(listed.code).toBe(0);
    expect(items.map((i) => i.relPath).sort()).toEqual(['gone.txt', 'old.txt']);

    // `recycle purge` removes only the aged bucket and logs its path; the fresh entry stays.
    const purged = await cli('recycle', 'purge', '--json');
    expect(purged.code).toBe(0);
    expect((lastJson() as { removed: string[] }).removed).toEqual(['old.txt']);
    expect(existsSync(path.join(recycleDir, String(agedBucket)))).toBe(false);
    const afterList = await cli('recycle', '--json');
    expect(afterList.code).toBe(0);
    expect((lastJson() as { relPath: string }[]).map((i) => i.relPath)).toEqual(['gone.txt']);
  });
});

describe('--json contracts for scripts', () => {
  it('reports not-running, engine errors, and non-empty lists in parseable JSON with the documented exit codes', async () => {
    // Not running: {running:false} and exit 3.
    const notRunning = await cli('status', '--json');
    expect(notRunning.code).toBe(3);
    expect((lastJson() as { running: boolean })).toEqual({ running: false });

    fake.seedFile(syncFolderUid, 'x.txt', 'X');
    const engine = startEngine();
    await engine.waitForStatus((s) => s.state === 'idle' && s.counts.baseline === 1);

    // An engine-side error (unknown held id) is {ok:false,error} and exit 1.
    const badConfirm = await cli('held', 'confirm', 'held-999', '--json');
    expect(badConfirm.code).toBe(1);
    const err = (lastJson() as { ok: boolean; error: string });
    expect(err.ok).toBe(false);
    expect(typeof err.error).toBe('string');

    // Empty control lists are valid JSON arrays a script can parse.
    for (const cmd of ['conflicts', 'quarantine']) {
      const r = await cli(cmd, '--json');
      expect(r.code).toBe(0);
      expect(Array.isArray(lastJson())).toBe(true);
    }
    const heldNone = await cli('held', '--json');
    expect(heldNone.code).toBe(0);
    expect(lastJson()).toBeNull(); // no held plan -> null

    engine.stop();
    expect(await engine.running).toBe(0);
  });
});

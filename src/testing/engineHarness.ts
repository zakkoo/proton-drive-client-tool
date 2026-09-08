/**
 * Engine harness for tests: a fully wired SyncEngine over a temp root and the
 * fake remote, with fast timers.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog } from '../audit/logger.js';
import { SecretRegistry } from '../audit/redact.js';
import { readRootIdentity } from '../config/localRoot.js';
import { resolveAppPaths, type AppPaths } from '../config/paths.js';
import { parseConfig, type SyncConfig } from '../config/schema.js';
import { createEngine, type EngineBundle, type EngineFactoryOptions } from '../engine/factory.js';
import type { EngineStatus } from '../engine/status.js';
import { FakeRemote } from './fakeRemote.js';

export class EngineHarness {
  readonly base: string;
  readonly root: string;
  readonly paths: AppPaths;
  readonly fake = new FakeRemote();
  readonly remoteRootUid: string;
  readonly audit: AuditLog;
  readonly statuses: EngineStatus[] = [];
  config: SyncConfig;
  bundle: EngineBundle | null = null;
  private clock = 1_700_000_000_000;

  private constructor(configOverrides: Record<string, unknown>) {
    this.base = mkdtempSync(path.join(os.tmpdir(), 'pds-engine-'));
    this.root = path.join(this.base, 'root');
    mkdirSync(this.root);
    this.paths = resolveAppPaths({ PROTON_DRIVE_SYNC_DIR: path.join(this.base, 'app') }, this.base);
    this.remoteRootUid = this.fake.seedFolder(this.fake.rootUid, 'Sync').uid;
    this.audit = new AuditLog({ dir: this.paths.auditLogDir, registry: new SecretRegistry() });
    this.config = parseConfig({
      localRoot: this.root,
      remoteRoot: '/my-files/Sync',
      remoteRootNodeUid: this.remoteRootUid,
      localRootIdentity: readRootIdentity(this.root),
      timing: { debounceMs: 200, localScanIntervalMinutes: 60, remoteListingIntervalMinutes: 60, eventSilenceMinutes: 1 },
      ...configOverrides,
    });
  }

  static create(configOverrides: Record<string, unknown> = {}): EngineHarness {
    return new EngineHarness(configOverrides);
  }

  async start(options: Partial<EngineFactoryOptions> = {}): Promise<EngineBundle> {
    this.bundle = await createEngine({
      config: this.config,
      paths: this.paths,
      remote: this.fake,
      audit: this.audit,
      now: () => ++this.clock,
      timers: { watcherDebounceMs: 120, watcherSettleMs: 40, feedPollMs: 60, triggerDebounceMs: 30 },
      ...options,
    });
    this.bundle.engine.on('status', (s: EngineStatus) => this.statuses.push(s));
    await this.bundle.engine.start();
    return this.bundle;
  }

  /** Simulate a restart of the process. */
  async restart(): Promise<EngineBundle> {
    await this.bundle?.dispose();
    this.bundle = null;
    return this.start();
  }

  async dispose(): Promise<void> {
    await this.bundle?.dispose();
    rmSync(this.base, { recursive: true, force: true });
  }

  write(relPath: string, content: string): void {
    const abs = path.join(this.root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const t = new Date(++this.clock);
    utimesSync(abs, t, t);
  }

  localFiles(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (rel === '' && e.name === '.proton-sync') continue;
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else out.set(r, readFileSync(path.join(dir, e.name), 'utf8'));
      }
    };
    walk(this.root, '');
    return out;
  }

  remoteFiles(): Map<string, string> {
    const out = new Map<string, string>();
    for (const n of this.fake.allNodes()) {
      if (n.type !== 'file' || n.isTrashed) continue;
      const p = this.fake.pathOf(n.uid);
      if (p.startsWith('/Sync/')) out.set(p.slice('/Sync/'.length), this.fake.contentOf(n.uid)?.toString() ?? '');
    }
    return out;
  }

  remotePathToUid(relPath: string): string | undefined {
    return this.fake.allNodes().find((n) => !n.isTrashed && this.fake.pathOf(n.uid) === `/Sync/${relPath}`)?.uid;
  }

  states(): string[] {
    const out: string[] = [];
    for (const s of this.statuses) if (out.at(-1) !== s.state) out.push(s.state);
    return out;
  }

  /** Wait until the engine reports one of the given states (or time out). */
  async waitFor(states: string[], timeoutMs = 5000): Promise<EngineStatus> {
    const start = Date.now();
    for (;;) {
      const s = this.bundle?.engine.getStatus();
      if (s !== undefined && states.includes(s.state)) return s;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${states.join('|')}; current ${s?.state ?? 'none'} (${s?.reason ?? ''})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Wait until both sides hold the same files and the engine is resting. */
  async waitForConvergence(timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const s = this.bundle?.engine.getStatus();
      const same = JSON.stringify([...this.localFiles().entries()].sort()) === JSON.stringify([...this.remoteFiles().entries()].sort());
      if (same && s !== undefined && (s.state === 'idle' || s.state === 'attention')) return;
      if (Date.now() - start > timeoutMs) throw new Error(`no convergence: state ${s?.state ?? 'none'} (${s?.reason ?? ''}); local ${JSON.stringify([...this.localFiles()])} remote ${JSON.stringify([...this.remoteFiles()])}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

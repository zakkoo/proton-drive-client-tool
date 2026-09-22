import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../audit/logger.js';
import { SecretRegistry } from '../audit/redact.js';
import { loadConfigFile } from '../config/configFile.js';
import { resolveAppPaths } from '../config/paths.js';
import { LoginError } from '../remote/proton/auth.js';
import { FakeRemote } from '../testing/fakeRemote.js';
import { CliError, dispatch, doctorReport, type CommandDeps, type CommandRuntime } from './commands.js';
import { parseCli } from './main.js';

let base: string;
let root: string;
let fake: FakeRemote;
let stdout: string[];
let stderr: string[];
let loggedIn: boolean;
let deps: CommandDeps;
let stopRun: (() => void) | null;

function makeDeps(): CommandDeps {
  const paths = resolveAppPaths({ PROTON_DRIVE_SYNC_DIR: path.join(base, 'app') }, base);
  const audit = new AuditLog({ dir: paths.auditLogDir, registry: new SecretRegistry() });
  const runtime = (): CommandRuntime => ({
    remote: fake,
    session: { current: loggedIn ? 'logged_in' : 'needs_login' },
    auth: {
      loginViaWeb: async (onUrl) => {
        await onUrl('https://account.example.test/desktop/login#payload=x');
        loggedIn = true;
      },
      loginViaPassword: (username, password, second) => {
        if (password !== 'good') return Promise.reject(new LoginError('Invalid username or password', 'invalid_credentials'));
        loggedIn = true;
        return second === undefined ? Promise.resolve({}) : second().then(() => ({}));
      },
      logout: () => {
        loggedIn = false;
        return Promise.resolve();
      },
    },
    clearCaches: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  });
  let stopRunResolve: () => void = () => undefined;
  const runUntil = new Promise<void>((r) => (stopRunResolve = r));
  stopRun = stopRunResolve;
  return {
    ctx: { paths, config: loadConfigFile(paths.configFile), audit, logSink: () => undefined, logLevel: 'error' },
    createRuntime: () => Promise.resolve(runtime()),
    prompt: (q) => Promise.resolve(q.startsWith('Password') ? 'good' : q.startsWith('Two') ? '123456' : 'user@example.test'),
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    openBrowser: () => undefined,
    sessionPresent: () => Promise.resolve(loggedIn),
    runUntil,
    engineTimers: { watcherDebounceMs: 100, watcherSettleMs: 30, feedPollMs: 60, triggerDebounceMs: 20 },
  };
}

async function cli(...argv: string[]): Promise<number> {
  deps = makeDeps();
  return dispatch(deps, parseCli(argv));
}

beforeEach(() => {
  base = mkdtempSync(path.join(os.homedir(), '.cache', 'pds-cli-'));
  root = path.join(base, 'Drive');
  mkdirSync(root);
  fake = new FakeRemote();
  fake.seedFolder(fake.rootUid, 'Sync');
  stdout = [];
  stderr = [];
  loggedIn = false;
  stopRun = null;
});
afterEach(async () => {
  stopRun?.();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(base, { recursive: true, force: true });
});

describe('CLI', () => {
  it('prints usage, rejects unknown commands, and parses flags', async () => {
    expect(await cli()).toBe(0);
    expect(stdout[0]).toContain('Usage: proton-drive-sync');
    await expect(cli('bogus')).rejects.toBeInstanceOf(CliError);
    const parsed = parseCli(['run', '--dry-run', '--paused', '--no-tray', '--json', '--log-level', 'debug']);
    expect(parsed).toMatchObject({ command: 'run', dryRun: true, paused: true, tray: false, json: true, logLevel: 'debug' });
  });

  it('login via browser and via password (with second factor), and logout', async () => {
    expect(await cli('login')).toBe(0);
    expect(stderr.join('\n')).toContain('account.example.test');
    expect(stdout.at(-1)).toBe('Login successful.');
    expect(loggedIn).toBe(true);
    expect(await cli('logout', '--json')).toBe(0);
    expect(JSON.parse(stdout.at(-1) ?? '{}')).toEqual({ ok: true });
    expect(loggedIn).toBe(false);
    expect(await cli('login', '--password')).toBe(0);
    expect(loggedIn).toBe(true);
    // Wrong password surfaces as a CLI error with the reason.
    deps = makeDeps();
    deps.prompt = (q) => Promise.resolve(q.startsWith('Password') ? 'wrong' : 'user');
    await expect(dispatch(deps, parseCli(['login', '--password']))).rejects.toThrow(/invalid_credentials/);
  });

  it('setup requires login, validates arguments, and records the pair', async () => {
    await expect(cli('setup', root, '/my-files/Sync')).rejects.toThrow(/not logged in/);
    loggedIn = true;
    await expect(cli('setup', root)).rejects.toThrow(/usage: setup/);
    await expect(cli('setup', root, '/my-files/Missing')).rejects.toThrow(/does not exist/);
    expect(await cli('setup', root, '/my-files/Sync', '--json')).toBe(0);
    const result = JSON.parse(stdout.at(-1) ?? '{}') as { config: { remoteRootNodeUid: string; localRoot: string }; pairChanged: boolean };
    expect(result.config.localRoot).toBe(root);
    expect(result.config.remoteRootNodeUid).toBeDefined();
    expect(result.pairChanged).toBe(false);
    expect(loadConfigFile(deps.ctx.paths.configFile)?.remoteRootNodeUid).toBe(result.config.remoteRootNodeUid);
  });

  it('run syncs, and status/pause/resume/sync-now/conflicts/quarantine/held work over the socket; dry-run and paused flags are persisted', async () => {
    loggedIn = true;
    expect(await cli('setup', root, '/my-files/Sync')).toBe(0);
    writeFileSync(path.join(root, 'a.txt'), 'A');
    fake.seedFile(fake.allNodes().find((n) => n.name === 'Sync')?.uid ?? '', 'b.txt', 'B');

    // Not running yet: socket commands report that.
    expect(await cli('status')).toBe(3);
    expect(stdout.at(-1)).toMatch(/not running/);

    const runDeps = makeDeps();
    const stop = stopRun;
    const running = dispatch(runDeps, parseCli(['run', '--no-tray']));
    // Wait for the engine to converge, polling the socket.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      stdout = [];
      if ((await cli('status', '--json')) === 0) {
        const s = JSON.parse(stdout.at(-1) ?? '{}') as { state: string; counts?: { baseline: number } };
        if (s.state === 'idle' && s.counts?.baseline === 2) break;
      }
    }
    expect(readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('B');
    expect(fake.allNodes().some((n) => n.name === 'a.txt')).toBe(true);

    expect(await cli('pause')).toBe(0);
    expect(stdout.at(-1)).toMatch(/Paused/);
    expect(await cli('resume', '--json')).toBe(0);
    expect(await cli('sync-now')).toBe(0);
    expect(await cli('conflicts')).toBe(0);
    expect(stdout.at(-1)).toBe('No open conflicts.');
    expect(await cli('quarantine')).toBe(0);
    expect(stdout.at(-1)).toBe('Nothing is quarantined.');
    expect(await cli('held')).toBe(0);
    expect(stdout.at(-1)).toBe('No held plan.');
    await expect(cli('conflicts', 'resolve', 'x', 'keep_both')).rejects.toThrow(/usage: conflicts resolve/);
    await expect(cli('quarantine', 'release', 'nope')).rejects.toThrow(/usage: quarantine release/);
    await expect(cli('held', 'confirm')).rejects.toThrow(/usage: held confirm/);
    expect(await cli('held', 'confirm', 'held-42')).toBe(1); // error from the engine is reported, not thrown
    expect(stderr.at(-1)).toMatch(/No held plan/);
    // A second `run` is refused while the first is active.
    await expect(cli('run', '--no-tray')).rejects.toThrow(/already running/);

    stop?.();
    expect(await running).toBe(0);
    expect(await cli('status')).toBe(3);

    // History of a synced file and the recycle bin commands work offline.
    expect(await cli('history', 'a.txt')).toBe(0);
    expect(stdout.join('\n')).toMatch(/upload a\.txt/);
    expect(await cli('recycle')).toBe(0);
    expect(stdout.at(-1)).toBe('Recycle bin is empty.');
    expect(await cli('recycle', 'purge')).toBe(0);
    expect(stdout.at(-1)).toBe('Nothing to purge.');

    // Flags apply to this invocation only and are not persisted into the configuration.
    const flagDeps = makeDeps();
    const stop2 = stopRun;
    const running2 = dispatch(flagDeps, parseCli(['run', '--dry-run', '--paused', '--no-tray']));
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 30));
      stdout = [];
      if ((await cli('status', '--json')) === 0) break;
    }
    const cfg = loadConfigFile(flagDeps.ctx.paths.configFile);
    expect(cfg?.dryRun).toBe(false);
    expect(cfg?.startPaused).toBe(false);
    stdout = [];
    expect(await cli('status', '--json')).toBe(0);
    const s = JSON.parse(stdout.at(-1) ?? '{}') as { state: string; dryRun: boolean };
    expect(s.state).toBe('paused');
    expect(s.dryRun).toBe(true);
    stop2?.();
    expect(await running2).toBe(0);
  }, 60_000);

  it('run refuses to start when not configured', async () => {
    await expect(cli('run', '--no-tray')).rejects.toThrow(/not configured/);
  });

  it('doctor --json reports a boolean login flag and drops session material', async () => {
    const secret = 'SESSION-SECRET-VALUE';
    deps = makeDeps();
    deps.sessionPresent = () => Promise.resolve(secret.length > 0);
    (deps.ctx as { session?: string }).session = secret;
    expect(await dispatch(deps, parseCli(['doctor', '--json']))).toBe(0);
    const parsed = JSON.parse(stdout.at(-1) ?? '{}') as Record<string, unknown>;
    expect(parsed['loggedIn']).toBe(true);
    expect(typeof parsed['loggedIn']).toBe('boolean');
    expect(parsed['configured']).toBe(false);
    expect(parsed['running']).toBe(false);
    expect(parsed['detailUrl']).toBeNull();
    expect(parsed['localRoot']).toBeNull();
    expect(parsed['remoteRoot']).toBeNull();
    expect(stdout.join('\n')).not.toContain(secret);
    expect(parsed).not.toHaveProperty('session');

    const input = {
      nodeOk: true,
      configured: false,
      loggedIn: false,
      running: false,
      localRoot: null,
      remoteRoot: null,
      detailUrl: null,
      session: secret,
    };
    const leaked = doctorReport(input);
    expect(JSON.stringify(leaked)).not.toContain(secret);
    expect(leaked.loggedIn).toBe(false);

    deps = makeDeps();
    deps.sessionPresent = () => Promise.resolve(false);
    stdout = [];
    expect(await dispatch(deps, parseCli(['doctor', '--json']))).toBe(0);
    expect((JSON.parse(stdout.at(-1) ?? '{}') as { loggedIn: boolean }).loggedIn).toBe(false);
  });

  it('details page is served with --no-tray and only while the engine is running', async () => {
    loggedIn = true;
    expect(await cli('setup', root, '/my-files/Sync')).toBe(0);
    expect(await cli('details', '--json')).toBe(3);
    expect(stdout.at(-1)).toMatch(/not running|running": false/);

    let trayStarted = false;
    const runDeps = makeDeps();
    runDeps.startTray = () => {
      trayStarted = true;
      return Promise.resolve({ dispose: () => Promise.resolve() });
    };
    const stop = stopRun;
    const running = dispatch(runDeps, parseCli(['run', '--no-tray']));
    let url = '';
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      stdout = [];
      if ((await cli('details', '--json')) === 0) {
        url = (JSON.parse(stdout.at(-1) ?? '{}') as { url?: string }).url ?? '';
        if (url.startsWith('http://127.0.0.1:')) break;
      }
    }
    expect(trayStarted).toBe(false);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/$/);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Proton Drive Sync');

    stop?.();
    expect(await running).toBe(0);
    expect(await cli('details')).toBe(3);
    expect(stdout.at(-1)).toMatch(/not running/);
  });
});

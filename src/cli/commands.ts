/**
 * CLI command implementations, separated from process wiring so they can be
 * exercised in-process against the fake remote.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { history } from '../audit/history.js';
import { saveConfigFile } from '../config/configFile.js';
import { adoptedRootIdentity, readRootIdentity } from '../config/localRoot.js';
import { ConfigError } from '../config/schema.js';
import { runSetup } from '../config/setup.js';
import { ControlClient, ControlServer, type ControlTarget } from '../engine/control.js';
import { createEngine, NotConfiguredError } from '../engine/factory.js';
import type { EngineStatus } from '../engine/status.js';
import type { RemoteDrive } from '../remote/interface.js';
import { LoginError } from '../remote/proton/auth.js';
import { SESSION_SECRET_NAME } from '../remote/proton/sessionCredentials.js';
import type { SessionState } from '../remote/proton/sessionState.js';
import { RecycleBin } from '../safety/recycle.js';
import { DetailPageServer } from '../tray/detailPage.js';
import { formatStatus, formatTable } from './output.js';
import { secretStoreFor, type CliContext } from './runtime.js';

/** The part of the Proton runtime the commands need; the fake provides the same shape in tests. */
export interface CommandRuntime {
  remote: RemoteDrive;
  session: Pick<SessionState, 'current'>;
  auth: {
    loginViaWeb(onSignInUrl: (url: string) => void | Promise<void>): Promise<unknown>;
    loginViaPassword(username: string, password: string, getSecondFactor?: () => Promise<string>): Promise<unknown>;
    logout(): Promise<void>;
  };
  clearCaches(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CommandDeps {
  ctx: CliContext;
  createRuntime: (onThrottle?: (state: 'throttled' | 'unthrottled') => void) => Promise<CommandRuntime>;
  prompt: (question: string, hidden?: boolean) => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openBrowser?: (url: string) => void;
  /** Tray starter; undefined means "no tray available". */
  startTray?: (options: { engine: unknown; controlTarget: unknown; detailUrl: string }) => Promise<{ dispose(): Promise<void> }>;
  /**
   * Whether a Proton session is stored. The default reads the secret store and
   * returns a boolean; overrides exist so tests never touch a real keyring.
   */
  sessionPresent?: () => Promise<boolean>;
  /** Test hook: resolves when `run` may stop (instead of waiting for a signal). */
  runUntil?: Promise<void>;
  /** Test hook: engine timers. */
  engineTimers?: { watcherDebounceMs?: number; watcherSettleMs?: number; feedPollMs?: number; triggerDebounceMs?: number };
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function out(deps: CommandDeps, json: boolean, human: string | string[], data: unknown): void {
  if (json) deps.stdout(JSON.stringify(data, null, 2));
  else deps.stdout((Array.isArray(human) ? human : [human]).join('\n'));
}

export async function login(deps: CommandDeps, usePassword: boolean, json: boolean): Promise<number> {
  const runtime = await deps.createRuntime();
  try {
    if (usePassword) {
      const username = await deps.prompt('Proton username or email: ');
      const password = await deps.prompt('Password: ', true);
      await runtime.auth.loginViaPassword(username, password, () => deps.prompt('Two-factor code: ', true));
    } else {
      await runtime.auth.loginViaWeb((url) => {
        if (json) out(deps, true, '', { signInUrl: url });
        else {
          deps.stderr('Sign in in your browser. Keep this terminal open until it completes.');
          deps.stderr(`If the browser did not open, visit:\n  ${url}`);
        }
        (deps.openBrowser ?? defaultOpenBrowser)(url);
      });
    }
    deps.ctx.audit.append({ kind: 'auth', message: 'login successful', outcome: 'ok' });
    out(deps, json, 'Login successful.', { ok: true });
    return 0;
  } catch (error) {
    if (error instanceof LoginError) {
      deps.ctx.audit.append({ kind: 'auth', message: `login failed: ${error.reason}`, outcome: 'failed', error: error.message });
      throw new CliError(`login failed (${error.reason}): ${error.message}`);
    }
    throw error;
  } finally {
    await runtime.dispose();
  }
}

export async function logout(deps: CommandDeps, json: boolean): Promise<number> {
  const runtime = await deps.createRuntime();
  try {
    await runtime.auth.logout();
    await runtime.clearCaches();
    deps.ctx.audit.append({ kind: 'auth', message: 'logged out', outcome: 'ok' });
    out(deps, json, 'Logged out.', { ok: true });
    return 0;
  } finally {
    await runtime.dispose();
  }
}

export async function setup(deps: CommandDeps, args: string[], json: boolean): Promise<number> {
  const [localArg, remoteArg] = args;
  if (localArg === undefined || remoteArg === undefined) throw new CliError('usage: setup <local-dir> <remote-folder>', 2);
  const localRoot = path.resolve(localArg);
  const runtime = await deps.createRuntime();
  try {
    if (runtime.session.current !== 'logged_in') throw new CliError('not logged in; run `proton-drive-sync login` first');
    const result = await runSetup({ localRoot, remoteRoot: remoteArg, configFile: deps.ctx.paths.configFile, remote: runtime.remote });
    deps.ctx.config = result.config;
    deps.ctx.audit.append({ kind: 'engine', op: 'setup', message: `sync pair configured: ${localRoot} <-> ${remoteArg}`, details: { remoteRootNodeUid: result.config.remoteRootNodeUid, pairChanged: result.pairChanged } });
    out(
      deps,
      json,
      [
        `Configured ${localRoot} <-> ${remoteArg}`,
        result.pairChanged ? 'The sync pair changed: the first run starts a fresh baseline (no deletes) and the old state is kept.' : 'Ready. Start with `proton-drive-sync run` (add --dry-run to preview).',
      ],
      { config: result.config, pairChanged: result.pairChanged },
    );
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message);
    throw error;
  } finally {
    await runtime.dispose();
  }
}

/**
 * Btrfs assigns a new device number when the volume is mounted. A config that
 * still has the old number describes the same directory; store the live one
 * so the next comparison can use the stable volume key.
 */
function refreshRecordedRoot(deps: CommandDeps, json: boolean): void {
  const { ctx } = deps;
  const recorded = ctx.config?.localRootIdentity;
  const localRoot = ctx.config?.localRoot;
  if (ctx.config === null || recorded === undefined || localRoot === undefined) return;
  let live;
  try {
    live = readRootIdentity(localRoot);
  } catch {
    return;
  }
  const adopted = adoptedRootIdentity(recorded, live);
  if (adopted === null) return;
  const persisted = { ...ctx.config, localRootIdentity: adopted };
  try {
    saveConfigFile(ctx.paths.configFile, persisted);
    ctx.config = persisted;
    ctx.audit.append({
      kind: 'safety',
      op: 'preflight',
      message: `recorded sync root device ${String(recorded.dev)} as ${String(adopted.dev)} for the same directory`,
      outcome: 'ok',
    });
  } catch (error) {
    ctx.config = persisted;
    if (!json) deps.stderr(`Could not update the recorded sync root identity in ${ctx.paths.configFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function run(deps: CommandDeps, flags: { dryRun: boolean; paused: boolean; tray: boolean }, json: boolean): Promise<number> {
  const { ctx } = deps;
  if (ctx.config === null) throw new CliError('not configured; run `proton-drive-sync setup <local-dir> <remote-folder>` first');
  refreshRecordedRoot(deps, json);
  // Command-line flags apply to this invocation only. Persisting them silently turned every
  // later `run` into a dry run, with no flag to undo it; the config file is the persistent switch.
  const config = { ...ctx.config, dryRun: ctx.config.dryRun || flags.dryRun, startPaused: ctx.config.startPaused || flags.paused };
  if (ctx.config.dryRun && !flags.dryRun && !json) {
    deps.stderr(`Dry-run mode is enabled in ${ctx.paths.configFile} ("dryRun": true); no changes will be made until you set it to false.`);
  }
  if (await ControlClient.probe(ctx.paths.controlSocket)) throw new CliError('another instance is already running (control socket answered)');

  let throttle: (state: 'throttled' | 'unthrottled') => void = () => undefined;
  const runtime = await deps.createRuntime((s) => { throttle(s); });
  let bundle;
  try {
    bundle = await createEngine({
      config,
      paths: ctx.paths,
      remote: runtime.remote,
      audit: ctx.audit,
      logSink: ctx.logSink,
      logLevel: ctx.logLevel,
      ...('onChange' in runtime.session ? { session: runtime.session as SessionState } : {}),
      ...(deps.engineTimers !== undefined ? { timers: deps.engineTimers } : {}),
    });
  } catch (error) {
    await runtime.dispose();
    if (error instanceof NotConfiguredError) throw new CliError(error.message);
    throw error;
  }
  const engine = bundle.engine;
  throttle = (s) => { engine.onThrottle(s); };
  const page = new DetailPageServer(bundle.controlTarget);
  try {
    await page.listen();
  } catch (error) {
    await page.close();
    await bundle.dispose();
    await runtime.dispose();
    throw error;
  }
  const controlTarget: ControlTarget = {
    ...bundle.controlTarget,
    detailUrl: () => page.url,
  };
  const control = new ControlServer(ctx.paths.controlSocket, controlTarget);
  try {
    await control.listen();
  } catch (error) {
    await page.close();
    await bundle.dispose();
    await runtime.dispose();
    throw error;
  }

  let tray: { dispose(): Promise<void> } | null = null;
  if (flags.tray && deps.startTray !== undefined) {
    try {
      tray = await deps.startTray({ engine: bundle.engine, controlTarget, detailUrl: page.url });
    } catch (error) {
      ctx.audit.append({ kind: 'engine', message: `tray unavailable: ${error instanceof Error ? error.message : String(error)}; continuing headless` });
      if (!json) deps.stderr('Tray unavailable; running headless. Use `proton-drive-sync status`.');
    }
  }
  engine.on('status', (s: EngineStatus) => {
    if (json) deps.stdout(JSON.stringify({ event: 'status', state: s.state, reason: s.reason }));
  });
  if (!json) deps.stderr(`Syncing ${config.localRoot} <-> ${config.remoteRoot}${config.dryRun ? ' (DRY RUN)' : ''}. Press Ctrl+C to stop.`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (!json) deps.stderr('Stopping...');
    await tray?.dispose();
    await page.close();
    await control.close();
    await bundle.dispose();
    await runtime.dispose();
  };
  const finished = new Promise<number>((resolve) => {
    const done = (): void => {
      void stop().then(() => { resolve(0); });
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    engine.on('status', (s: EngineStatus) => {
      if (s.state === 'stopped') done();
    });
    if (deps.runUntil !== undefined) void deps.runUntil.then(done);
  });
  await engine.start();
  return finished;
}

type ClientAction<T> = (client: ControlClient) => Promise<T>;

export async function viaSocket(deps: CommandDeps, json: boolean, human: ClientAction<string[]>, raw: ClientAction<unknown>): Promise<number> {
  const client = new ControlClient(deps.ctx.paths.controlSocket);
  try {
    await client.connect(3000);
  } catch {
    if (json) out(deps, true, '', { running: false });
    else deps.stdout('The sync engine is not running. Start it with `proton-drive-sync run`.');
    return 3;
  }
  try {
    if (json) out(deps, true, '', await raw(client));
    else out(deps, false, await human(client), null);
    return 0;
  } catch (error) {
    // The engine refused the request (e.g. unknown held plan id): report, do not crash.
    const message = error instanceof Error ? error.message : String(error);
    if (json) out(deps, true, '', { ok: false, error: message });
    else deps.stderr(`error: ${message}`);
    return 1;
  } finally {
    client.close();
  }
}

export function statusLike(deps: CommandDeps, json: boolean, cmd: 'status' | 'pause' | 'resume' | 'sync_now'): Promise<number> {
  return viaSocket(deps, json, async (c) => formatStatus(await c.request<EngineStatus>({ cmd })), (c) => c.request({ cmd }));
}

interface ConflictRow {
  id: number;
  relPath: string;
  kind: string;
  local: unknown;
  remote: unknown;
}

function formatConflicts(list: ConflictRow[]): string[] {
  if (list.length === 0) return ['No open conflicts.'];
  return formatTable([['ID', 'KIND', 'PATH', 'DETAILS'], ...list.map((c) => [String(c.id), c.kind, c.relPath, JSON.stringify({ local: c.local, remote: c.remote })])]);
}

export function conflicts(deps: CommandDeps, args: string[], json: boolean): Promise<number> {
  if (args[0] === 'resolve') {
    const id = Number(args[1]);
    const choice = args[2];
    if (!Number.isInteger(id) || (choice !== 'keep_local' && choice !== 'keep_remote' && choice !== 'keep_both')) throw new CliError('usage: conflicts resolve <id> keep_local|keep_remote|keep_both', 2);
    return viaSocket(deps, json, async (c) => formatConflicts(await c.request<ConflictRow[]>({ cmd: 'resolve', args: { id, choice } })), (c) => c.request({ cmd: 'resolve', args: { id, choice } }));
  }
  return viaSocket(deps, json, async (c) => formatConflicts(await c.request<ConflictRow[]>({ cmd: 'conflicts' })), (c) => c.request({ cmd: 'conflicts' }));
}

interface QuarantineRow {
  id: number;
  relPath: string | null;
  nodeUid: string | null;
  reason: string;
}

function formatQuarantine(list: QuarantineRow[]): string[] {
  return list.length === 0 ? ['Nothing is quarantined.'] : formatTable([['ID', 'PATH', 'NODE', 'REASON'], ...list.map((q) => [String(q.id), q.relPath ?? '-', q.nodeUid ?? '-', q.reason])]);
}

export function quarantine(deps: CommandDeps, args: string[], json: boolean): Promise<number> {
  if (args[0] === 'release') {
    const id = Number(args[1]);
    if (!Number.isInteger(id)) throw new CliError('usage: quarantine release <id>', 2);
    return viaSocket(deps, json, async (c) => formatQuarantine(await c.request<QuarantineRow[]>({ cmd: 'release', args: { id } })), (c) => c.request({ cmd: 'release', args: { id } }));
  }
  return viaSocket(deps, json, async (c) => formatQuarantine(await c.request<QuarantineRow[]>({ cmd: 'quarantine' })), (c) => c.request({ cmd: 'quarantine' }));
}

export function held(deps: CommandDeps, args: string[], json: boolean): Promise<number> {
  const action = args[0];
  if (action === 'confirm' || action === 'reject') {
    const id = args[1];
    if (id === undefined) throw new CliError(`usage: held ${action} <id>`, 2);
    return viaSocket(
      deps,
      json,
      async (c) => (action === 'confirm' ? formatStatus(await c.request<EngineStatus>({ cmd: 'confirm', args: { id } })) : [`Rejected. ${String((await c.request<unknown[]>({ cmd: 'reject', args: { id } })).length)} operation(s) discarded.`]),
      (c) => c.request(action === 'confirm' ? { cmd: 'confirm', args: { id } } : { cmd: 'reject', args: { id } }),
    );
  }
  return viaSocket(
    deps,
    json,
    async (c) => {
      const s = await c.request<EngineStatus>({ cmd: 'status' });
      const h = s.attention.heldPlan;
      if (h === null) return ['No held plan.'];
      return [`Held plan ${h.id}: ${h.reason}`, ...h.affected.map((a) => `  ${a}`), '', `Decide with: proton-drive-sync held confirm ${h.id}   or   held reject ${h.id}`];
    },
    async (c) => (await c.request<EngineStatus>({ cmd: 'status' })).attention.heldPlan,
  );
}

export interface DoctorReport {
  nodeOk: boolean;
  configured: boolean;
  loggedIn: boolean;
  running: boolean;
  localRoot: string | null;
  remoteRoot: string | null;
  detailUrl: string | null;
}

/** Copy only the doctor fields. Anything else, including a session, is dropped. */
export function doctorReport(fields: DoctorReport): DoctorReport {
  return {
    nodeOk: fields.nodeOk,
    configured: fields.configured,
    loggedIn: fields.loggedIn,
    running: fields.running,
    localRoot: fields.localRoot,
    remoteRoot: fields.remoteRoot,
    detailUrl: fields.detailUrl,
  };
}

export function loopbackDetailsUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return null;
    return url;
  } catch {
    return null;
  }
}

async function sessionIsStored(deps: CommandDeps): Promise<boolean> {
  if (deps.sessionPresent !== undefined) return deps.sessionPresent();
  try {
    const value = await secretStoreFor(deps.ctx).get(SESSION_SECRET_NAME);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}

async function runningDetailUrl(deps: CommandDeps): Promise<string | null> {
  if (!(await ControlClient.probe(deps.ctx.paths.controlSocket))) return null;
  const client = new ControlClient(deps.ctx.paths.controlSocket);
  try {
    await client.connect(1000);
    const result = await client.request<{ url?: unknown }>({ cmd: 'details' });
    return loopbackDetailsUrl(result.url);
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function doctor(deps: CommandDeps, json: boolean): Promise<number> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const config = deps.ctx.config;
  const report = doctorReport({
    nodeOk: Number.isFinite(nodeMajor) && nodeMajor >= 24,
    configured: config !== null,
    loggedIn: await sessionIsStored(deps),
    running: await ControlClient.probe(deps.ctx.paths.controlSocket),
    localRoot: config?.localRoot ?? null,
    remoteRoot: config?.remoteRoot ?? null,
    detailUrl: await runningDetailUrl(deps),
  });
  const human = [
    `Node.js 24: ${report.nodeOk ? 'ok' : 'missing'}`,
    `Configured: ${report.configured ? 'yes' : 'no'}`,
    `Signed in: ${report.loggedIn ? 'yes' : 'no'}`,
    `Running: ${report.running ? 'yes' : 'no'}`,
    `Local folder: ${report.localRoot ?? '-'}`,
    `Remote folder: ${report.remoteRoot ?? '-'}`,
    `Details: ${report.detailUrl ?? '-'}`,
  ];
  out(deps, json, human, report);
  return 0;
}

export function details(deps: CommandDeps, json: boolean): Promise<number> {
  return viaSocket(
    deps,
    json,
    async (client) => {
      const result = await client.request<{ url?: unknown }>({ cmd: 'details' });
      const url = loopbackDetailsUrl(result.url);
      if (url === null) throw new Error('details page URL is not loopback');
      return [url];
    },
    async (client) => {
      const result = await client.request<{ url?: unknown }>({ cmd: 'details' });
      const url = loopbackDetailsUrl(result.url);
      if (url === null) throw new Error('details page URL is not loopback');
      return { url };
    },
  );
}

export function showHistory(deps: CommandDeps, args: string[], json: boolean): number {
  const [target] = args;
  if (target === undefined) throw new CliError('usage: history <path|nodeUid>', 2);
  const { entries } = deps.ctx.audit.readAll();
  const byPath = entries.some((e) => e.path === target || e.previousPath === target);
  const result = history(entries, byPath ? { path: target } : { nodeUid: target });
  out(deps, json, result.length === 0 ? ['No history found.'] : result.map((e) => `${e.ts} ${e.kind.padEnd(9)} ${e.op ?? ''} ${e.message}${e.outcome !== undefined ? ` [${e.outcome}]` : ''}`), result);
  return 0;
}

export function recycle(deps: CommandDeps, args: string[], json: boolean): number {
  const { ctx } = deps;
  if (ctx.config === null) throw new CliError('not configured');
  const bin = new RecycleBin(ctx.config.localRoot, ctx.config.safety.recycleRetentionDays, ctx.audit);
  if (args[0] === 'purge') {
    const removed = bin.purge();
    out(deps, json, removed.length === 0 ? ['Nothing to purge.'] : [`Purged ${String(removed.length)} file(s) older than ${String(ctx.config.safety.recycleRetentionDays)} days:`, ...removed.map((p) => `  ${p}`)], { removed });
    return 0;
  }
  const items = bin.list().filter((i) => i.kind === 'file');
  out(deps, json, items.length === 0 ? ['Recycle bin is empty.'] : formatTable([['RECYCLED AT', 'PATH'], ...items.map((i) => [new Date(i.bucket).toISOString(), i.relPath])]), items);
  return 0;
}

function defaultOpenBrowser(url: string): void {
  try {
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // no opener available; the URL was printed
  }
}

export const USAGE = `Usage: proton-drive-sync <command> [options]

Commands:
  login [--password]                 Sign in. Opens the browser; --password uses SRP login (TOTP supported).
  logout                             Sign out and forget the stored session.
  setup <local-dir> <remote-folder>  Configure the sync pair, e.g. setup ~/ProtonDrive /my-files
  run [--dry-run] [--paused] [--no-tray]
                                     Run the sync engine (foreground). The details page is served either way.
  doctor                             Report install, sign-in, and whether the engine is running.
  status                             Show engine status (works only while \`run\` is active).
  details                            Print the loopback details page URL of the running engine.
  pause | resume | sync-now          Control the running engine.
  conflicts [resolve <id> <choice>]  List conflicts; choice: keep_local | keep_remote | keep_both
  quarantine [release <id>]          List quarantined items or release one.
  held [confirm|reject <id>]         Show or decide the held (braked) plan.
  history <path|nodeUid>             Audit history of one item.
  recycle [purge]                    List the recycle bin, or purge entries older than the retention period.

Global options:
  --json                             Machine-readable output.
  --log-level <level>                debug | info | warn | error (default info)
`;

export interface ParsedArgs {
  command: string | undefined;
  rest: string[];
  json: boolean;
  password: boolean;
  dryRun: boolean;
  paused: boolean;
  tray: boolean;
  help: boolean;
  logLevel: string | undefined;
}

/** Dispatch a parsed command line. Throws CliError for user errors. */
export async function dispatch(deps: CommandDeps, args: ParsedArgs): Promise<number> {
  const { command, rest, json } = args;
  if (command === undefined || args.help || command === 'help') {
    deps.stdout(USAGE);
    return 0;
  }
  switch (command) {
    case 'login':
      return login(deps, args.password, json);
    case 'logout':
      return logout(deps, json);
    case 'setup':
      return setup(deps, rest, json);
    case 'run':
      return run(deps, { dryRun: args.dryRun, paused: args.paused, tray: args.tray }, json);
    case 'doctor':
      return doctor(deps, json);
    case 'status':
      return statusLike(deps, json, 'status');
    case 'pause':
      return statusLike(deps, json, 'pause');
    case 'resume':
      return statusLike(deps, json, 'resume');
    case 'sync-now':
      return statusLike(deps, json, 'sync_now');
    case 'details':
      return details(deps, json);
    case 'conflicts':
      return conflicts(deps, rest, json);
    case 'quarantine':
      return quarantine(deps, rest, json);
    case 'held':
      return held(deps, rest, json);
    case 'history':
      return showHistory(deps, rest, json);
    case 'recycle':
      return recycle(deps, rest, json);
    default:
      throw new CliError(`unknown command ${command}\n\n${USAGE}`, 2);
  }
}

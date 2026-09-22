/**
 * Control protocol: JSON lines over a Unix socket.
 *
 * Request:  {"id": 1, "cmd": "status"}            -> {"id": 1, "ok": true, "result": {...}}
 *           {"id": 2, "cmd": "confirm", "args": {"id": "held-1"}}
 * Push:     {"event": "status", "status": {...}}   (to every connected client)
 *
 * The tray and the `status` CLI command are both clients of this protocol.
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import type { Resolution } from '../conflict/handler.js';
import type { RecycledItem } from '../safety/recycle.js';
import type { ConflictEntry, QuarantineEntry } from '../state/misc.ts';
import type { EngineStatus } from './status.js';

export type ControlCommand =
  | { cmd: 'status' }
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'sync_now' }
  | { cmd: 'confirm'; args: { id: string } }
  | { cmd: 'reject'; args: { id: string } }
  | { cmd: 'conflicts' }
  | { cmd: 'resolve'; args: { id: number; choice: Resolution } }
  | { cmd: 'quarantine' }
  | { cmd: 'release'; args: { id: number } }
  | { cmd: 'recycle' }
  | { cmd: 'details' }
  | { cmd: 'quit' };

export interface ControlTarget {
  getStatus(): EngineStatus;
  pause(): void;
  resume(): void;
  syncNow(): Promise<unknown>;
  confirmHeldPlan(id: string): Promise<unknown>;
  rejectHeldPlan(id: string): unknown;
  listConflicts(): ConflictEntry[];
  resolveConflict(id: number, choice: Resolution): Promise<void>;
  listQuarantine(): QuarantineEntry[];
  releaseQuarantine(id: number): void;
  listRecycle(): RecycledItem[];
  quit(): Promise<void>;
  onStatus(listener: (status: EngineStatus) => void): () => void;
  /** Loopback details page for this process, when `run` has bound one. */
  detailUrl?: () => string | null;
}

interface Request {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
}

export class ControlServer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly target: ControlTarget,
  ) {}

  async listen(): Promise<void> {
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      // Stale socket from a crashed instance? Only remove it if nobody answers.
      const alive = await ControlClient.probe(this.socketPath);
      if (alive) throw new Error(`Another instance is listening on ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    this.server = createServer((socket) => { this.accept(socket); });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.socketPath, () => { resolve(); });
    });
    this.unsubscribe = this.target.onStatus((status) => { this.broadcast({ event: 'status', status }); });
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== '') void this.handleLine(socket, line);
        nl = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    this.send(socket, { event: 'status', status: this.target.getStatus() });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      this.send(socket, { id: null, ok: false, error: 'invalid JSON' });
      return;
    }
    try {
      const result = await this.dispatch(request);
      this.send(socket, { id: request.id, ok: true, result });
    } catch (error) {
      this.send(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(request: Request): Promise<unknown> {
    const args = request.args ?? {};
    const str = (k: string): string => {
      const v = args[k];
      if (typeof v !== 'string') throw new Error(`argument ${k} must be a string`);
      return v;
    };
    const num = (k: string): number => {
      const v = args[k];
      if (typeof v !== 'number') throw new Error(`argument ${k} must be a number`);
      return v;
    };
    switch (request.cmd) {
      case 'status':
        return this.target.getStatus();
      case 'pause':
        this.target.pause();
        return this.target.getStatus();
      case 'resume':
        this.target.resume();
        return this.target.getStatus();
      case 'sync_now':
        await this.target.syncNow();
        return this.target.getStatus();
      case 'confirm':
        await this.target.confirmHeldPlan(str('id'));
        return this.target.getStatus();
      case 'reject':
        return this.target.rejectHeldPlan(str('id'));
      case 'conflicts':
        return this.target.listConflicts();
      case 'resolve': {
        const choice = str('choice');
        if (choice !== 'keep_local' && choice !== 'keep_remote' && choice !== 'keep_both') throw new Error('choice must be keep_local, keep_remote or keep_both');
        await this.target.resolveConflict(num('id'), choice);
        return this.target.listConflicts();
      }
      case 'quarantine':
        return this.target.listQuarantine();
      case 'release':
        this.target.releaseQuarantine(num('id'));
        return this.target.listQuarantine();
      case 'recycle':
        return this.target.listRecycle();
      case 'details':
        return { url: this.target.detailUrl?.() ?? null };
      case 'quit':
        setTimeout(() => void this.target.quit(), 10);
        return { quitting: true };
      default:
        throw new Error(`unknown command ${request.cmd}`);
    }
  }

  private send(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  }

  private broadcast(message: unknown): void {
    for (const c of this.clients) this.send(c, message);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (this.server === null) { resolve(); return; }
      this.server.close(() => { resolve(); });
    });
    this.server = null;
    try {
      unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }
}

export class ControlClient {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly statusListeners = new Set<(s: EngineStatus) => void>();

  constructor(private readonly socketPath: string) {}

  /** True when a server answers on the socket. */
  static async probe(socketPath: string): Promise<boolean> {
    const client = new ControlClient(socketPath);
    try {
      await client.connect(1000);
      await client.request({ cmd: 'status' });
      return true;
    } catch {
      return false;
    } finally {
      client.close();
    }
  }

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timeout connecting to ${this.socketPath}`));
      }, timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on('data', (chunk: string) => { this.onData(chunk); });
      socket.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf('\n');
      if (line.trim() === '') continue;
      const msg = JSON.parse(line) as { id?: number | null; ok?: boolean; result?: unknown; error?: string; event?: string; status?: EngineStatus };
      if (msg.event === 'status' && msg.status !== undefined) {
        for (const l of this.statusListeners) l(msg.status);
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p === undefined) continue;
        this.pending.delete(msg.id);
        if (msg.ok === true) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'request failed'));
      }
    }
  }

  onStatus(listener: (s: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  request<T = unknown>(command: ControlCommand): Promise<T> {
    if (this.socket === null) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const message = { id, cmd: command.cmd, ...('args' in command ? { args: command.args } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => { resolve(v as T); }, reject });
      this.socket?.write(JSON.stringify(message) + '\n');
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

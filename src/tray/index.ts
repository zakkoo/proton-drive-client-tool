/**
 * Tray entry point: StatusNotifierItem over D-Bus, desktop notifications and
 * the local detail page. When no tray host is available, `startTray` rejects
 * and the engine keeps running headless (the CLI `status` command shows the
 * same information).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import type { AuditLog } from '../audit/logger.js';
import { INTERNAL_DIR_NAME, type AppPaths } from '../config/paths.js';
import type { SyncConfig } from '../config/schema.js';
import type { ControlTarget } from '../engine/control.js';
import type { SyncEngine } from '../engine/engine.js';
import type { EngineStatus } from '../engine/status.js';
import { createLogger, type LogSink } from '../remote/proton/logger.js';
import { DetailPageServer } from './detailPage.js';
import { buildTrayModel, dispatchMenuAction, type MenuAction, type TrayModel } from './menuModel.js';
import { initialTracker, notificationsFor, type Notifier } from './notify.js';
import { startStatusNotifierItem, type SniHandle } from './sni.js';

export interface TrayOptions {
  engine: SyncEngine;
  controlTarget: ControlTarget;
  config: SyncConfig;
  paths: AppPaths;
  audit: AuditLog;
  logSink: LogSink;
  /** Test hooks. */
  openExternal?: (target: string) => void;
  busAddress?: string;
  sniTimeoutMs?: number;
}

export interface TrayHandle {
  detailUrl: string;
  dispose(): Promise<void>;
}

function xdgOpen(target: string): void {
  try {
    const child = spawn('xdg-open', [target], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // no opener available
  }
}

export async function startTray(options: TrayOptions): Promise<TrayHandle> {
  const logger = createLogger('tray', options.logSink);
  const open = options.openExternal ?? xdgOpen;
  const { controlTarget, engine } = options;

  const page = new DetailPageServer(controlTarget);
  await page.listen();

  const model = (): TrayModel => buildTrayModel(controlTarget.getStatus(), controlTarget.listConflicts(), controlTarget.listQuarantine());

  const onAction = (action: MenuAction): void => {
    void (async () => {
      try {
        // Engine-control actions are the shared, tested wiring; open_* actions need host paths.
        if (await dispatchMenuAction(action, controlTarget)) return;
        const opens: Partial<Record<MenuAction['type'], () => void>> = {
          open_folder: () => { open(options.config.localRoot); },
          open_recycle: () => { open(path.join(options.config.localRoot, INTERNAL_DIR_NAME, 'recycle')); },
          open_log: () => { open(options.paths.auditLogDir); },
          open_details: () => { open(page.url); },
          open_settings: () => { open(options.paths.configFile); },
        };
        opens[action.type]?.();
      } catch (error) {
        logger.error(`tray action ${action.type} failed`, error);
      }
    })();
  };

  let sni: SniHandle;
  try {
    sni = await startStatusNotifierItem(model(), onAction, {
      ...(options.busAddress !== undefined ? { busAddress: options.busAddress } : {}),
      ...(options.sniTimeoutMs !== undefined ? { timeoutMs: options.sniTimeoutMs } : {}),
    });
  } catch (error) {
    await page.close();
    throw new Error(`no tray host available: ${error instanceof Error ? error.message : String(error)}`);
  }
  const notifier: Notifier = sni.notifier;
  let tracker = initialTracker(controlTarget.getStatus());
  const onStatus = (status: EngineStatus): void => {
    sni.update(model());
    const { notifications, next } = notificationsFor(tracker, status);
    tracker = next;
    for (const n of notifications) {
      void notifier.notify(n).catch((e: unknown) => {
        logger.warn(`notification failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };
  engine.on('status', onStatus);
  options.audit.append({ kind: 'engine', message: `tray started; details page at ${page.url}` });

  return {
    detailUrl: page.url,
    dispose: async () => {
      engine.off('status', onStatus);
      await sni.dispose();
      await page.close();
    },
  };
}

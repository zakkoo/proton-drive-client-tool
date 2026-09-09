/**
 * Pure tray model: icon, tooltip and menu derived from the engine status and
 * the attention lists. No D-Bus here, so it is fully unit-testable.
 */
import type { EngineState, EngineStatus } from '../engine/status.js';
import type { ConflictEntry, QuarantineEntry } from '../state/misc.ts';

export type MenuAction =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'sync_now' }
  | { type: 'open_folder' }
  | { type: 'open_recycle' }
  | { type: 'open_log' }
  | { type: 'open_details' }
  | { type: 'open_settings' }
  | { type: 'confirm_held'; id: string }
  | { type: 'reject_held'; id: string }
  | { type: 'resolve_conflict'; id: number; choice: 'keep_local' | 'keep_remote' | 'keep_both' }
  | { type: 'release_quarantine'; id: number }
  | { type: 'quit' };

export interface MenuItem {
  id: number;
  label: string;
  enabled: boolean;
  separator?: boolean;
  action?: MenuAction;
  children?: MenuItem[];
}

export interface TrayModel {
  /** Freedesktop icon name. */
  iconName: string;
  /** SNI status: Active, NeedsAttention or Passive. */
  sniStatus: 'Active' | 'NeedsAttention' | 'Passive';
  title: string;
  tooltip: { title: string; description: string };
  menu: MenuItem[];
}

const ICONS: Record<EngineState, string> = {
  starting: 'emblem-synchronizing',
  idle: 'emblem-default',
  scanning: 'emblem-synchronizing',
  syncing: 'emblem-synchronizing',
  paused: 'media-playback-pause',
  offline: 'network-offline',
  throttled: 'emblem-synchronizing',
  attention: 'dialog-warning',
  awaiting_confirmation: 'dialog-question',
  error: 'dialog-error',
  needs_login: 'dialog-password',
  stopped: 'process-stop',
};

export function iconFor(state: EngineState): string {
  return ICONS[state];
}

export function buildTrayModel(status: EngineStatus, conflicts: ConflictEntry[], quarantine: QuarantineEntry[]): TrayModel {
  let nextId = 1;
  const id = (): number => nextId++;
  const item = (label: string, action?: MenuAction, enabled = true): MenuItem => ({ id: id(), label, enabled, ...(action !== undefined ? { action } : {}) });
  const separator = (): MenuItem => ({ id: id(), label: '', enabled: false, separator: true });

  const attention = status.attention.conflicts > 0 || status.attention.quarantined > 0 || status.attention.heldPlan !== null;
  const sniStatus: TrayModel['sniStatus'] = attention || status.state === 'attention' || status.state === 'error' || status.state === 'needs_login' || status.state === 'awaiting_confirmation' ? 'NeedsAttention' : 'Active';

  const menu: MenuItem[] = [];
  for (const line of status.summaryLines.slice(0, 4)) menu.push(item(line, undefined, false));
  for (const t of status.transfers.slice(0, 5)) {
    const pct = t.total !== undefined && t.total > 0 ? ` ${String(Math.round((t.bytes / t.total) * 100))}%` : '';
    menu.push(item(`${t.kind === 'upload' ? '↑' : '↓'} ${t.relPath}${pct}`, undefined, false));
  }
  menu.push(separator());
  if (status.state === 'paused') menu.push(item('Resume syncing', { type: 'resume' }));
  else menu.push(item('Pause syncing', { type: 'pause' }, status.state !== 'stopped' && status.state !== 'needs_login'));
  menu.push(item('Sync now', { type: 'sync_now' }, status.state !== 'paused' && status.state !== 'stopped' && status.state !== 'needs_login'));
  menu.push(separator());

  const held = status.attention.heldPlan;
  if (held !== null) {
    const children: MenuItem[] = [item(held.reason, undefined, false), separator()];
    for (const a of held.affected.slice(0, 15)) children.push(item(a, undefined, false));
    if (held.affected.length > 15) children.push(item(`… and ${String(held.affected.length - 15)} more (see details page)`, undefined, false));
    children.push(separator(), item('Proceed with these changes', { type: 'confirm_held', id: held.id }), item('Reject and keep everything', { type: 'reject_held', id: held.id }));
    menu.push({ id: id(), label: `Held plan: ${String(held.affected.length)} deletion(s)/replacement(s)`, enabled: true, children });
  }
  if (conflicts.length > 0) {
    const children: MenuItem[] = conflicts.slice(0, 10).map((c) => ({
      id: id(),
      label: `${c.relPath} (${c.kind.replace(/_/g, ' ')})`,
      enabled: true,
      children: [
        item('Keep local version', { type: 'resolve_conflict', id: c.id, choice: 'keep_local' }, c.kind !== 'delete_vs_edit'),
        item('Keep remote version', { type: 'resolve_conflict', id: c.id, choice: 'keep_remote' }, c.kind !== 'delete_vs_edit'),
        item('Keep both', { type: 'resolve_conflict', id: c.id, choice: 'keep_both' }),
      ],
    }));
    if (conflicts.length > 10) children.push(item(`… ${String(conflicts.length - 10)} more (see details page)`, undefined, false));
    menu.push({ id: id(), label: `Conflicts (${String(conflicts.length)})`, enabled: true, children });
  }
  if (quarantine.length > 0) {
    const children: MenuItem[] = quarantine.slice(0, 10).map((q) => ({
      id: id(),
      label: `${q.relPath ?? q.nodeUid ?? 'item'}: ${q.reason.replace(/_/g, ' ')}`,
      enabled: true,
      children: [item('Release and re-check', { type: 'release_quarantine', id: q.id })],
    }));
    menu.push({ id: id(), label: `Quarantine (${String(quarantine.length)})`, enabled: true, children });
  }
  if (held !== null || conflicts.length > 0 || quarantine.length > 0) menu.push(separator());

  menu.push(item('Open details page', { type: 'open_details' }));
  menu.push(item('Open sync folder', { type: 'open_folder' }));
  menu.push(item('Open recycle folder', { type: 'open_recycle' }));
  menu.push(item('Open audit log', { type: 'open_log' }));
  menu.push(item('Settings…', { type: 'open_settings' }));
  menu.push(separator());
  menu.push(item('Quit', { type: 'quit' }));

  const title = `Proton Drive Sync: ${status.summaryLines[0] ?? status.state}`;
  return {
    iconName: iconFor(status.state),
    sniStatus,
    title,
    tooltip: { title: 'Proton Drive Sync', description: status.summaryLines.join('\n') },
    menu,
  };
}

/** The engine-control surface a menu action drives; ControlTarget satisfies it structurally. */
export interface MenuControlTarget {
  pause(): void;
  resume(): void;
  syncNow(): Promise<unknown>;
  confirmHeldPlan(id: string): Promise<unknown>;
  rejectHeldPlan(id: string): unknown;
  resolveConflict(id: number, choice: 'keep_local' | 'keep_remote' | 'keep_both'): Promise<unknown>;
  releaseQuarantine(id: number): void;
  quit(): Promise<unknown>;
}

/**
 * Apply a menu action that changes engine state. Returns true when it handled
 * the action; `open_*` actions (which need host paths, not the engine) return
 * false so the caller opens them. Extracted from the tray so the same
 * label-to-engine wiring can be unit-tested without a D-Bus host.
 */
export async function dispatchMenuAction(action: MenuAction, target: MenuControlTarget): Promise<boolean> {
  switch (action.type) {
    case 'pause':
      target.pause();
      return true;
    case 'resume':
      target.resume();
      return true;
    case 'sync_now':
      await target.syncNow();
      return true;
    case 'confirm_held':
      await target.confirmHeldPlan(action.id);
      return true;
    case 'reject_held':
      target.rejectHeldPlan(action.id);
      return true;
    case 'resolve_conflict':
      await target.resolveConflict(action.id, action.choice);
      return true;
    case 'release_quarantine':
      target.releaseQuarantine(action.id);
      return true;
    case 'quit':
      await target.quit();
      return true;
    case 'open_folder':
    case 'open_recycle':
    case 'open_log':
    case 'open_details':
    case 'open_settings':
      return false; // need host paths, handled by the caller
  }
}

/** Flatten a menu tree into id -> item for event dispatch. */
export function indexMenu(items: MenuItem[], into = new Map<number, MenuItem>()): Map<number, MenuItem> {
  for (const i of items) {
    into.set(i.id, i);
    if (i.children !== undefined) indexMenu(i.children, into);
  }
  return into;
}

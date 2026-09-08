/**
 * Desktop notifications for events that need the user. Routine sync activity
 * never notifies.
 */
import type { EngineStatus } from '../engine/status.js';

export interface Notification {
  summary: string;
  body: string;
  urgency: 'low' | 'normal' | 'critical';
}

export interface NotifyTracker {
  conflicts: number;
  quarantined: number;
  heldId: string | null;
  state: EngineStatus['state'];
}

export function initialTracker(status: EngineStatus): NotifyTracker {
  return { conflicts: status.attention.conflicts, quarantined: status.attention.quarantined, heldId: status.attention.heldPlan?.id ?? null, state: status.state };
}

/**
 * Compare the previous and current status and return the notifications to
 * show. Pure: the caller keeps the tracker between calls.
 */
export function notificationsFor(prev: NotifyTracker, status: EngineStatus): { notifications: Notification[]; next: NotifyTracker } {
  const notifications: Notification[] = [];
  const next = initialTracker(status);
  if (status.attention.conflicts > prev.conflicts) {
    const n = status.attention.conflicts - prev.conflicts;
    notifications.push({ summary: n === 1 ? 'Sync conflict' : `${String(n)} sync conflicts`, body: 'Both sides changed the same item. Both versions were kept; choose one in the tray or details page.', urgency: 'normal' });
  }
  if (status.attention.quarantined > prev.quarantined) {
    const n = status.attention.quarantined - prev.quarantined;
    notifications.push({ summary: n === 1 ? 'Item quarantined' : `${String(n)} items quarantined`, body: 'Verification failed or the outcome was unknown. The item is untouched until you release it.', urgency: 'normal' });
  }
  const heldId = status.attention.heldPlan?.id ?? null;
  if (heldId !== null && heldId !== prev.heldId) {
    notifications.push({ summary: 'Confirmation required', body: status.attention.heldPlan?.reason ?? 'A large change is waiting for your confirmation.', urgency: 'critical' });
  }
  if (status.state !== prev.state) {
    if (status.state === 'needs_login') notifications.push({ summary: 'Login required', body: 'Proton Drive Sync needs you to sign in again.', urgency: 'critical' });
    if (status.state === 'error') notifications.push({ summary: 'Sync stopped', body: status.reason ?? 'An error paused syncing.', urgency: 'critical' });
  }
  return { notifications, next };
}

/** org.freedesktop.Notifications client; a no-op when the bus is unavailable. */
export interface Notifier {
  notify(n: Notification): Promise<void>;
}

export const silentNotifier: Notifier = { notify: () => Promise.resolve() };

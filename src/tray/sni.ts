/**
 * StatusNotifierItem (org.kde.StatusNotifierItem) and its menu
 * (com.canonical.dbusmenu) over the session D-Bus, via dbus-next.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/class-literal-property-style --
   dbus-next's typings are loose (`any` bodies) and D-Bus properties must be getters; the wire signatures are the contract here. */
import dbus from 'dbus-next';

import type { MenuAction, MenuItem, TrayModel } from './menuModel.js';
import { indexMenu } from './menuModel.js';
import type { Notification, Notifier } from './notify.js';

const { Interface, ACCESS_READ } = dbus.interface;
const Variant = dbus.Variant;

type Layout = [number, Record<string, dbus.Variant>, dbus.Variant[]];

function itemProps(item: MenuItem): Record<string, dbus.Variant> {
  if (item.separator === true) return { type: new Variant('s', 'separator'), visible: new Variant('b', true) };
  const props: Record<string, dbus.Variant> = { label: new Variant('s', item.label), enabled: new Variant('b', item.enabled), visible: new Variant('b', true) };
  if (item.children !== undefined) props['children-display'] = new Variant('s', 'submenu');
  return props;
}

function layoutOf(item: MenuItem, depth: number): Layout {
  const children = depth === 0 ? [] : (item.children ?? []).map((c) => new Variant('(ia{sv}av)', layoutOf(c, depth - 1)));
  return [item.id, itemProps(item), children];
}

class DbusMenu extends Interface {
  model: MenuItem[] = [];
  revision = 1;
  onAction: (action: MenuAction) => void = () => undefined;

  get Version(): number {
    return 3;
  }
  get TextDirection(): string {
    return 'ltr';
  }
  get Status(): string {
    return 'normal';
  }
  get IconThemePath(): string[] {
    return [];
  }

  private root(): MenuItem {
    return { id: 0, label: '', enabled: true, children: this.model };
  }

  GetLayout(parentId: number, recursionDepth: number, _propertyNames: string[]): [number, Layout] {
    const depth = recursionDepth < 0 ? 99 : recursionDepth;
    const start = parentId === 0 ? this.root() : indexMenu(this.model).get(parentId) ?? this.root();
    return [this.revision, layoutOf(start, depth)];
  }

  GetGroupProperties(ids: number[], _propertyNames: string[]): [number, Record<string, dbus.Variant>][] {
    const index = indexMenu(this.model);
    return ids.map((id) => [id, id === 0 ? {} : itemProps(index.get(id) ?? { id, label: '', enabled: false })]);
  }

  GetProperty(id: number, name: string): dbus.Variant {
    const props = id === 0 ? {} : itemProps(indexMenu(this.model).get(id) ?? { id, label: '', enabled: false });
    return props[name] ?? new Variant('s', '');
  }

  Event(id: number, eventId: string, _data: dbus.Variant, _timestamp: number): void {
    if (eventId !== 'clicked') return;
    const item = indexMenu(this.model).get(id);
    if (item?.action !== undefined && item.enabled) this.onAction(item.action);
  }

  EventGroup(events: [number, string, dbus.Variant, number][]): number[] {
    for (const [id, eventId, data, ts] of events) this.Event(id, eventId, data, ts);
    return [];
  }

  AboutToShow(_id: number): boolean {
    return false;
  }

  AboutToShowGroup(_ids: number[]): [number[], number[]] {
    return [[], []];
  }

  LayoutUpdated(): [number, number] {
    return [this.revision, 0];
  }

  ItemsPropertiesUpdated(): [[number, Record<string, dbus.Variant>][], [number, string[]][]] {
    return [[], []];
  }

  setModel(model: MenuItem[]): void {
    this.model = model;
    this.revision += 1;
    (this as any).LayoutUpdated();
  }
}
DbusMenu.configureMembers({
  properties: {
    Version: { signature: 'u', access: ACCESS_READ },
    TextDirection: { signature: 's', access: ACCESS_READ },
    Status: { signature: 's', access: ACCESS_READ },
    IconThemePath: { signature: 'as', access: ACCESS_READ },
  },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    GetProperty: { inSignature: 'is', outSignature: 'v' },
    Event: { inSignature: 'isvu', outSignature: '' },
    EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
    AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
  },
  signals: {
    LayoutUpdated: { signature: 'ui' },
    ItemsPropertiesUpdated: { signature: 'a(ia{sv})a(ias)' },
  },
});

class StatusNotifierItem extends Interface {
  model: TrayModel;
  onActivate: () => void = () => undefined;

  constructor(name: string, model: TrayModel) {
    super(name);
    this.model = model;
  }

  get Category(): string {
    return 'ApplicationStatus';
  }
  get Id(): string {
    return 'proton-drive-sync';
  }
  get Title(): string {
    return this.model.title;
  }
  get Status(): string {
    return this.model.sniStatus;
  }
  get WindowId(): number {
    return 0;
  }
  get IconName(): string {
    return this.model.iconName;
  }
  get IconPixmap(): [number, number, Buffer][] {
    return [];
  }
  get OverlayIconName(): string {
    return '';
  }
  get AttentionIconName(): string {
    return 'dialog-warning';
  }
  get AttentionMovieName(): string {
    return '';
  }
  get ToolTip(): [string, [number, number, Buffer][], string, string] {
    return [this.model.iconName, [], this.model.tooltip.title, this.model.tooltip.description];
  }
  get ItemIsMenu(): boolean {
    return true;
  }
  get Menu(): string {
    return '/MenuBar';
  }

  ContextMenu(_x: number, _y: number): void {
    // The host shows /MenuBar itself.
  }
  Activate(_x: number, _y: number): void {
    this.onActivate();
  }
  SecondaryActivate(_x: number, _y: number): void {
    this.onActivate();
  }
  Scroll(_delta: number, _orientation: string): void {
    // no-op
  }

  NewTitle(): void {
    // signal
  }
  NewIcon(): void {
    // signal
  }
  NewAttentionIcon(): void {
    // signal
  }
  NewOverlayIcon(): void {
    // signal
  }
  NewToolTip(): void {
    // signal
  }
  NewStatus(): string {
    return this.model.sniStatus;
  }

  setModel(model: TrayModel): void {
    const prev = this.model;
    this.model = model;
    if (prev.iconName !== model.iconName) (this as any).NewIcon();
    if (prev.title !== model.title) (this as any).NewTitle();
    if (prev.sniStatus !== model.sniStatus) (this as any).NewStatus();
    (this as any).NewToolTip();
  }
}
StatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: 's', access: ACCESS_READ },
    Id: { signature: 's', access: ACCESS_READ },
    Title: { signature: 's', access: ACCESS_READ },
    Status: { signature: 's', access: ACCESS_READ },
    WindowId: { signature: 'i', access: ACCESS_READ },
    IconName: { signature: 's', access: ACCESS_READ },
    IconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    OverlayIconName: { signature: 's', access: ACCESS_READ },
    AttentionIconName: { signature: 's', access: ACCESS_READ },
    AttentionMovieName: { signature: 's', access: ACCESS_READ },
    ToolTip: { signature: '(sa(iiay)ss)', access: ACCESS_READ },
    ItemIsMenu: { signature: 'b', access: ACCESS_READ },
    Menu: { signature: 'o', access: ACCESS_READ },
  },
  methods: {
    ContextMenu: { inSignature: 'ii', outSignature: '' },
    Activate: { inSignature: 'ii', outSignature: '' },
    SecondaryActivate: { inSignature: 'ii', outSignature: '' },
    Scroll: { inSignature: 'is', outSignature: '' },
  },
  signals: {
    NewTitle: { signature: '' },
    NewIcon: { signature: '' },
    NewAttentionIcon: { signature: '' },
    NewOverlayIcon: { signature: '' },
    NewToolTip: { signature: '' },
    NewStatus: { signature: 's' },
  },
});

export interface SniHandle {
  update(model: TrayModel): void;
  notifier: Notifier;
  dispose(): Promise<void>;
}

/**
 * Connect to the session bus, export the item and menu, and register with the
 * StatusNotifierWatcher. Rejects when no bus or no watcher is available.
 */
export async function startStatusNotifierItem(initial: TrayModel, onAction: (action: MenuAction) => void, options: { busAddress?: string; timeoutMs?: number } = {}): Promise<SniHandle> {
  const bus = dbus.sessionBus(options.busAddress !== undefined ? { busAddress: options.busAddress } : undefined);
  const busName = `org.kde.StatusNotifierItem-${String(process.pid)}-1`;
  const timeout = options.timeoutMs ?? 5000;
  // The bus emits 'error' (e.g. ENOENT on the socket) instead of rejecting; turn it into a rejection.
  let busFailed: (error: Error) => void = () => undefined;
  const busFailure = new Promise<never>((_, reject) => {
    busFailed = reject;
  });
  busFailure.catch(() => undefined);
  bus.on('error', (error: unknown) => {
    busFailed(error instanceof Error ? error : new Error(String(error)));
  });
  const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([
      p,
      busFailure,
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`${what} timed out`));
        }, timeout).unref();
      }),
    ]);
  try {
    const sni = new StatusNotifierItem('org.kde.StatusNotifierItem', initial);
    const menu = new DbusMenu('com.canonical.dbusmenu');
    menu.model = initial.menu;
    menu.onAction = onAction;
    sni.onActivate = () => { onAction({ type: 'open_details' }); };
    await withTimeout(bus.requestName(busName, 0), 'requesting the bus name');
    bus.export('/StatusNotifierItem', sni);
    bus.export('/MenuBar', menu);
    const watcher = await withTimeout(bus.getProxyObject('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher'), 'finding the StatusNotifierWatcher');
    const watcherIface: any = watcher.getInterface('org.kde.StatusNotifierWatcher');
    await withTimeout(watcherIface.RegisterStatusNotifierItem(busName) as Promise<unknown>, 'registering the tray item');

    let notifications: any = null;
    try {
      const obj = await withTimeout(bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications'), 'finding the notification service');
      notifications = obj.getInterface('org.freedesktop.Notifications');
    } catch {
      notifications = null;
    }
    const notifier: Notifier = {
      notify: async (n: Notification) => {
        if (notifications === null) return;
        const urgency = n.urgency === 'critical' ? 2 : n.urgency === 'low' ? 0 : 1;
        await (notifications.Notify('Proton Drive Sync', 0, initial.iconName, n.summary, n.body, [], { urgency: new Variant('y', urgency) }, n.urgency === 'critical' ? 0 : 10_000) as Promise<unknown>);
      },
    };
    return {
      update: (model) => {
        sni.setModel(model);
        menu.setModel(model.menu);
      },
      notifier,
      dispose: async () => {
        try {
          bus.unexport('/MenuBar', menu);
          bus.unexport('/StatusNotifierItem', sni);
          await bus.releaseName(busName);
        } catch {
          // best effort
        }
        bus.disconnect();
        await Promise.resolve();
      },
    };
  } catch (error) {
    try {
      bus.disconnect();
    } catch {
      // ignore
    }
    throw error;
  }
}

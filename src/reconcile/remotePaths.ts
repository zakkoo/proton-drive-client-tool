/**
 * Remote tree resolution: uid -> root-relative path, plus the items that must
 * be excluded from sync (undecryptable names, invalid names, Proton documents,
 * unsupported types, orphans) and sibling name collisions under case folding
 * and Unicode normalisation.
 */
import type { Blocked, RemoteItem, RemoteView } from './types.js';

export interface ResolvedRemote {
  /** uid -> relPath for every syncable, non-trashed node under the root (root excluded). */
  paths: Map<string, string>;
  /** Nodes that are trashed themselves or live under a trashed ancestor. */
  effectivelyTrashed: Set<string>;
  /** relPath -> item */
  byPath: Map<string, RemoteItem>;
  blocked: Blocked[];
  /** Paths (remote side) whose whole subtree is excluded. */
  excludedPaths: Set<string>;
}

/** Canonical form used to detect names that would collide on a case-insensitive or normalising file system. */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function resolveRemote(view: RemoteView): ResolvedRemote {
  const paths = new Map<string, string>();
  const byPath = new Map<string, RemoteItem>();
  const blocked: Blocked[] = [];
  const excludedPaths = new Set<string>();
  const children = new Map<string, RemoteItem[]>();
  const allChildren = new Map<string, RemoteItem[]>();
  for (const item of view.items.values()) {
    if (item.parentUid === undefined) continue;
    const all = allChildren.get(item.parentUid) ?? [];
    all.push(item);
    allChildren.set(item.parentUid, all);
    if (item.isTrashed) continue;
    const list = children.get(item.parentUid) ?? [];
    list.push(item);
    children.set(item.parentUid, list);
  }
  // Trashing a folder trashes its subtree; only the folder itself carries the flag.
  const effectivelyTrashed = new Set<string>();
  const markTrashed = (uid: string): void => {
    if (effectivelyTrashed.has(uid)) return;
    effectivelyTrashed.add(uid);
    for (const child of allChildren.get(uid) ?? []) markTrashed(child.uid);
  };
  for (const item of view.items.values()) if (item.isTrashed) markTrashed(item.uid);

  const visit = (parentUid: string, parentPath: string): void => {
    const kids = children.get(parentUid) ?? [];
    // Detect sibling collisions first so both members are blocked.
    const groups = new Map<string, RemoteItem[]>();
    for (const k of kids) {
      if (k.nameStatus !== 'ok') continue;
      const key = collisionKey(k.name);
      const g = groups.get(key) ?? [];
      g.push(k);
      groups.set(key, g);
    }
    const colliding = new Set<string>();
    for (const g of groups.values()) {
      if (g.length > 1) for (const k of g) colliding.add(k.uid);
    }
    for (const k of kids) {
      const relPath = parentPath === '' ? k.name : `${parentPath}/${k.name}`;
      if (k.nameStatus === 'undecryptable') {
        blocked.push({ reason: 'undecryptable', relPath: undefined, remoteUid: k.uid, detail: `node ${k.uid} under ${parentPath || '/'} has an undecryptable name` });
        continue;
      }
      if (k.nameStatus === 'invalid') {
        blocked.push({ reason: 'invalid_name', relPath, remoteUid: k.uid, detail: `remote name is invalid: ${k.name}` });
        excludedPaths.add(relPath);
        continue;
      }
      if (colliding.has(k.uid)) {
        blocked.push({ reason: 'case_collision', relPath, remoteUid: k.uid, detail: `remote siblings differ only by case or Unicode form: ${k.name}` });
        excludedPaths.add(relPath);
        continue;
      }
      if (k.kind === 'other') {
        blocked.push({ reason: 'unsupported_type', relPath, remoteUid: k.uid, detail: 'remote node is neither a file nor a folder' });
        excludedPaths.add(relPath);
        continue;
      }
      if (k.isProtonDocument) {
        blocked.push({ reason: 'proton_document', relPath, remoteUid: k.uid, detail: 'Proton document without downloadable content' });
        excludedPaths.add(relPath);
        continue;
      }
      paths.set(k.uid, relPath);
      byPath.set(relPath, k);
      if (k.kind === 'dir') visit(k.uid, relPath);
    }
  };
  visit(view.rootUid, '');

  // Anything present but unreachable from the root (dangling parent) is an orphan.
  for (const item of view.items.values()) {
    if (item.uid === view.rootUid || effectivelyTrashed.has(item.uid) || paths.has(item.uid)) continue;
    if (blocked.some((b) => b.remoteUid === item.uid)) continue;
    if (item.parentUid !== undefined && (view.items.has(item.parentUid) || item.parentUid === view.rootUid)) continue; // excluded via ancestor
    blocked.push({ reason: 'orphan', relPath: undefined, remoteUid: item.uid, detail: `node ${item.uid} has no reachable parent` });
  }
  return { paths, byPath, blocked, excludedPaths, effectivelyTrashed };
}

/** Local sibling collisions under case folding and normalisation; both members are blocked. */
export function localCollisions(paths: Iterable<string>): Blocked[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const idx = p.lastIndexOf('/');
    const parent = idx === -1 ? '' : p.slice(0, idx);
    const name = idx === -1 ? p : p.slice(idx + 1);
    const key = `${parent}/${collisionKey(name)}`;
    const g = groups.get(key) ?? [];
    g.push(p);
    groups.set(key, g);
  }
  const out: Blocked[] = [];
  for (const g of groups.values()) {
    if (g.length > 1) for (const p of g) out.push({ reason: 'case_collision', relPath: p, remoteUid: undefined, detail: `local siblings differ only by case or Unicode form: ${p}` });
  }
  return out;
}

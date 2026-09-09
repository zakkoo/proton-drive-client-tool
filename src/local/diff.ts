/**
 * Snapshot diff with move detection.
 *
 * A move is recognised only with evidence: same (device, inode), same kind,
 * and for files the same size plus a matching content digest when the
 * previous digest is known. Without a previous digest the pairing is
 * reported as a separate delete and create flagged ambiguous, so the
 * reconciler applies its delete safety rules instead of trusting a guess.
 */
import type { DigestProvider } from './digest.js';
import type { LocalEntry, LocalSnapshot } from './snapshot.js';

export type LocalChange =
  | { type: 'created'; entry: LocalEntry; ambiguous?: boolean }
  | { type: 'modified'; entry: LocalEntry; previous: LocalEntry }
  | { type: 'deleted'; previous: LocalEntry; ambiguous?: boolean }
  | {
      type: 'moved';
      from: string;
      to: string;
      entry: LocalEntry;
      previous: LocalEntry;
      /** For files: content also changed (size/mtime differ or digest differs). */
      contentChanged: boolean;
    };

export interface DiffOptions {
  /** Digest of a file as known before the change (from the baseline), if any. */
  previousDigest: (relPath: string) => string | undefined;
  digests: DigestProvider;
}

function identity(e: LocalEntry): string {
  // Creation time is part of the identity: a rename keeps the inode's birthtime, but a new file that
  // merely reused a freed inode has a newer one — so inode reuse is not mistaken for a move.
  return `${e.kind}:${String(e.dev)}:${String(e.ino)}:${String(e.birthtimeMs)}`;
}

function under(parent: string, p: string): boolean {
  return p.startsWith(`${parent}/`);
}

export async function diffSnapshots(prev: LocalSnapshot, next: LocalSnapshot, options: DiffOptions): Promise<LocalChange[]> {
  const changes: LocalChange[] = [];
  const deleted = new Map<string, LocalEntry>();
  const created = new Map<string, LocalEntry>();

  for (const [rel, p] of prev.entries) {
    const n = next.entries.get(rel);
    if (n === undefined) {
      deleted.set(rel, p);
    } else if (n.kind !== p.kind) {
      deleted.set(rel, p);
      created.set(rel, n);
    } else if (n.kind === 'file' && (n.size !== p.size || n.mtimeMs !== p.mtimeMs || n.ino !== p.ino)) {
      changes.push({ type: 'modified', entry: n, previous: p });
    }
  }
  for (const [rel, n] of next.entries) {
    if (!prev.entries.has(rel)) created.set(rel, n);
  }

  // Index deletions by identity for pairing.
  const deletedByIdentity = new Map<string, LocalEntry[]>();
  for (const p of deleted.values()) {
    const list = deletedByIdentity.get(identity(p)) ?? [];
    list.push(p);
    deletedByIdentity.set(identity(p), list);
  }

  const consumedDeleted = new Set<string>();
  const consumedCreated = new Set<string>();

  // Directories first so their descendants can be collapsed.
  const createdSorted = [...created.values()].sort((a, b) => (a.kind === b.kind ? a.relPath.localeCompare(b.relPath) : a.kind === 'dir' ? -1 : 1));
  for (const n of createdSorted) {
    if (consumedCreated.has(n.relPath)) continue;
    const candidates = (deletedByIdentity.get(identity(n)) ?? []).filter((p) => !consumedDeleted.has(p.relPath));
    if (candidates.length !== 1) continue; // none, or inode ambiguity between several deleted items
    const p = candidates[0];
    if (p === undefined) continue;

    if (n.kind === 'file') {
      const prevSha1 = options.previousDigest(p.relPath);
      if (prevSha1 === undefined || n.size !== p.size) {
        // Same inode but no proof of identical content: not a move.
        continue;
      }
      let nextSha1: string;
      try {
        nextSha1 = await options.digests.digestOf(n);
      } catch {
        continue;
      }
      if (nextSha1 !== prevSha1) continue;
      consumedDeleted.add(p.relPath);
      consumedCreated.add(n.relPath);
      changes.push({ type: 'moved', from: p.relPath, to: n.relPath, entry: n, previous: p, contentChanged: false });
      continue;
    }

    // Directory move: pair it and collapse descendants that moved along unchanged.
    consumedDeleted.add(p.relPath);
    consumedCreated.add(n.relPath);
    changes.push({ type: 'moved', from: p.relPath, to: n.relPath, entry: n, previous: p, contentChanged: false });
    for (const [rel, child] of deleted) {
      if (!under(p.relPath, rel) || consumedDeleted.has(rel)) continue;
      const newRel = `${n.relPath}/${rel.slice(p.relPath.length + 1)}`;
      const moved = created.get(newRel);
      if (moved === undefined || consumedCreated.has(newRel) || moved.kind !== child.kind) continue;
      if (moved.ino !== child.ino || moved.dev !== child.dev) continue;
      consumedDeleted.add(rel);
      consumedCreated.add(newRel);
      if (child.kind === 'file' && (moved.size !== child.size || moved.mtimeMs !== child.mtimeMs)) {
        changes.push({ type: 'moved', from: rel, to: newRel, entry: moved, previous: child, contentChanged: true });
      }
      // Unchanged descendants are implied by the folder move and produce no change.
    }
  }

  for (const p of deleted.values()) {
    if (consumedDeleted.has(p.relPath)) continue;
    const ambiguous = [...created.values()].some((n) => !consumedCreated.has(n.relPath) && identity(n) === identity(p));
    changes.push(ambiguous ? { type: 'deleted', previous: p, ambiguous: true } : { type: 'deleted', previous: p });
  }
  for (const n of created.values()) {
    if (consumedCreated.has(n.relPath)) continue;
    const ambiguous = [...deleted.values()].some((p) => !consumedDeleted.has(p.relPath) && identity(n) === identity(p));
    changes.push(ambiguous ? { type: 'created', entry: n, ambiguous: true } : { type: 'created', entry: n });
  }

  return changes.sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
}

function pathOf(c: LocalChange): string {
  switch (c.type) {
    case 'created':
    case 'modified':
      return c.entry.relPath;
    case 'deleted':
      return c.previous.relPath;
    case 'moved':
      return c.to;
  }
}

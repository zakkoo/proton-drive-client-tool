import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { World } from '../testing/world.js';
import { reconcile } from './reconcile.js';

/**
 * Property-based convergence test.
 *
 * Start from a synced world, apply a random edit script to both sides
 * (writes, deletes, moves, folder creation), then reconcile-and-apply until
 * the plan is empty. Assert:
 *  - convergence: both sides hold the same files, within a bounded number of rounds
 *  - determinism: the same inputs yield the same plan
 *  - no data loss: every content that existed on a side and was not deleted by
 *    that side's own edits is still present somewhere (either side or recycle/trash)
 */

type Edit =
  | { side: 'local' | 'remote'; op: 'write'; path: string; content: string }
  | { side: 'local' | 'remote'; op: 'delete'; path: string }
  | { side: 'local' | 'remote'; op: 'move'; from: string; to: string }
  | { side: 'local' | 'remote'; op: 'mkdir'; path: string };

const names = ['a', 'b', 'c', 'd'];
const dirs = ['', 'x', 'y', 'x/z'];
const pathArb = fc.tuple(fc.constantFrom(...dirs), fc.constantFrom(...names)).map(([d, n]) => (d === '' ? `${n}.txt` : `${d}/${n}.txt`));
const dirArb = fc.constantFrom('x', 'y', 'x/z', 'w');
const sideArb = fc.constantFrom<'local' | 'remote'>('local', 'remote');
const contentArb = fc.constantFrom('v1', 'v2', 'v3', 'v4');

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ side: sideArb, op: fc.constant<'write'>('write'), path: pathArb, content: contentArb }),
  fc.record({ side: sideArb, op: fc.constant<'delete'>('delete'), path: fc.oneof(pathArb, dirArb) }),
  fc.record({ side: sideArb, op: fc.constant<'move'>('move'), from: fc.oneof(pathArb, dirArb), to: fc.oneof(pathArb, dirArb) }),
  fc.record({ side: sideArb, op: fc.constant<'mkdir'>('mkdir'), path: dirArb }),
);

function seededWorld(files: { path: string; content: string }[]): World {
  const w = new World();
  for (const f of files) {
    w.localWrite(f.path, f.content);
    w.remoteWrite(f.path, f.content);
  }
  w.markAllSynced();
  return w;
}

function isDir(w: World, side: 'local' | 'remote', p: string): boolean {
  if (side === 'local') return w.local.get(p)?.kind === 'dir';
  return w.remoteByPath(p)?.kind === 'dir';
}

function applyEdit(w: World, e: Edit): void {
  const exists = (p: string) => (e.side === 'local' ? w.local.has(p) : w.remoteByPath(p) !== undefined);
  switch (e.op) {
    case 'write':
      if (isDir(w, e.side, e.path)) return;
      if (e.side === 'local') w.localWrite(e.path, e.content);
      else w.remoteWrite(e.path, e.content);
      return;
    case 'delete':
      if (e.side === 'local') w.localDelete(e.path);
      else {
        // Trash the node and its descendants (the model trashes only the node; descendants follow via path).
        w.remoteTrash(e.path);
      }
      return;
    case 'move':
      if (!exists(e.from) || exists(e.to) || e.to.startsWith(`${e.from}/`) || e.from === e.to) return;
      // Do not move a directory to a path whose parent would be inside it, or a file onto a dir path.
      if (e.side === 'local') w.localMove(e.from, e.to);
      else w.remoteMove(e.from, e.to);
      return;
    case 'mkdir':
      if (exists(e.path)) return;
      if (e.side === 'local') w.localMkdir(e.path);
      else w.remoteMkdir(e.path);
      return;
  }
}


describe('reconciler convergence (property-based)', () => {
  it('converges with no data loss and deterministic plans', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ path: pathArb, content: contentArb }), { minLength: 0, maxLength: 6 }),
        fc.array(editArb, { minLength: 0, maxLength: 8 }),
        (seed, edits) => {
          // Distinct seed paths only.
          const uniq = [...new Map(seed.map((s) => [s.path, s])).values()];
          const w = seededWorld(uniq);
          for (const e of edits) applyEdit(w, e);

          // Everything that exists after the edits must survive somewhere.
          const mustSurvive = new Set([...w.localFiles().values(), ...w.remoteFiles().values()]);

          let rounds = 0;
          let blockedPaths: string[] = [];
          for (;;) {
            const input = w.input();
            const plan = reconcile(input);
            blockedPaths = plan.blocked.flatMap((b) => (b.relPath !== undefined ? [b.relPath] : []));
            const again = reconcile(w.input());
            expect(again).toEqual(plan); // determinism
            // A held plan carries no runnable deletes; the model user confirms it.
            const held = plan.requiresConfirmation !== null ? plan.withheld.length : 0;
            if (plan.operations.length === 0 && plan.conflicts.length === 0 && held === 0) break;
            // Blocked items are not part of convergence; the model has no collisions by construction.
            w.apply(plan, { confirmWithheld: true });
            rounds++;
            if (rounds > 8) throw new Error(`did not converge after ${String(rounds)} rounds: ${JSON.stringify(plan.operations.map((o) => o.kind))}`);
          }

          // Items the reconciler refuses to touch (e.g. a file on one side and a folder on the
          // other at the same path) are excluded from the equality check; they stay put on both sides.
          const notBlocked = (p: string) => !blockedPaths.some((b) => p === b || p.startsWith(`${b}/`));
          const local = [...w.localFiles().entries()].filter(([p]) => notBlocked(p)).sort();
          const remote = [...w.remoteFiles().entries()].filter(([p]) => notBlocked(p)).sort();
          expect(local).toEqual(remote);
          const survivors = w.recoverableContents();
          for (const c of mustSurvive) expect(survivors.has(c), `content ${c} was lost`).toBe(true);
        },
      ),
      { numRuns: 1200, seed: 20260907 },
    );
  }, 120_000);
});

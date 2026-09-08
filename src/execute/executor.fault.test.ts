import { renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SimulatedCrashError, type ExecutorStep } from './types.js';
import { SyncHarness } from '../testing/harness.js';

/**
 * Fault-injection harness.
 *
 * A scripted scenario is executed once to enumerate every executor step. Then,
 * for each step index k, a fresh world replays the scenario and the process
 * "crashes" (throws) exactly at step k. Recovery runs, the sync continues to
 * convergence, and the invariants are checked:
 *  - no user content is lost (present on a side, recycled, or trashed)
 *  - the journal has no unresolved entries after recovery
 *  - the baseline never describes anything that is not really there
 */

interface Scenario {
  name: string;
  seed: (h: SyncHarness) => void;
  edit: (h: SyncHarness) => void;
}

const scenarios: Scenario[] = [
  {
    name: 'mixed edits on both sides',
    seed: (h) => {
      h.write('a.txt', 'A');
      h.write('b.txt', 'B');
      h.write('e.txt', 'E');
      h.write('f.txt', 'F');
      h.write('g.txt', 'G');
      h.write('dir/inner.txt', 'I');
    },
    edit: (h) => {
      h.write('a.txt', 'A2'); // local modify -> upload revision
      const b = h.remotePathToUid('b.txt');
      if (b !== undefined) h.fake.seedRevision(b, 'B2'); // remote modify -> download (recycle old)
      h.write('c.txt', 'C'); // local new -> upload
      h.fake.seedFile(h.remoteRootUid, 'd.txt', 'D'); // remote new -> download
      rmSync(path.join(h.root, 'e.txt')); // local delete -> trash remote
      const f = h.remotePathToUid('f.txt');
      if (f !== undefined) void h.fake.trash([f]); // remote delete -> recycle local
      renameSync(path.join(h.root, 'g.txt'), path.join(h.root, 'h.txt')); // local rename -> move remote
      h.write('newdir/deep/n.txt', 'N'); // nested new folders
    },
  },
  {
    name: 'folder rename remotely with a local edit inside',
    seed: (h) => {
      h.write('src/x.txt', 'X');
      h.write('src/y.txt', 'Y');
    },
    edit: (h) => {
      const dir = h.remotePathToUid('src');
      if (dir !== undefined) void h.fake.rename(dir, 'lib');
      h.write('src/x.txt', 'X2');
    },
  },
];

async function prepare(s: Scenario, hooks?: { beforeStep: (step: ExecutorStep, op: unknown) => void }): Promise<SyncHarness> {
  const h = SyncHarness.create();
  s.seed(h);
  await h.settle();
  h.assertBaselineConsistent();
  s.edit(h);
  if (hooks !== undefined) h.reopen({ hooks });
  return h;
}

function mustSurvive(h: SyncHarness): Set<string> {
  return new Set([...h.localFiles().values(), ...h.remoteFiles().values()]);
}

function survivors(h: SyncHarness): Set<string> {
  return new Set([...h.localFiles().values(), ...h.remoteFiles().values(), ...h.recycledContents(), ...h.remoteTrashedContents(), ...h.fake.supersededContents()]);
}

describe('executor under fault injection', () => {
  for (const scenario of scenarios) {
    it(`${scenario.name}: survives a crash at every executor step`, async () => {
      // 1. Enumerate the steps of an uninterrupted run.
      const steps: string[] = [];
      const probe = await prepare(scenario, { beforeStep: (step, op) => steps.push(`${step}:${(op as { kind: string }).kind}`) });
      const before = mustSurvive(probe);
      const plan = await probe.settle(8);
      expect(plan.operations).toEqual([]);
      for (const c of before) expect(survivors(probe).has(c), `content ${c} lost in the clean run`).toBe(true);
      probe.assertBaselineConsistent();
      probe.dispose();
      expect(steps.length).toBeGreaterThan(10);

      // 2. Crash at each step.
      for (let k = 0; k < steps.length; k++) {
        let count = 0;
        const h = await prepare(scenario, {
          beforeStep: (step) => {
            if (count++ === k) throw new SimulatedCrashError(`${step} (#${String(k)})`);
          },
        });
        const expected = mustSurvive(h);
        let crashed = false;
        try {
          await h.execute(await h.plan());
        } catch (error) {
          crashed = error instanceof SimulatedCrashError;
          if (!crashed) throw error;
        }
        // The process "restarts": reopen the store without hooks, recover, continue.
        h.reopen();
        await h.recover();
        expect(h.journal.unresolved(), `step ${String(k)} (${steps[k] ?? ''}): journal not resolved`).toEqual([]);
        const final = await h.settle(8);
        const blocked = final.blocked.filter((b) => b.reason !== 'quarantined');
        expect(blocked, `step ${String(k)} (${steps[k] ?? ''}): unexpected blocks`).toEqual([]);
        const quarantinedPaths = new Set(h.quarantine.open().flatMap((q) => (q.relPath !== null ? [q.relPath] : [])));
        h.assertBaselineConsistent(quarantinedPaths);
        const alive = survivors(h);
        for (const c of expected) expect(alive.has(c), `step ${String(k)} (${steps[k] ?? ''}): content ${c} was lost`).toBe(true);
        // Quarantined items (unknown outcome) are the only allowed divergence; everything else converged.
        const local = [...h.localFiles().entries()].filter(([p]) => !quarantinedPaths.has(p)).sort();
        const remote = [...h.remoteFiles().entries()].filter(([p]) => !quarantinedPaths.has(p)).sort();
        expect(local, `step ${String(k)} (${steps[k] ?? ''}): sides differ`).toEqual(remote);
        h.dispose();
      }
    }, 300_000);
  }
});

import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineHarness } from '../testing/engineHarness.js';

/**
 * A held (braked) plan is confirmed by id. If the plan grows between the moment
 * the user sees it and the moment they confirm, the engine must not silently
 * apply the extra deletes the user never saw (spec: test-suite / the held-plan
 * id is reused after the plan grows).
 */

// A brake that trips as soon as two destructive operations are planned.
const LOW_BRAKE = { brakeMaxChanges: 1, brakeMaxChangePercent: 99, brakePercentMinBaseline: 1_000_000, recycleRetentionDays: 30, logRetentionDays: 90 };

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create({ safety: LOW_BRAKE });
});
afterEach(async () => {
  h.assertNoUserContentLost();
  await h.dispose();
});

describe('held plan id reuse', () => {
  it('confirming the original id after the plan grew does not apply deletes the user never confirmed', async () => {
    for (const n of ['a', 'b', 'c', 'd']) h.write(`${n}.txt`, n.toUpperCase());
    await h.start();
    await h.waitForConvergence();

    // Delete two files -> the plan is held (2 destructive ops > brakeMaxChanges).
    rmSync(path.join(h.root, 'a.txt'));
    rmSync(path.join(h.root, 'b.txt'));
    await h.bundle?.engine.syncNow();
    const firstHold = await h.waitFor(['awaiting_confirmation']);
    const heldId = firstHold.attention.heldPlan?.id ?? '';
    const confirmedCount = firstHold.attention.heldPlan?.affected.length ?? 0;
    expect(confirmedCount, 'the user first sees two deletions').toBe(2);
    expect(h.fake.trashedUids(), 'nothing is trashed while held').toEqual([]);

    // While it is held, two more files are deleted; the plan grows behind the same id.
    rmSync(path.join(h.root, 'c.txt'));
    rmSync(path.join(h.root, 'd.txt'));
    await h.bundle?.engine.syncNow();
    // Wait until the held plan has genuinely grown to four affected paths (a cached snapshot
    // would otherwise leave it at two and make this a false pass).
    let grownAffected = 0;
    for (let i = 0; i < 100; i++) {
      await h.bundle?.engine.syncNow().catch(() => undefined);
      grownAffected = h.bundle?.engine.getStatus().attention.heldPlan?.affected.length ?? 0;
      if (grownAffected >= 4) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(grownAffected, 'the held plan grew to four deletions').toBe(4);
    const grownId = h.bundle?.engine.getStatus().attention.heldPlan?.id ?? '';
    // A grown plan is a new decision: it gets a new id, not the one shown for two deletions.
    expect(grownId, 'the grown plan is a new held id').not.toBe(heldId);

    // Confirming the stale id the user was given for two deletions must be refused, applying nothing.
    await expect(h.bundle?.engine.confirmHeldPlan(heldId)).rejects.toThrow(/held plan/i);
    expect(h.fake.trashedUids(), 'the stale id trashes nothing').toEqual([]);

    // Confirming the current id (the four the user can now see) is the legitimate path.
    await h.bundle?.engine.confirmHeldPlan(grownId);
    await h.waitFor(['idle', 'attention']);
    expect(h.fake.trashedUids().length, 'only what the current plan confirms').toBe(4);
  });
});

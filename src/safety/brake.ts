/**
 * Mass-change brake: a plan whose deletes or replacements exceed the configured
 * count or percentage of the baseline is held until the user confirms.
 */
import type { AuditLog } from '../audit/logger.js';
import type { SafetyConfig } from '../config/schema.js';
import type { Operation, Plan } from '../reconcile/types.js';

export interface BrakeVerdict {
  held: boolean;
  reason: string | null;
  /** Operations that count as destructive (deletes and replacements). */
  affected: Operation[];
  count: number;
  percent: number;
}

export function destructiveOperations(plan: Plan): Operation[] {
  return plan.operations.filter(
    (o) => o.kind === 'recycle_local' || o.kind === 'trash_remote' || (o.kind === 'download' && o.expectedLocal !== undefined) || (o.kind === 'upload' && o.mode === 'revision'),
  );
}

/** Pure evaluation of the brake for a plan. */
export function evaluateBrake(plan: Plan, baselineCount: number, safety: SafetyConfig): BrakeVerdict {
  const affected = destructiveOperations(plan);
  const count = affected.length;
  const percent = baselineCount === 0 ? 0 : (count / baselineCount) * 100;
  const reasons: string[] = [];
  if (plan.requiresConfirmation !== null) reasons.push(plan.requiresConfirmation);
  if (count > safety.brakeMaxChanges) reasons.push(`${String(count)} deletions or replacements exceed the limit of ${String(safety.brakeMaxChanges)}`);
  if (baselineCount >= safety.brakePercentMinBaseline && percent > safety.brakeMaxChangePercent) {
    reasons.push(`${percent.toFixed(1)}% of the ${String(baselineCount)} synced items would be deleted or replaced (limit ${String(safety.brakeMaxChangePercent)}%)`);
  }
  return { held: reasons.length > 0, reason: reasons.length > 0 ? reasons.join('; ') : null, affected, count, percent };
}

export interface HeldPlan {
  id: string;
  plan: Plan;
  verdict: BrakeVerdict;
  heldAt: number;
  /** Signature of the destructive work this id stands for; a change mints a new id. */
  signature: string;
}

/**
 * A stable fingerprint of exactly what confirming this plan would destroy: the
 * destructive operations plus any withheld deletes (which confirm also runs).
 * Independent of per-cycle operation ids, so a re-plan of the same deletes keeps
 * the same signature — but a grown or different set does not.
 */
export function brakeSignature(plan: Plan): string {
  const items = [...destructiveOperations(plan), ...plan.withheld.map((w) => w.operation)].map(describe).sort();
  return JSON.stringify(items);
}

export type GateResult = { status: 'run'; plan: Plan } | { status: 'held'; held: HeldPlan };

/**
 * Stateful gate in front of execution. At most one plan is held at a time; a
 * new plan replaces a stale held one (the world has moved on).
 */
export class PlanGate {
  private held: HeldPlan | null = null;
  private seq = 0;

  constructor(
    private readonly safety: SafetyConfig,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): HeldPlan | null {
    return this.held;
  }

  evaluate(plan: Plan, baselineCount: number): GateResult {
    const verdict = evaluateBrake(plan, baselineCount, this.safety);
    if (!verdict.held) {
      this.held = null;
      return { status: 'run', plan };
    }
    // Bind the id to the destructive work it stands for. While that is unchanged the id (and
    // heldAt) stay stable, so re-confirming the same plan works; but if the plan grows or changes,
    // a new id is minted so a decision made against the old id can never silently apply extra deletes.
    const signature = brakeSignature(plan);
    const previous = this.held !== null && this.held.signature === signature ? this.held : null;
    const id = previous?.id ?? `held-${String(++this.seq)}`;
    const held: HeldPlan = { id, plan, verdict, heldAt: previous?.heldAt ?? this.now(), signature };
    this.held = held;
    this.audit.append({
      kind: 'safety',
      op: 'brake',
      message: `plan held: ${verdict.reason ?? 'confirmation required'}`,
      outcome: 'skipped',
      details: { heldId: held.id, count: verdict.count, percent: Number(verdict.percent.toFixed(2)), affected: verdict.affected.map(describe), withheld: plan.withheld.map((w) => describe(w.operation)) },
    });
    return { status: 'held', held };
  }

  /** User confirmed: the held plan (including withheld deletes) may run. */
  confirm(id: string): Plan {
    const held = this.take(id);
    const plan: Plan = { ...held.plan, operations: [...held.plan.operations, ...held.plan.withheld.map((w) => w.operation)], withheld: [], requiresConfirmation: null };
    this.audit.append({ kind: 'user', op: 'confirm_plan', message: `user confirmed held plan ${id}`, outcome: 'ok', details: { heldId: id, operations: plan.operations.length } });
    return plan;
  }

  /** User rejected: nothing runs; affected items are returned for manual review. */
  reject(id: string): Operation[] {
    const held = this.take(id);
    const affected = [...held.verdict.affected, ...held.plan.withheld.map((w) => w.operation)];
    this.audit.append({ kind: 'user', op: 'reject_plan', message: `user rejected held plan ${id}`, outcome: 'skipped', details: { heldId: id, affected: affected.map(describe) } });
    return affected;
  }

  private take(id: string): HeldPlan {
    if (this.held?.id !== id) throw new Error(`No held plan with id ${id}`);
    const held = this.held;
    this.held = null;
    return held;
  }
}

function describe(o: Operation): string {
  return o.kind === 'move_local' || o.kind === 'move_remote' ? `${o.kind} ${o.from} -> ${o.to}` : `${o.kind} ${o.relPath}`;
}

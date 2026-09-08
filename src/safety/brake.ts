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
    // Keep the id stable while a plan stays held across re-evaluations, so a user decision
    // made against the id they saw still applies to the current plan.
    const id = this.held?.id ?? `held-${String(++this.seq)}`;
    const held: HeldPlan = { id, plan, verdict, heldAt: this.held?.heldAt ?? this.now() };
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

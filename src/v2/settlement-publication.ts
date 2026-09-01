import type { TaskState } from "./types.ts";

export interface SettlementPublicationGuard {
  taskId: string;
  runId: string;
  triggerSequence: number;
  targetOid?: string;
  candidateTreeOid?: string;
}

let active: SettlementPublicationGuard | undefined;

/** Settlement workers are isolated processes, so one process owns at most one guard. */
export function beginSettlementPublicationGuard(guard: SettlementPublicationGuard): void {
  active = { ...guard };
}

export function identifySettlementPublication(targetOid: string, candidateTreeOid: string): void {
  if (active) active = { ...active, targetOid, candidateTreeOid };
}

export function endSettlementPublicationGuard(): void {
  active = undefined;
}

export function settlementPublicationAllowed(taskId: string, state: TaskState): boolean {
  if (!active || active.taskId !== taskId) return true;
  const settlement = state.settlement;
  if (
    !settlement ||
    settlement.runId !== active.runId ||
    settlement.triggerSequence !== active.triggerSequence ||
    ["ready", "needs_input", "cancelled", "failed"].includes(settlement.phase)
  )
    return false;
  return true;
}

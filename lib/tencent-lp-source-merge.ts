import type { TrialLedgerFieldValue } from "./trial-ledger";

export type TencentLpBaseline = Readonly<{
  field: string;
  revision: number;
  initialized: boolean;
  commonValue: TrialLedgerFieldValue | null;
  pending: Readonly<{ before: TrialLedgerFieldValue | null; target: TrialLedgerFieldValue; phase: "planned" | "attempted" }> | null;
}>;
export type TencentLpMergeAction = "skip" | "observe" | "import" | "export" | "recover" | "cancel" | "uncertain";
function hasValue(value: TrialLedgerFieldValue | null) { return value !== null && value !== ""; }
function pendingAction(source: TrialLedgerFieldValue | null, baseline: TencentLpBaseline): TencentLpMergeAction {
  const pending = baseline.pending!;
  if (source === pending.target) return "recover";
  if (pending.phase === "planned") return "cancel";
  if (hasValue(source) && source !== pending.before) return "import";
  return "uncertain";
}
function initializedAction(source: TrialLedgerFieldValue | null, system: TrialLedgerFieldValue | null, baseline: TencentLpBaseline): TencentLpMergeAction {
  if (source === system) return "observe";
  if (hasValue(source) && source !== baseline.commonValue) return "import";
  if (hasValue(system) && system !== baseline.commonValue) return "export";
  return "skip";
}
export function planTencentLpFieldMerge(source: TrialLedgerFieldValue | null, system: TrialLedgerFieldValue | null, baseline: TencentLpBaseline): TencentLpMergeAction {
  if (baseline.pending) return pendingAction(source, baseline);
  if (baseline.initialized) return initializedAction(source, system, baseline);
  if (source === system) return "observe";
  return hasValue(source) ? "import" : hasValue(system) ? "export" : "skip";
}

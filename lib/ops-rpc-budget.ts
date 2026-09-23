export type OpsRpcBudgetOptions = Readonly<{
  timeoutMs?: number;
  deadlineAt?: number;
}>;

export type OpsRpcTiming = Readonly<{
  timeoutMs: number;
  timeoutCode: "timeout" | "deadline";
}>;

/** Resolves one RPC timer without letting a per-call timeout exceed its route deadline. */
export function resolveOpsRpcTiming(
  options: OpsRpcBudgetOptions,
  defaultTimeoutMs: number,
  now = Date.now(),
): OpsRpcTiming | null {
  const callTimeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0 || !Number.isFinite(now)) return null;
  if (options.deadlineAt === undefined) {
    return Object.freeze({ timeoutMs: callTimeoutMs, timeoutCode: "timeout" });
  }
  if (!Number.isFinite(options.deadlineAt)) return null;
  const deadlineRemainingMs = Math.floor(options.deadlineAt - now);
  const timeoutMs = Math.min(callTimeoutMs, deadlineRemainingMs);
  if (timeoutMs <= 0) return null;
  return Object.freeze({
    timeoutMs,
    timeoutCode: deadlineRemainingMs <= callTimeoutMs ? "deadline" : "timeout",
  });
}

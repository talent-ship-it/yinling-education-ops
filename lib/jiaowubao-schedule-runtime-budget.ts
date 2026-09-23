import type { OpsRpcOptions } from "./ops-store";

export const JIAOWUBAO_SCHEDULE_ROUTE_WORK_MS = 280_000;
export const JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS = 35_000;
export const JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS = 115_000;
export const JIAOWUBAO_SCHEDULE_RELEASE_TIMEOUT_MS = 5_000;
export const JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS = 12_000;

function finiteInstant(value: number, code: string) {
  if (!Number.isFinite(value)) throw new Error(code);
  return value;
}

export function jiaowubaoScheduleWorkDeadline(startedAt = Date.now()) {
  return finiteInstant(startedAt, "schedule_deadline_invalid") + JIAOWUBAO_SCHEDULE_ROUTE_WORK_MS;
}

export function assertJiaowubaoScheduleTime(
  deadlineAt: number,
  reserveMs = 0,
  requiredMs = 0,
  now = Date.now(),
) {
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(now)
    || !Number.isFinite(reserveMs) || reserveMs < 0
    || !Number.isFinite(requiredMs) || requiredMs < 0
    || now + reserveMs + requiredMs >= deadlineAt) {
    throw new Error("schedule_route_deadline");
  }
}

export function hasJiaowubaoScheduleTime(
  deadlineAt: number,
  reserveMs = 0,
  requiredMs = 0,
  now = Date.now(),
) {
  try {
    assertJiaowubaoScheduleTime(deadlineAt, reserveMs, requiredMs, now);
    return true;
  } catch {
    return false;
  }
}

export function jiaowubaoScheduleRpcOptions(
  deadlineAt: number,
  timeoutMs = 15_000,
): OpsRpcOptions {
  assertJiaowubaoScheduleTime(deadlineAt);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("schedule_rpc_timeout_invalid");
  return Object.freeze({ deadlineAt, timeoutMs });
}

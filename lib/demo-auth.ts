import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { matchesNixonPassword, nixonSessionToken } from "@/lib/nixon-auth";
import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  resolveDemoStaffAlias,
  resolveDemoStaffName,
  type DemoUser,
} from "@/lib/demo-users";

export { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, DEMO_STAFF_USERS } from "@/lib/demo-users";
export type { DemoUser } from "@/lib/demo-users";
import {
  createDemoSessionToken,
  parseDemoSessionToken,
  type DemoSessionIdentity,
} from "@/lib/demo-session-token";
import { validateTeacherSession } from "@/lib/demo-teacher-login";
import { getOpsState } from "@/lib/ops-store";
export { normaliseDemoIdentity } from "@/lib/demo-session-token";
export type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";

export const DEMO_COOKIE_NAME = "yinling_demo_auth";
const FALLBACK_LIMITED_ADMIN_PASSWORD_HASH = "e982e31a4d006b0b470fb414182c7f44bfc1e6d931c1a79c7113c5196db3077f";

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Resolve only identities whose credentials are owned by this application. */
export function resolveDemoIdentity(candidate: unknown): DemoSessionIdentity | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  if (matchesNixonPassword(candidate)) return { user: DEMO_ADMIN_USER, role: "admin" };
  const candidateHash = createHash("sha256").update(candidate).digest("hex");
  const limitedAdminHash = process.env.LIMITED_ADMIN_PASSWORD_HASH || FALLBACK_LIMITED_ADMIN_PASSWORD_HASH;
  if (safeEquals(candidateHash, limitedAdminHash)) return { user: DEMO_LIMITED_ADMIN_USER, role: "limited-admin" };

  const identity = resolveDemoStaffAlias(candidate) ?? resolveDemoStaffName(candidate);
  return identity ? { user: identity, role: "staff" } : null;
}

/** Backwards-compatible username-only helper for non-teacher credentials. */
export function resolveDemoUser(candidate: unknown): DemoUser | null {
  return resolveDemoIdentity(candidate)?.user ?? null;
}

function sessionSecret() {
  return nixonSessionToken();
}

export function demoSessionToken(identity: DemoSessionIdentity, now = new Date()) {
  const secret = sessionSecret();
  return secret ? createDemoSessionToken(identity, secret, now) : null;
}

export function getDemoSession(value: string | undefined, now = new Date()): DemoSessionIdentity | null {
  const secret = sessionSecret();
  return secret ? parseDemoSessionToken(value, secret, now) : null;
}

export type CurrentDemoSessionResolution =
  | { session: DemoSessionIdentity }
  | { error: string; status: 401 | 503 };

/**
 * Validates a signed session against mutable server-owned identity state.
 * Fixed application identities need only their signature; roster-backed
 * teacher identities must still exist exactly once on every protected request.
 */
export async function getCurrentDemoSession(value: string | undefined): Promise<CurrentDemoSessionResolution> {
  const session = getDemoSession(value);
  if (!session) return { error: "请先输入访问密码。", status: 401 };
  if (session.role !== "teacher") return { session };

  try {
    const rows = await getOpsState(["teachers"]);
    const teacherRow = rows.find((row) => row.entity === "teachers");
    if (!teacherRow) {
      return { error: "老师登录状态已失效，请重新登录。", status: 401 };
    }
    const current = validateTeacherSession(session, teacherRow.payload);
    return "identity" in current
      ? { session: current.identity }
      : { error: current.error, status: current.status === 503 ? 503 : 401 };
  } catch {
    return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 };
  }
}

export function getDemoSessionUser(value: string | undefined): DemoUser | null {
  return getDemoSession(value)?.user ?? null;
}

export function hasValidDemoSession(value: string | undefined) {
  return Boolean(getDemoSession(value));
}

import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { matchesNixonPassword, nixonSessionToken } from "@/lib/nixon-auth";
import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  DEMO_STAFF_USERS,
  DEMO_TEACHER_USERS,
  type DemoUser,
} from "@/lib/demo-users";

export { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, DEMO_STAFF_USERS, DEMO_TEACHER_USERS } from "@/lib/demo-users";
export type { DemoUser } from "@/lib/demo-users";

export const DEMO_COOKIE_NAME = "yinling_demo_auth";
const DEMO_USERS: readonly DemoUser[] = [DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, ...DEMO_STAFF_USERS, ...DEMO_TEACHER_USERS];
const FALLBACK_LIMITED_ADMIN_PASSWORD_HASH = "e982e31a4d006b0b470fb414182c7f44bfc1e6d931c1a79c7113c5196db3077f";

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalise(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function resolveDemoUser(candidate: unknown): DemoUser | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  if (matchesNixonPassword(candidate)) return DEMO_ADMIN_USER;
  const candidateHash = createHash("sha256").update(candidate).digest("hex");
  const limitedAdminHash = process.env.LIMITED_ADMIN_PASSWORD_HASH || FALLBACK_LIMITED_ADMIN_PASSWORD_HASH;
  if (safeEquals(candidateHash, limitedAdminHash)) return DEMO_LIMITED_ADMIN_USER;

  const normalisedCandidate = normalise(candidate);
  return [...DEMO_STAFF_USERS, ...DEMO_TEACHER_USERS].find((user) => normalise(user) === normalisedCandidate) ?? null;
}

export function demoSessionToken(user: DemoUser) {
  const adminToken = nixonSessionToken();
  if (!adminToken) return null;
  return createHmac("sha256", adminToken).update(`yinling-demo-session-v2:${user}`).digest("hex");
}

export function getDemoSessionUser(value: string | undefined): DemoUser | null {
  if (!value) return null;
  return DEMO_USERS.find((user) => {
    const token = demoSessionToken(user);
    return Boolean(token && safeEquals(value, token));
  }) ?? null;
}

export function hasValidDemoSession(value: string | undefined) {
  return Boolean(getDemoSessionUser(value));
}

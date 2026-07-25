import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { matchesNixonPassword, nixonSessionSigningKey } from "@/lib/nixon-auth";

export const DEMO_COOKIE_NAME = "yinling_demo_auth";
export const DEMO_ADMIN_USER = "Nixon";
export const DEMO_STAFF_USERS = ["Abby", "Ella", "Molly", "Thea", "Tiffany"] as const;

export type DemoUser = typeof DEMO_ADMIN_USER | (typeof DEMO_STAFF_USERS)[number];

const DEMO_USERS: readonly DemoUser[] = [DEMO_ADMIN_USER, ...DEMO_STAFF_USERS];

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

  const normalisedCandidate = normalise(candidate);
  return DEMO_STAFF_USERS.find((user) => normalise(user) === normalisedCandidate) ?? null;
}

export function demoSessionToken(user: DemoUser) {
  return createHmac("sha256", nixonSessionSigningKey()).update(`yinling-demo-session-v2:${user}`).digest("hex");
}

export function getDemoSessionUser(value: string | undefined): DemoUser | null {
  if (!value) return null;
  return DEMO_USERS.find((user) => safeEquals(value, demoSessionToken(user))) ?? null;
}

export function hasValidDemoSession(value: string | undefined) {
  return Boolean(getDemoSessionUser(value));
}

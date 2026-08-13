import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  DEMO_STAFF_USERS,
  type DemoUser,
} from "@/lib/demo-users";

const SESSION_VERSION = 3;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type DemoSessionRole = "admin" | "limited-admin" | "staff" | "teacher";
export type DemoSessionIdentity = Readonly<{
  user: DemoUser;
  role: DemoSessionRole;
}>;

type DemoSessionPayload = DemoSessionIdentity & Readonly<{
  v: typeof SESSION_VERSION;
  exp: number;
}>;

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normaliseDemoIdentity(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-AU");
}

function validRole(value: unknown): value is DemoSessionRole {
  return value === "admin" || value === "limited-admin" || value === "staff" || value === "teacher";
}

function roleMatchesPinnedIdentity(identity: DemoSessionIdentity) {
  if (identity.user === DEMO_ADMIN_USER) return identity.role === "admin";
  if (identity.user === DEMO_LIMITED_ADMIN_USER) return identity.role === "limited-admin";
  const pinnedStaff = DEMO_STAFF_USERS.some((staff) => normaliseDemoIdentity(staff) === normaliseDemoIdentity(identity.user));
  // A roster teacher may share a name with pinned staff. The signed role keeps
  // the identities separate; teacher sessions are rechecked against the live
  // roster by getCurrentDemoSession on every protected request.
  return pinnedStaff
    ? identity.role === "staff" || identity.role === "teacher"
    : identity.role === "teacher";
}

function signSessionPayload(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`yinling-demo-session-v${SESSION_VERSION}:${encodedPayload}`)
    .digest("base64url");
}

export function createDemoSessionToken(identity: DemoSessionIdentity, secret: string, now = new Date()) {
  if (!secret || !identity.user.trim() || !validRole(identity.role) || !roleMatchesPinnedIdentity(identity)) return null;
  const payload: DemoSessionPayload = {
    v: SESSION_VERSION,
    user: identity.user.normalize("NFKC").trim(),
    role: identity.role,
    exp: Math.floor(now.getTime() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signSessionPayload(encodedPayload, secret)}`;
}

export function parseDemoSessionToken(value: string | undefined, secret: string, now = new Date()): DemoSessionIdentity | null {
  if (!value || !secret) return null;
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(".", separator + 1) !== -1) return null;
  const encodedPayload = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  const expectedSignature = signSessionPayload(encodedPayload, secret);
  if (!safeEquals(suppliedSignature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<DemoSessionPayload>;
    if (payload.v !== SESSION_VERSION || typeof payload.user !== "string" || !payload.user.trim()) return null;
    if (!validRole(payload.role) || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) return null;
    if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;
    const identity = { user: payload.user.normalize("NFKC").trim(), role: payload.role } satisfies DemoSessionIdentity;
    return roleMatchesPinnedIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

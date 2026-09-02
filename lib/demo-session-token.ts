import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  DEMO_STAFF_USERS,
  type DemoUser,
} from "@/lib/demo-users";

const SESSION_VERSION = 4;
const LEGACY_SESSION_VERSION = 3;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const SERVER_SESSION_VERSION = 5;
export const SERVER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const SERVER_SESSION_IDLE_SECONDS = 60 * 60 * 12;

export type DemoSessionRole = "admin" | "limited-admin" | "staff" | "teacher";
export type DemoSessionScopeMember = Readonly<{
  kind: string;
  key: string;
}>;

export type DemoSessionIdentity = Readonly<{
  user: DemoUser;
  role: DemoSessionRole;
  /** Present after the account adopts an independent password. */
  credentialVersion?: number;
  /** Present only for a database-backed session. */
  accountId?: string;
  sessionId?: string;
  accessVersion?: number;
  roleVersion?: number;
  scopeVersion?: number;
  mfaVerified?: boolean;
  /** Effective server-owned authorization for database-backed sessions. */
  permissions?: readonly string[];
  scopeMembers?: readonly DemoSessionScopeMember[];
}>;

export type ServerSessionEnvelope = Readonly<{
  sessionId: string;
  tokenHash: string;
}>;

/** Missing lifecycle authorization is never interpreted as an unrestricted role. */
export function hasDemoSessionPermission(identity: DemoSessionIdentity, permission: string) {
  return identity.permissions?.includes("*") === true
    || identity.permissions?.includes(permission) === true;
}

/** Global review/import surfaces cannot safely project a partial student scope. */
export function hasUnrestrictedDemoSessionScope(identity: DemoSessionIdentity) {
  return identity.scopeMembers?.some((member) => member.kind === "all" && member.key === "*") === true;
}

type DemoSessionPayload = DemoSessionIdentity & Readonly<{
  v: typeof SESSION_VERSION;
  exp: number;
  cv?: number;
}>;

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

const SERVER_SESSION_PATTERN = /^v5\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

/** Generate an opaque cookie value; only its SHA-256 digest enters Supabase. */
export function createServerSessionToken(sessionId = randomUUID()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)) return null;
  const token = `v${SERVER_SESSION_VERSION}.${sessionId}.${randomBytes(32).toString("base64url")}`;
  return { token, sessionId, tokenHash: hashServerSessionToken(token) } as const;
}

export function hashServerSessionToken(token: string) {
  return createHash("sha256")
    .update(`yinling-server-session-v${SERVER_SESSION_VERSION}\u0000${token}`, "utf8")
    .digest("hex");
}

export function parseServerSessionToken(value: string | undefined): ServerSessionEnvelope | null {
  if (!value) return null;
  const match = value.match(SERVER_SESSION_PATTERN);
  if (!match) return null;
  return { sessionId: match[1], tokenHash: hashServerSessionToken(value) };
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

function signSessionPayload(
  encodedPayload: string,
  secret: string,
  version: typeof SESSION_VERSION | typeof LEGACY_SESSION_VERSION = SESSION_VERSION,
) {
  return createHmac("sha256", secret)
    .update(`yinling-demo-session-v${version}:${encodedPayload}`)
    .digest("base64url");
}

export function createDemoSessionToken(identity: DemoSessionIdentity, secret: string, now = new Date()) {
  if (!secret || !identity.user.trim() || !validRole(identity.role) || !roleMatchesPinnedIdentity(identity)) return null;
  if (identity.credentialVersion !== undefined
      && (!Number.isSafeInteger(identity.credentialVersion) || identity.credentialVersion <= 0)) return null;
  const payload: DemoSessionPayload = {
    v: SESSION_VERSION,
    user: identity.user.normalize("NFKC").trim(),
    role: identity.role,
    exp: Math.floor(now.getTime() / 1000) + SESSION_MAX_AGE_SECONDS,
    ...(identity.credentialVersion === undefined ? {} : { cv: identity.credentialVersion }),
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

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<Omit<DemoSessionPayload, "v">> & { v?: unknown };
    if ((payload.v !== SESSION_VERSION && payload.v !== LEGACY_SESSION_VERSION)
        || typeof payload.user !== "string" || !payload.user.trim()) return null;
    const expectedSignature = signSessionPayload(encodedPayload, secret, payload.v);
    if (!safeEquals(suppliedSignature, expectedSignature)) return null;
    if (!validRole(payload.role) || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) return null;
    if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;
    if (payload.v === LEGACY_SESSION_VERSION && payload.cv !== undefined) return null;
    if (payload.cv !== undefined && (!Number.isSafeInteger(payload.cv) || payload.cv <= 0)) return null;
    const identity = {
      user: payload.user.normalize("NFKC").trim(),
      role: payload.role,
      ...(payload.cv === undefined ? {} : { credentialVersion: payload.cv }),
    } satisfies DemoSessionIdentity;
    return roleMatchesPinnedIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

import { isWecomRecord } from "./wecom-validation";

const STATES = new Set([
  "starting", "connected", "authenticated", "disconnected", "reconnecting",
  "error", "terminal_connection_error", "storage_error",
  "paused_duplicate_connection", "stopped",
]);
const ERROR_CODE = /^[A-Za-z0-9_-]{1,80}$/u;
const COUNT_KEYS = [
  "receivedThisRun",
  "initialRepliesThisRun",
  "initialStreamRepliesThisRun",
  "initialStreamFailuresThisRun",
  "initialReplyFallbacksThisRun",
  "initialReplyFailuresThisRun",
  "acknowledgementsThisRun",
  "acknowledgementFailuresThisRun",
] as const;
const OPTIONAL_DATE_KEYS = [
  "authenticatedAt",
  "lastMessageAt",
  "lastInitialReplyAt",
  "lastInitialStreamErrorAt",
  "lastInitialReplyErrorAt",
  "lastAcknowledgementAt",
] as const;
const OPTIONAL_ERROR_KEYS = [
  "lastInitialStreamError",
  "lastInitialReplyError",
  "lastAcknowledgementError",
] as const;

export type WecomReceiverHealth = Readonly<{
  state: string;
  connected: boolean;
  startedAt: string;
  updatedAt: string;
  authenticatedAt: string | null;
  lastMessageAt: string | null;
  receivedThisRun: number;
  initialRepliesThisRun: number;
  initialStreamRepliesThisRun: number;
  initialStreamFailuresThisRun: number;
  initialReplyFallbacksThisRun: number;
  initialReplyFailuresThisRun: number;
  acknowledgementsThisRun: number;
  acknowledgementFailuresThisRun: number;
  lastInitialReplyAt: string | null;
  lastInitialStreamError: string | null;
  lastInitialStreamErrorAt: string | null;
  lastInitialReplyError: string | null;
  lastInitialReplyErrorAt: string | null;
  lastAcknowledgementAt: string | null;
  lastAcknowledgementError: string | null;
}>;

export class WecomReceiverHealthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WecomReceiverHealthError";
  }
}

function fail(code: string, message: string): never {
  throw new WecomReceiverHealthError(code, message);
}

function instant(value: unknown, field: string, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== "string") fail("invalid_health", `${field} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail("invalid_health", `${field} must be an ISO timestamp.`);
  }
  return value;
}

function count(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) {
    fail("invalid_health", `${field} must be a bounded non-negative integer.`);
  }
  return Number(value);
}

function errorCode(value: unknown, field: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ERROR_CODE.test(value)) {
    fail("invalid_health", `${field} must be a bounded provider code.`);
  }
  return value;
}

/** Accepts only aggregate health fields; callback frames and content cannot cross this boundary. */
export function normalizeWecomReceiverHealth(input: unknown): WecomReceiverHealth {
  if (!isWecomRecord(input) || Object.keys(input).some((key) => key !== "health") || !isWecomRecord(input.health)) {
    fail("invalid_health", "health must be an object.");
  }
  const health = input.health;
  const allowed = new Set([
    "state", "connected", "startedAt", "updatedAt",
    ...COUNT_KEYS, ...OPTIONAL_DATE_KEYS, ...OPTIONAL_ERROR_KEYS,
  ]);
  if (Object.keys(health).some((key) => !allowed.has(key))) {
    fail("unexpected_field", "health contains an unsupported field.");
  }
  if (typeof health.state !== "string" || !STATES.has(health.state)) {
    fail("invalid_health", "health.state is invalid.");
  }
  if (typeof health.connected !== "boolean") fail("invalid_health", "health.connected must be boolean.");

  return Object.freeze({
    state: health.state,
    connected: health.connected,
    startedAt: instant(health.startedAt, "health.startedAt"),
    updatedAt: instant(health.updatedAt, "health.updatedAt"),
    authenticatedAt: instant(health.authenticatedAt, "health.authenticatedAt", true),
    lastMessageAt: instant(health.lastMessageAt, "health.lastMessageAt", true),
    ...Object.fromEntries(COUNT_KEYS.map((key) => [key, count(health[key], `health.${key}`)])),
    lastInitialReplyAt: instant(health.lastInitialReplyAt, "health.lastInitialReplyAt", true),
    lastInitialStreamError: errorCode(health.lastInitialStreamError, "health.lastInitialStreamError"),
    lastInitialStreamErrorAt: instant(health.lastInitialStreamErrorAt, "health.lastInitialStreamErrorAt", true),
    lastInitialReplyError: errorCode(health.lastInitialReplyError, "health.lastInitialReplyError"),
    lastInitialReplyErrorAt: instant(health.lastInitialReplyErrorAt, "health.lastInitialReplyErrorAt", true),
    lastAcknowledgementAt: instant(health.lastAcknowledgementAt, "health.lastAcknowledgementAt", true),
    lastAcknowledgementError: errorCode(health.lastAcknowledgementError, "health.lastAcknowledgementError"),
  }) as WecomReceiverHealth;
}

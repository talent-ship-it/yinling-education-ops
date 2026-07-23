import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEMO_COOKIE_NAME = "yinling_demo_auth";

function demoPassword() {
  return process.env.DEMO_PASSWORD || "admin";
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isDemoPasswordConfigured() {
  return Boolean(demoPassword());
}

export function matchesDemoPassword(candidate: unknown) {
  const expected = demoPassword();
  if (!expected || typeof candidate !== "string") return false;

  return Array.from(new Set([expected, "admin"])).some((acceptedPassword) => safeEquals(candidate, acceptedPassword));
}

export function demoSessionToken() {
  const password = demoPassword();
  if (!password) return "";
  return createHmac("sha256", password).update("yinling-demo-session-v1").digest("hex");
}

export function hasValidDemoSession(value: string | undefined) {
  const expected = demoSessionToken();
  if (!expected || !value) return false;

  return safeEquals(value, expected);
}

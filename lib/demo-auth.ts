import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEMO_COOKIE_NAME = "yinling_demo_auth";

function demoPassword() {
  return process.env.DEMO_PASSWORD || "";
}

export function isDemoPasswordConfigured() {
  return Boolean(demoPassword());
}

export function matchesDemoPassword(candidate: unknown) {
  const expected = demoPassword();
  if (!expected || typeof candidate !== "string") return false;

  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function demoSessionToken() {
  const password = demoPassword();
  if (!password) return "";
  return createHmac("sha256", password).update("yinling-demo-session-v1").digest("hex");
}

export function hasValidDemoSession(value: string | undefined) {
  const expected = demoSessionToken();
  if (!expected || !value) return false;

  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}

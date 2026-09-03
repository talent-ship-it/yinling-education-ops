import "server-only";

import { timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { NextRequest } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

/**
 * The same full-admin boundary that protects the current payroll workspace.
 * A normal staff or limited-admin demo session is not sufficient to pull
 * student-level JiaoWuBao records.
 */
export async function hasMonthlyPayrollDashboardAccess(): Promise<boolean> {
  const cookieStore = await cookies();
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  return actor === DEMO_ADMIN_USER && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
}

export function hasMonthlyPayrollCronAccess(request: NextRequest): boolean {
  const expected = process.env.JIAOWUBAO_MONTHLY_PAYROLL_CRON_SECRET?.trim() ?? "";
  const header = request.headers.get("authorization");
  if (expected.length < 32 || !header?.startsWith("Bearer ")) return false;

  const received = header.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

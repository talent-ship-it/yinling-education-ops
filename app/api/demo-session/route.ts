import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { IMPERSONATION_COOKIE_NAME } from "@/lib/account-impersonation";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

function identitySwitchStatus(session: Parameters<typeof hasFullAdminAccess>[0], elevationCookie: string | undefined) {
  return {
    canSwitchIdentity: Boolean(session.impersonator) || hasFullAdminAccess(session, elevationCookie),
    impersonator: session.impersonator?.user ?? null,
  };
}

function sessionFailure(resolved: { error: string; status: number }, store: Awaited<ReturnType<typeof cookies>>) {
  return NextResponse.json(
    { ok: false, user: null, role: null, error: resolved.error,
      canReturnAdministrator: Boolean(store.get(IMPERSONATION_COOKIE_NAME)?.value) },
    { status: resolved.status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(
    cookieStore.get(DEMO_COOKIE_NAME)?.value,
    { allowPasswordChangeRequired: true },
  );
  if (!("session" in resolved)) {
    return sessionFailure(resolved, cookieStore);
  }
  const { session } = resolved;

  return NextResponse.json(
    {
      ok: true,
      user: session.user,
      role: session.role,
      mustChangePassword: resolved.mustChangePassword,
      ...identitySwitchStatus(session, cookieStore.get(NIXON_COOKIE_NAME)?.value),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

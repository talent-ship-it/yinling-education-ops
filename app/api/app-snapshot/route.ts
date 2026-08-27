import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  buildOpsAccessContext,
  canReadUnrestrictedOpsData,
  filterOpsStateRows,
  managedExamStudentProjectionSnapshot,
  managedTrialPaymentStudentProjectionSnapshot,
} from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { projectOperationalAuditEntry } from "@/lib/operational-audit";
import { getOperationalAudit, getOpsSources, getOpsState } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return noStore({ error: resolved.error }, resolved.status);
  }
  const { session } = resolved;

  try {
    const rows = await getOpsState();
    const actor = session.user;
    const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    const visibleRows = filterOpsStateRows(rows, access);
    const managedExamSnapshot = managedExamStudentProjectionSnapshot(rows, access);
    const managedTrialPaymentSnapshot = managedTrialPaymentStudentProjectionSnapshot(rows, access);
    const sourceAccess = canReadUnrestrictedOpsData(access);
    const payload = Object.fromEntries(visibleRows.map((row) => [row.entity, row.payload]));
    const versions = Object.fromEntries(visibleRows.map((row) => [row.entity, row.version]));
    const [syncSources, operationalAudit] = sourceAccess
      ? await Promise.all([getOpsSources(), getOperationalAudit()])
      : [[], []];
    return noStore({
      ...payload,
      ...(sourceAccess ? { audit: operationalAudit.map(projectOperationalAuditEntry) } : {}),
      versions,
      syncSources,
      managedExamStudents: managedExamSnapshot.students,
      managedExamSnapshot,
      managedTrialPaymentSnapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supabase 真实资料读取失败。";
    return noStore({ error: message }, 503);
  }
}

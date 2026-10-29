import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  buildOpsAccessContext,
  canReadUnrestrictedOpsData,
  filterOpsStateRows,
  managedExamStudentProjectionSnapshot,
  managedTrialPaymentStudentProjectionSnapshot,
} from "@/lib/ops-access";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  JIAOWUBAO_AUTHORITY_SOURCE_ID,
  sanitizeJiaowubaoAuthoritySourceForBrowser,
} from "@/lib/jiaowubao-authority-status";
import { projectOperationalAuditEntry } from "@/lib/operational-audit";
import { getOperationalAudit, getOpsSources, getOpsState } from "@/lib/ops-store";
import { privateJsonResponse } from "@/lib/private-json-response";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request?: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return noStore({ error: resolved.error }, resolved.status);
  }
  const { session } = resolved;

  try {
    const rows = await getOpsState();
    const actor = session.user;
    const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
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
    const browserSyncSources = syncSources.flatMap((source) => {
      if (source.source_id !== JIAOWUBAO_AUTHORITY_SOURCE_ID) return [source];
      const sanitized = sanitizeJiaowubaoAuthoritySourceForBrowser(source);
      return sanitized ? [sanitized] : [];
    });
    return privateJsonResponse({
      ...payload,
      ...(sourceAccess ? { audit: operationalAudit.map(projectOperationalAuditEntry) } : {}),
      versions,
      syncSources: browserSyncSources,
      managedExamStudents: managedExamSnapshot.students,
      managedExamSnapshot,
      managedTrialPaymentSnapshot,
    }, request);
  } catch {
    const message = "Supabase 真实资料读取失败。";
    return noStore({ error: message }, 503);
  }
}

import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { accountIdentityKey } from "@/lib/account-credentials";
import { getOpsState, getOpsVersions, getAccountByIdentity, getJiaowubaoOpenApiScheduleSnapshotWindow } from "@/lib/ops-store";
import { TRIAL_OPERATIONS } from "@/lib/lp-workflows";
import { createAvaCalendarHandler } from "@/lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "@/lib/ava-calendar-snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const jar = await cookies();
  const deadlineAt = Date.now() + 45000;
  const handler = createAvaCalendarHandler({
    readSession: async () => {
      const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
      return "session" in resolved ? { session: resolved.session, fullAdmin: hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value) } : resolved;
    },
    readRows: () => getOpsState(["students", "teachers", "bookings", "lpItems"], { deadlineAt }),
    readVersions: () => getOpsVersions(),
    readAccounts: async () => {
      const accounts = await Promise.all(TRIAL_OPERATIONS.map((owner) => getAccountByIdentity(accountIdentityKey(owner, "staff"))));
      return accounts.flatMap((account) => account ? [{ account_id: account.account_id, account_name: account.account_name, account_role: account.account_role, status: account.status }] : []);
    },
    readSnapshot: (window) => readAvaCalendarSnapshot(window, (page) => getJiaowubaoOpenApiScheduleSnapshotWindow({
      windowStart: window.start, windowEnd: window.end, scope: "all", teacherLabels: null, studentMemberIds: null, studentNameKeys: null,
      ...page,
    }, { deadlineAt })),
  });
  return handler(request);
}

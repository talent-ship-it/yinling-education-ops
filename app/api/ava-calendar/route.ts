import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { accountIdentityKey } from "@/lib/account-credentials";
import { getOpsState, getOpsVersions, getOpsSources, getAccountByIdentity, getJiaowubaoOpenApiScheduleSnapshotWindow } from "@/lib/ops-store";
import { TRIAL_OPERATIONS } from "@/lib/lp-workflows";
import { createAvaCalendarHandler, createAvaCalendarRangeHandler, createAvaCalendarRouteComposition } from "@/lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "@/lib/ava-calendar-snapshot";
import { createAvaCalendarReadDiagnostics } from "@/lib/ava-calendar-read-diagnostics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const jar = await cookies();
  const deadlineAt = Date.now() + 45000;
  const diagnostics = createAvaCalendarReadDiagnostics(request, deadlineAt);
  const composition = createAvaCalendarRouteComposition(readAvaCalendarSnapshot,
    { getOpsSources, getJiaowubaoOpenApiScheduleSnapshotWindow }, deadlineAt, () => Date.now(), diagnostics.options("snapshot"));
  const createHandler = new URL(request.url).pathname === "/api/ava-calendar/range" ? createAvaCalendarRangeHandler : createAvaCalendarHandler;
  const handler = createHandler({
    ...composition,
    strictSourceIdentity: true,
    readSnapshot: (window, assertAuthority) => diagnostics.read("snapshot", () => composition.readSnapshot(window, assertAuthority)),
    readSession: () => diagnostics.read("session", async () => {
      const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value, { rpcOptions: diagnostics.options("session") });
      return "session" in resolved ? { session: resolved.session, fullAdmin: hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value) } : resolved;
    }),
    readRows: () => diagnostics.read("rows", () => getOpsState(["students", "teachers", "bookings", "lpItems"], diagnostics.options("rows"))),
    readVersions: () => diagnostics.read("versions", () => getOpsVersions(diagnostics.options("versions"))),
    readAccounts: () => diagnostics.read("accounts", async () => {
      const accounts = await Promise.all(TRIAL_OPERATIONS.map((owner) => getAccountByIdentity(accountIdentityKey(owner, "staff"), diagnostics.options("accounts"))));
      return accounts.flatMap((account) => account ? [{ account_id: account.account_id, account_name: account.account_name, account_role: account.account_role, status: account.status }] : []);
    }),
  });
  return diagnostics.finish(await handler(request));
}

import { accountIdentityKey } from "@/lib/account-credentials";
import { getOpsState, getOpsVersions, getOpsSources, getAccountByIdentity, getJiaowubaoOpenApiScheduleSnapshotWindow } from "@/lib/ops-store";
import { TRIAL_OPERATIONS } from "@/lib/lp-workflows";
import { createAvaCalendarMachineHandler, createAvaCalendarRouteComposition } from "@/lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "@/lib/ava-calendar-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const deadlineAt = Date.now() + 45000;
  const composition = createAvaCalendarRouteComposition(readAvaCalendarSnapshot,
    { getOpsSources, getJiaowubaoOpenApiScheduleSnapshotWindow }, deadlineAt, () => Date.now());
  return createAvaCalendarMachineHandler({
    ...composition,
    strictSourceIdentity: true,
    readTokenSha256: () => process.env.AVA_CALENDAR_SERVICE_TOKEN_SHA256,
    readRows: () => getOpsState(["students", "teachers", "bookings", "lpItems"], { deadlineAt }),
    readVersions: () => getOpsVersions(),
    readAccounts: async () => {
      const accounts = await Promise.all(TRIAL_OPERATIONS.map((owner) => getAccountByIdentity(accountIdentityKey(owner, "staff"))));
      return accounts.flatMap((account) => account ? [{ account_id: account.account_id, account_name: account.account_name, account_role: account.account_role, status: account.status }] : []);
    },
  })(request);
}

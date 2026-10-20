import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getJiaowubaoOpenApiScheduleSnapshotWindow, getOpsState, readWecomLpDraft } from "@/lib/ops-store";
import { readJiaowubaoTrialSourceWindow } from "@/lib/jiaowubao-trial-source-window";
import { createTrialScreenshotMatchHandler } from "@/lib/trial-screenshot-match-service";

export const dynamic = "force-dynamic";
export const POST = createTrialScreenshotMatchHandler({
  readSession: async () => {
    const jar = await cookies();
    const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
    if (!("session" in resolved)) return resolved;
    return { session: resolved.session, fullAdmin: hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value) };
  },
  readRows: () => getOpsState(["students", "lpItems", "tasks", "files"]),
  readDraft: readWecomLpDraft,
  readSnapshot: getJiaowubaoOpenApiScheduleSnapshotWindow,
  readSource: readJiaowubaoTrialSourceWindow,
});

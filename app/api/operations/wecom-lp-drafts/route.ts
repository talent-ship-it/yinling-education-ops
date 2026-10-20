import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { createWecomLpIntakeHandlers } from "@/lib/wecom-lp-intake-service";
import { confirmWecomLpDraftAtomic, getOpsState, readWecomLpDraft, readWecomLpDrafts } from "@/lib/ops-store";

export const dynamic = "force-dynamic";
const handlers = createWecomLpIntakeHandlers({
  readSession: async () => {
    const jar = await cookies();
    const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
    if (!("session" in resolved)) return resolved;
    return { session: resolved.session, fullAdmin: hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value) };
  },
  readRows: () => getOpsState(["students", "lpItems", "tasks", "files"]),
  readDraft: readWecomLpDraft,
  readDrafts: readWecomLpDrafts,
  confirm: confirmWecomLpDraftAtomic,
});
export const GET = handlers.GET;
export const POST = handlers.POST;

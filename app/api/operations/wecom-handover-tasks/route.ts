import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { readWecomHandoverTaskInput, saveWecomHandoverTasks } from "@/lib/ops-store";
import { createWecomHandoverTaskHandlers } from "@/lib/wecom-handover-task-service";

export const dynamic = "force-dynamic";
const handlers = createWecomHandoverTaskHandlers({
  identify: async () => {
    const jar = await cookies();
    const result = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
    if (!("session" in result)) return result;
    return { session: result.session, fullAdmin: hasFullAdminAccess(result.session, jar.get(NIXON_COOKIE_NAME)?.value) };
  },
  read: readWecomHandoverTaskInput,
  save: saveWecomHandoverTasks,
  now: () => new Date(),
});
export const GET = handlers.GET;
export const POST = handlers.POST;

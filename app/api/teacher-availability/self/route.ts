import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { getOpsState, putTeacherSelfAvailabilityState } from "@/lib/ops-store";
import { createTeacherSelfAvailabilityHandler } from "@/lib/teacher-availability-self-service";

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  const jar = await cookies();
  return createTeacherSelfAvailabilityHandler({
    readSession: () => getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value),
    readRows: () => getOpsState(["teachers", "students", "bookings"]),
    save: putTeacherSelfAvailabilityState,
  })(request);
}
export const GET = handle;
export const POST = handle;

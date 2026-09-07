import { NextResponse } from "next/server";
import { hasReminderCronSecret } from "@/lib/reminder-cron-auth";
import { getOpsState } from "@/lib/ops-store";
import { classroomProvisionPlan, type ProvisionBooking } from "@/lib/classroom-provision-plan";
import { createMeeting, meetingIdForOccurrence } from "@/lib/bigbluebutton";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!hasReminderCronSecret(request)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const bookings = rows.find((row) => row.entity === "bookings")?.payload;
    const students = rows.find((row) => row.entity === "students")?.payload;
    const teachers = rows.find((row) => row.entity === "teachers")?.payload;
    if (!Array.isArray(bookings) || !Array.isArray(students) || !Array.isArray(teachers)) throw new Error("Source unavailable");
    const studentMap = new Map(students.filter((item) => item && !item.importArchived).map((item) => [item.id, item]));
    const teacherIds = new Set(teachers.map((item) => item?.id));
    const plan = classroomProvisionPlan(bookings as ProvisionBooking[], new Date()).filter((item) => studentMap.has(item.occurrence.studentId) && teacherIds.has(item.occurrence.teacherId));
    let created = 0, existing = 0, failed = 0;
    // Bound runtime to three BBB timeout windows. Rotate overflow candidates so
    // already-created rooms cannot permanently starve later lessons on every tick.
    const cursor = plan.length > 60 ? (Math.floor(Date.now() / 300000) * 60) % plan.length : 0;
    const batch = [...plan.slice(cursor), ...plan.slice(0, cursor)].slice(0, 60);
    for (let offset = 0; offset < batch.length; offset += 20) {
      await Promise.all(batch.slice(offset, offset + 20).map(async ({ occurrence, booking }) => {
        try {
          const student = studentMap.get(occurrence.studentId)!;
          const result = await createMeeting({ meetingId: meetingIdForOccurrence(occurrence.occurrenceId), name: `${student.name} · ${booking.course ?? "在线课堂"}`, durationMinutes: occurrence.scheduledDurationMinutes, logoutUrl: new URL(request.url).origin, occurrenceId: occurrence.occurrenceId, bookingId: booking.id, studentId: occurrence.studentId!, teacherId: occurrence.teacherId! });
          if (result.duplicate) existing += 1; else created += 1;
        } catch { failed += 1; }
      }));
    }
    return NextResponse.json({ processed: batch.length, created, existing, failed, deferred: Math.max(0, plan.length - batch.length) }, { status: failed || plan.length > batch.length ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Classroom provisioning unavailable" }, { status: 503 }); }
}

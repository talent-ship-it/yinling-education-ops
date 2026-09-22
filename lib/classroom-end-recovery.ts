export type ClassroomClosingRecord = Readonly<{ occurrence_id: string; meeting_id: string; status: "closing" | "ended" }>;
export type ClassroomEndDependencies = Readonly<{
  status: (meetingId: string) => Promise<{ running: boolean }>;
  end: (meetingId: string) => Promise<unknown>;
  finish: (occurrenceId: string, stopped: boolean) => Promise<ClassroomClosingRecord>;
}>;

/** A provider acknowledgement alone is not proof the room is stopped. */
export async function reconcileClassroomEnd(record: ClassroomClosingRecord, dependencies: ClassroomEndDependencies) {
  if (record.status === "ended") return record;
  let stopped = false;
  try {
    const status = await dependencies.status(record.meeting_id);
    if (status.running) {
      await dependencies.end(record.meeting_id);
      stopped = !(await dependencies.status(record.meeting_id)).running;
    } else {
      stopped = true;
    }
  } catch {
    // Keep the durable intent pending after an ambiguous provider response.
    // The next browser retry or cron pass rechecks the provider independently.
  }
  return dependencies.finish(record.occurrence_id, stopped);
}

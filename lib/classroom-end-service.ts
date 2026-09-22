import "server-only";
import { endMeeting, meetingStatus } from "@/lib/bigbluebutton";
import { finishClassroomEnd, readClassroomEndRequests, type ClassroomEndRequest } from "@/lib/ops-store";
import { reconcileClassroomEnd } from "@/lib/classroom-end-recovery";

export const reconcileStoredClassroomEnd = (record: ClassroomEndRequest) => reconcileClassroomEnd(record, {
  status: meetingStatus, end: endMeeting, finish: finishClassroomEnd,
});

export async function recoverPendingClassroomEnds() {
  const pending = await readClassroomEndRequests();
  const results = await Promise.allSettled(pending.map(reconcileStoredClassroomEnd));
  return {
    processed: results.length,
    ended: results.filter((result) => result.status === "fulfilled" && result.value.status === "ended").length,
    pending: results.filter((result) => result.status === "rejected" || result.value.status !== "ended").length,
  };
}

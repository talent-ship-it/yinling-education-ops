import { isLessonDuration } from "./lesson-duration";

/**
 * BBB's timer starts when the room is created, not when teaching starts.
 * Keep the room alive through the scheduled end without changing billable
 * minutes. Room lifetime may exceed the six-hour teaching-duration limit.
 */
export function classroomMeetingDurationMinutes(
  scheduledStartsAt: number,
  scheduledDurationMinutes: number,
  now = Date.now(),
) {
  if (!Number.isFinite(scheduledStartsAt) || !Number.isFinite(now) || !isLessonDuration(scheduledDurationMinutes)) {
    throw new RangeError("Invalid classroom schedule.");
  }
  const remainingMinutes = Math.ceil((scheduledStartsAt + scheduledDurationMinutes * 60_000 - now) / 60_000);
  if (!Number.isSafeInteger(remainingMinutes) || remainingMinutes <= 0) {
    throw new RangeError("The scheduled classroom has already ended.");
  }
  return remainingMinutes;
}

/** Teaching durations use whole minutes; 6 hours matches the classroom provider limit. */
export function isLessonDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 15 && value <= 360;
}

/** Teaching durations use whole minutes, up to six hours per lesson. */
export function isLessonDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 15 && value <= 360;
}

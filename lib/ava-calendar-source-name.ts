import { trialAccountLetter } from "./trial-account-label";

export function avaCalendarSourceStudentName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 240) return null;
  const studentName = value.replace(/[\r\n]+/g, " ");
  if (!studentName.trim() || /[<>\p{Cc}\p{Cf}]/u.test(studentName) || trialAccountLetter(studentName.replace(/\p{Z}/gu, ""))) return null;
  return studentName.trim();
}

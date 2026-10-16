import { trialAccountLetter } from "./lp-workflows";

export function avaCalendarSourceStudentName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 240 || !value.trim() || /[<>\p{Cc}\p{Cf}]/u.test(value) || trialAccountLetter(value)) return null;
  return value.trim();
}

import { createHmac, timingSafeEqual } from "node:crypto";
export type ClassroomEntry = Readonly<{ occurrenceId: string; studentId: string; teacherId: string; date: string; start: string; duration: number; timezone: string }>;
function secret() {
  const value = process.env.BBB_API_SECRET?.trim();
  if (!value) throw new Error("Classroom entry configuration unavailable");
  return value;
}
export function signClassroomEntry(entry: ClassroomEntry) {
  const payload = Buffer.from(JSON.stringify(entry)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret()).update(`student-entry-v1:${payload}`).digest("base64url")}`;
}
export function verifyClassroomEntry(token: string): ClassroomEntry | null {
  if (token.length > 3000) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = createHmac("sha256", secret()).update(`student-entry-v1:${parts[0]}`).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString()) as ClassroomEntry; } catch { return null; }
}
export function classroomEntryOpen(startsAt: number, duration: number, now = Date.now()) {
  return Number.isFinite(startsAt) && now >= startsAt - 15 * 60000 && now <= startsAt + duration * 60000;
}

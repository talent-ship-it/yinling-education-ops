import type { TeacherAvailabilityOccurrence } from "./teacher-availability";
export type CalendarOccupation = Readonly<{ id: string; teacherId: string; startsAt: string; endsAt: string; label: string }>;
export type AvailabilitySegment = Readonly<{ startsAt: string; endsAt: string; occupied: boolean; labels: string[] }>;
/** Split on every occupied boundary so overlapping lessons never turn busy time green. */
export function splitAvailability(window: Pick<TeacherAvailabilityOccurrence, "teacherId" | "startsAt" | "endsAt">, occupations: readonly CalendarOccupation[]): AvailabilitySegment[] {
  const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const overlapping = occupations.filter((item) => item.teacherId === window.teacherId && Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start && Date.parse(item.endsAt) > Date.parse(item.startsAt));
  const points = [...new Set([start, end, ...overlapping.flatMap((item) => [Math.max(start, Date.parse(item.startsAt)), Math.min(end, Date.parse(item.endsAt))])])].sort((a, b) => a - b);
  return points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const labels = [...new Set(overlapping.filter((item) => Date.parse(item.startsAt) < next && Date.parse(item.endsAt) > point).map((item) => item.label))];
    return { startsAt: new Date(point).toISOString(), endsAt: new Date(next).toISOString(), occupied: labels.length > 0, labels };
  });
}

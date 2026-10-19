import type { AttendancePartyEvidence, LessonAttendanceEvidence } from "./lesson-occurrences";

export type ClassroomPartyAttendance = {
  firstJoinedAt: string;
  lastLeftAt: string;
  durationSeconds: number;
  lateSeconds: number;
};

export type ClassroomAttendance = {
  teacher: ClassroomPartyAttendance | null;
  student: ClassroomPartyAttendance | null;
};

function partyAttendance(party: AttendancePartyEvidence | undefined, userId: string, startsAt: number): ClassroomPartyAttendance | null {
  if (!party || party.userId !== userId || !Number.isFinite(startsAt)) return null;
  const spans = (party.joinLeave ?? []).flatMap((span) => {
    const start = Date.parse(span.joinedAt);
    const end = Date.parse(span.leftAt);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [{ start, end }] : [];
  }).sort((a, b) => a.start - b.start);
  if (!spans.length) return null;
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return {
    firstJoinedAt: new Date(merged[0].start).toISOString(),
    lastLeftAt: new Date(merged.at(-1)!.end).toISOString(),
    durationSeconds: Math.floor(merged.reduce((total, span) => total + span.end - span.start, 0) / 1_000),
    lateSeconds: Math.max(0, Math.ceil((merged[0].start - startsAt) / 1_000)),
  };
}

export function projectClassroomAttendance(evidence: LessonAttendanceEvidence, expected: { teacherId: string; studentId: string; startsAt: number }): ClassroomAttendance {
  return {
    teacher: partyAttendance(evidence.teacher, expected.teacherId, expected.startsAt),
    student: partyAttendance(evidence.student, expected.studentId, expected.startsAt),
  };
}


type AttendanceExpectation = { teacherId: string; studentId: string; startsAt: number };
type EvidenceLoader = (query: { reference: string; occurrenceId: string }) => Promise<{ occurrenceId: string; evidence: LessonAttendanceEvidence } | null>;

export async function loadClassroomAttendance(reference: string | undefined, occurrenceId: string, expected: AttendanceExpectation, load: EvidenceLoader) {
  if (!reference) return { attendance: null, attendanceUnavailable: false };
  try {
    const saved = await load({ reference, occurrenceId });
    const attendance = saved?.occurrenceId === occurrenceId ? projectClassroomAttendance(saved.evidence, expected) : null;
    return { attendance, attendanceUnavailable: false };
  } catch {
    return { attendance: null, attendanceUnavailable: true };
  }
}

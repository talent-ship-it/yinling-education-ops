/**
 * Derives the subject choices that are actually known for one student.
 *
 * This intentionally does not accept the global course catalogue. The
 * catalogue is useful for discovery elsewhere, but it makes a student
 * record's package/exam selector offer unrelated subjects.
 */
export type StudentSubjectOptionInput = Readonly<{
  studentId: string;
  course?: string | null;
  lessonPackages?: readonly Readonly<{
    subjectIds?: readonly (string | null | undefined)[] | null;
  }>[];
  bookings?: readonly Readonly<{
    studentId: string;
    teacherSubjectId?: string | null;
    course?: string | null;
  }>[];
  existingSubject?: string | null;
}>;

function appendSubject(subjects: string[], seen: Set<string>, value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  subjects.push(normalized);
}

/**
 * Returns stable, first-seen subject labels for a single student's record.
 * Source order is: student's course, package bindings, that student's
 * booking teacher/course subjects, then an existing subject being edited.
 */
export function getStudentSubjectOptions(input: StudentSubjectOptionInput): string[] {
  const subjects: string[] = [];
  const seen = new Set<string>();

  appendSubject(subjects, seen, input.course);

  for (const lessonPackage of input.lessonPackages ?? []) {
    for (const subjectId of lessonPackage.subjectIds ?? []) {
      appendSubject(subjects, seen, subjectId);
    }
  }

  for (const booking of input.bookings ?? []) {
    if (booking.studentId !== input.studentId) continue;
    appendSubject(subjects, seen, booking.teacherSubjectId);
    appendSubject(subjects, seen, booking.course);
  }

  appendSubject(subjects, seen, input.existingSubject);
  return subjects;
}

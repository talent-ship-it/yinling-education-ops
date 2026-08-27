import assert from "node:assert/strict";
import test from "node:test";

import { getStudentSubjectOptions } from "../lib/student-subject-options";

test("derives only the selected student's subjects in stable first-seen order", () => {
  assert.deepEqual(getStudentSubjectOptions({
    studentId: "S-1",
    course: " English ",
    lessonPackages: [
      { subjectIds: ["English", "数学", " ", null] },
      { subjectIds: ["数学", "科学"] },
    ],
    bookings: [
      { studentId: "S-other", teacherSubjectId: "French", course: "French" },
      { studentId: "S-1", teacherSubjectId: "Tencent English", course: "English" },
      { studentId: "S-1", teacherSubjectId: "数学", course: "Physics" },
    ],
    existingSubject: " IELTS ",
  }), ["English", "数学", "科学", "Tencent English", "Physics", "IELTS"]);
});

test("does not leak global or unrelated booking subjects", () => {
  assert.deepEqual(getStudentSubjectOptions({
    studentId: "S-1",
    course: "English",
    lessonPackages: [{ subjectIds: ["English"] }],
    bookings: [
      { studentId: "S-other", teacherSubjectId: "French", course: "French" },
    ],
  }), ["English"]);
});

test("supports a student with no current course or packages when editing an existing exam", () => {
  assert.deepEqual(getStudentSubjectOptions({
    studentId: "S-1",
    bookings: [],
    existingSubject: "AEAS",
  }), ["AEAS"]);
});

test("trims blank values and de-duplicates each source", () => {
  assert.deepEqual(getStudentSubjectOptions({
    studentId: "S-1",
    course: "  English  ",
    lessonPackages: [{ subjectIds: [" English ", "  ", undefined] }],
    bookings: [{ studentId: "S-1", teacherSubjectId: " English ", course: " English " }],
    existingSubject: "English",
  }), ["English"]);
});

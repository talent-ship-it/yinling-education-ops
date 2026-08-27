import assert from "node:assert/strict";
import test from "node:test";

import type {
  OpsStateRow,
  TeacherAvailabilityCompletionPendingTeacherIds,
} from "../lib/ops-store.ts";
import {
  buildTeacherAvailabilityCompletionInbox,
  TeacherAvailabilityCompletionServiceError,
} from "../lib/teacher-availability-completion-service.ts";
import {
  createMonthlyAvailabilityWindows,
  type TeacherAvailabilityWindow,
} from "../lib/teacher-availability.ts";

function teachersRow(payload: unknown[]): OpsStateRow {
  return {
    entity: "teachers",
    payload,
    version: 7,
    updated_at: "2026-08-20T00:00:00.000Z",
    updated_by: "Admin",
  };
}

function teacher(input: {
  id: string;
  name: string;
  availabilityWindows?: unknown;
  availabilitySlots?: unknown;
}) {
  return {
    id: input.id,
    name: input.name,
    ...(input.availabilityWindows !== undefined ? { availabilityWindows: input.availabilityWindows } : {}),
    ...(input.availabilitySlots !== undefined ? { availabilitySlots: input.availabilitySlots } : {}),
  };
}

function pendingTeacherRows(
  teacherIds: readonly string[] = [],
  overflowed = false,
): readonly TeacherAvailabilityCompletionPendingTeacherIds[] {
  return [{ pending_teacher_ids: teacherIds, overflowed }];
}

test("AVA completion counts only current, valid structured windows and makes pending submissions review-only", () => {
  const currentWindows = createMonthlyAvailabilityWindows({
    teacherId: "tea-current",
    month: "2026-08",
    timezone: "Australia/Melbourne",
    slots: [{ day: 1, start: "09:00", end: "12:00" }],
    idSeed: "current",
  });
  const futureWindows = createMonthlyAvailabilityWindows({
    teacherId: "tea-future",
    month: "2026-09",
    timezone: "Australia/Melbourne",
    slots: [{ day: 1, start: "09:00", end: "12:00" }],
    idSeed: "future",
  });
  const incorrectOwnerWindows = createMonthlyAvailabilityWindows({
    teacherId: "tea-someone-else",
    month: "2026-08",
    timezone: "Australia/Melbourne",
    slots: [{ day: 1, start: "09:00", end: "12:00" }],
    idSeed: "incorrect-owner",
  });

  const inbox = buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([
      teacher({ id: "tea-current", name: "有本月 AVA", availabilityWindows: currentWindows }),
      teacher({ id: "tea-future", name: "只有下月 AVA", availabilityWindows: futureWindows }),
      teacher({ id: "tea-legacy", name: "只有旧模板", availabilitySlots: [{ day: 1, start: "09:00", end: "12:00" }] }),
      teacher({ id: "tea-invalid", name: "错误归属 AVA", availabilityWindows: incorrectOwnerWindows }),
    ]),
    pendingTeacherRows: pendingTeacherRows(["tea-future"]),
  });

  assert.deepEqual(inbox.summary, {
    teachers: 4,
    currentStructured: 1,
    missing: 2,
    invalid: 1,
    pendingReview: 1,
  });
  assert.deepEqual(inbox.items, [
    { teacherId: "tea-future", teacherName: "只有下月 AVA", issue: "missing", pendingSubmission: true },
    { teacherId: "tea-invalid", teacherName: "错误归属 AVA", issue: "invalid", pendingSubmission: false },
    { teacherId: "tea-legacy", teacherName: "只有旧模板", issue: "missing", pendingSubmission: false },
  ]);
});

test("AVA completion does not treat raw legacy text or a future window as current availability", () => {
  const inbox = buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([
      {
        id: "tea-text-only",
        name: "原文老师",
        availability: "每周一晚上有空",
        availabilitySourceText: "每周一晚上有空",
        availabilitySlots: [{ day: 1, start: "18:00", end: "20:00" }],
      },
    ]),
    pendingTeacherRows: pendingTeacherRows(),
  });

  assert.equal(inbox.summary.currentStructured, 0);
  assert.deepEqual(inbox.items, [{
    teacherId: "tea-text-only",
    teacherName: "原文老师",
    issue: "missing",
    pendingSubmission: false,
  }]);
});

test("AVA completion uses Melbourne instants rather than each teacher's source-calendar month", () => {
  const perthLateJuly: TeacherAvailabilityWindow = {
    id: "perth-july-31",
    teacherId: "tea-perth",
    day: 5,
    start: "23:30",
    end: "23:59",
    timezone: "Australia/Perth",
    validFrom: "2026-07-31",
    validTo: "2026-07-31",
    excludedDates: [],
    overrides: [],
    source: "manual",
  };
  const buenosAiresLateAugust: TeacherAvailabilityWindow = {
    id: "buenos-august-31",
    teacherId: "tea-buenos-aires",
    day: 1,
    start: "23:30",
    end: "23:59",
    timezone: "America/Argentina/Buenos_Aires",
    validFrom: "2026-08-31",
    validTo: "2026-08-31",
    excludedDates: [],
    overrides: [],
    source: "manual",
  };

  const inbox = buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([
      teacher({ id: "tea-perth", name: "Perth 月末", availabilityWindows: [perthLateJuly] }),
      teacher({ id: "tea-buenos-aires", name: "Buenos Aires 月末", availabilityWindows: [buenosAiresLateAugust] }),
    ]),
    pendingTeacherRows: pendingTeacherRows(),
  });

  assert.equal(inbox.summary.currentStructured, 1);
  assert.deepEqual(inbox.items, [{
    teacherId: "tea-buenos-aires",
    teacherName: "Buenos Aires 月末",
    issue: "missing",
    pendingSubmission: false,
  }]);
});

test("AVA completion treats Melbourne month boundaries as a half-open interval", () => {
  const endingAtMonthStart: TeacherAvailabilityWindow = {
    id: "ends-at-august-start",
    teacherId: "tea-end",
    day: 5,
    start: "13:30",
    end: "14:00",
    timezone: "UTC",
    validFrom: "2026-07-31",
    validTo: "2026-07-31",
    excludedDates: [],
    overrides: [],
    source: "manual",
  };
  const startingAtMonthEnd: TeacherAvailabilityWindow = {
    id: "starts-at-september-start",
    teacherId: "tea-start",
    day: 1,
    start: "14:00",
    end: "14:30",
    timezone: "UTC",
    validFrom: "2026-08-31",
    validTo: "2026-08-31",
    excludedDates: [],
    overrides: [],
    source: "manual",
  };

  const inbox = buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([
      teacher({ id: "tea-end", name: "月初结束", availabilityWindows: [endingAtMonthStart] }),
      teacher({ id: "tea-start", name: "月末开始", availabilityWindows: [startingAtMonthEnd] }),
    ]),
    pendingTeacherRows: pendingTeacherRows(),
  });

  assert.equal(inbox.summary.currentStructured, 0);
  assert.equal(inbox.summary.missing, 2);
});

test("AVA completion fails closed above the roster and pending-reader safety caps", () => {
  const oversizedTeachers = Array.from({ length: 1_001 }, (_, index) =>
    teacher({ id: `tea-${index}`, name: `老师 ${index}` }),
  );
  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow(oversizedTeachers),
    pendingTeacherRows: pendingTeacherRows(),
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "too_many_teachers");

  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([teacher({ id: "tea-1", name: "老师" })]),
    pendingTeacherRows: pendingTeacherRows(["tea-1"], true),
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "too_many_pending_teachers");

  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([teacher({ id: "tea-1", name: "老师" })]),
    pendingTeacherRows: pendingTeacherRows(Array.from({ length: 1_001 }, (_, index) => `tea-${index}`)),
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "too_many_pending_teachers");
});

test("AVA completion fails closed before expanding an oversized historic AVA ledger", () => {
  let inspectedWindow = false;
  const oversizedWindows = Array.from({ length: 1_025 }, () => new Proxy({}, {
    get() {
      inspectedWindow = true;
      throw new Error("the capped AVA ledger must not be expanded");
    },
  }));

  const inbox = buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([
      teacher({ id: "tea-history", name: "历史 AVA 过多", availabilityWindows: oversizedWindows }),
    ]),
    pendingTeacherRows: pendingTeacherRows(),
  });

  assert.equal(inbox.summary.invalid, 1);
  assert.equal(inspectedWindow, false);
});

test("AVA completion fails closed for malformed roster, narrow reader, or orphaned pending teacher", () => {
  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([{ id: "tea-1", name: "重复" }, { id: "tea-1", name: "重复二" }]),
    pendingTeacherRows: pendingTeacherRows(),
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "invalid_teachers_state");

  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([teacher({ id: "tea-1", name: "现有老师" })]),
    pendingTeacherRows: pendingTeacherRows(["tea-orphan"]),
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "invalid_pending_teacher_reader");

  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-08",
    teachersRow: teachersRow([teacher({ id: "tea-1", name: "现有老师" })]),
    pendingTeacherRows: [] as unknown as readonly TeacherAvailabilityCompletionPendingTeacherIds[],
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "invalid_pending_teacher_reader");

  assert.throws(() => buildTeacherAvailabilityCompletionInbox({
    month: "2026-13",
    teachersRow: teachersRow([]),
    pendingTeacherRows: pendingTeacherRows(),
  }), (error: unknown) => error instanceof TeacherAvailabilityCompletionServiceError
    && error.code === "invalid_month");
});

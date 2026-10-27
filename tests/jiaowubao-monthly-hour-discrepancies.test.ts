import assert from "node:assert/strict";
import test from "node:test";
import { projectJiaowubaoCompletedLessonRecord } from "../lib/jiaowubao-completed-lessons";
import { projectJiaowubaoCompletedScheduleRecord } from "../lib/jiaowubao-completed-schedule";
import { projectJiaowubaoCompletedLessonRecords } from "../lib/jiaowubao-completed-lesson-projection";
import { monthlyHourDiscrepancies, type MonthlyHourDiscrepancyScope } from "../lib/jiaowubao-monthly-hour-discrepancies";
import { getMonthlyHourDiscrepancyReport, MonthlyHourDiscrepancyError } from "../lib/jiaowubao-monthly-hour-discrepancies-service";
import type { OpsStateRow, JiaowubaoCompletedLessonSnapshotPage } from "../lib/ops-store";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import { monthlyHourValuesDiffer } from "../lib/jiaowubao-hour-discrepancy-filter";

const period = { start: "2026-09-01", end: "2026-09-30" };
const revision = `sha256:${"a".repeat(64)}`;
const now = new Date("2026-10-26T02:00:00.000Z");
const admin: DemoSessionIdentity = { user: "Ops Admin", role: "limited-admin", permissions: ["operations.read"], scopeMembers: [{ kind: "all", key: "*" }] };
const staff: DemoSessionIdentity = { user: "Ella", role: "staff", permissions: ["students.read.assigned", "bookings.read.assigned"] };
const globalScope: MonthlyHourDiscrepancyScope = { studentIds: new Set(["S1", "S2", "S3"]), includeUnmatched: true };
const staffScope: MonthlyHourDiscrepancyScope = { studentIds: new Set(["S1", "S3"]), includeUnmatched: false };

function lesson(extra: Record<string, unknown> = {}) {
  return projectJiaowubaoCompletedLessonRecord({ branch_id: 1, cal_id: 100, mem_id: 1, mem_title: "Synthetic One", dated: "2026-09-07", time_title: "09:00-10:00", hours: 0, type: 1, sign: 1, course_title: "Synthetic English", teacher_id: 10, teacher_title: "Synthetic Teacher", over: 1, ...extra }, period);
}
function schedule(extra: Record<string, unknown> = {}) {
  return projectJiaowubaoCompletedScheduleRecord({ cal_id: 100, dated: "2026-09-07", time_title: "09:00-10:00", course_title: "Synthetic English", teacher_id: 10, teacher_title: "Synthetic Teacher", teacher_hour: 1, over: 1, ...extra }, period);
}
function rows(): OpsStateRow[] {
  return [["students", [
    { id: "S1", name: "Synthetic One", owner: "Ella", jwbSourceRow: "1", privateNote: "must-stay-private" },
    { id: "S2", name: "Synthetic Two", owner: "Thea", jwbSourceRow: "2" },
    { id: "S3", name: "Synthetic Three", owner: "Ella", jwbSourceRow: "3" },
  ]], ["teachers", [{ id: "T1", name: "Synthetic Teacher", jwbSourceRow: "10", rate: 9999 }, { id: "T2", name: "Synthetic Assistant", jwbSourceRow: "11", rate: 8888 }]], ["bookings", []], ["lpItems", []]].map(([entity, payload]) => ({ entity: entity as string, payload, version: 1, updated_at: "2026-10-01T00:00:00.000Z", updated_by: "fixture" }));
}
function project(records = [lesson()], scheduleRecords = [schedule()], scope = globalScope, stateRows = rows()) {
  return monthlyHourDiscrepancies({ projection: projectJiaowubaoCompletedLessonRecords({ records, scheduleRecords, stateRows }), stateRows, scope });
}

test("teacher hours come from the schedule role while a student's zero remains zero", () => {
  const result = project();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.teacherHours, 1);
  assert.equal(result.rows[0]!.studentHours, 0);
  assert.equal(result.rows[0]!.difference, 1);
  assert.equal(result.rows[0]!.status, "待核查");
  assert.deepEqual(result.rows[0]!.operationsOwners, ["Ella"]);
  assert.equal(JSON.stringify(result).includes("9999"), false);
  assert.equal(JSON.stringify(result).includes("must-stay-private"), false);
});

test("monthly owner reporting follows a unique JWB student id despite a duplicate name-only record", async () => {
  const state = rows();
  (state[0]!.payload as Record<string, unknown>[]).push({ id: "S1-duplicate", name: "Synthetic One(CHN)", owner: "Molly" });
  const result = await getMonthlyHourDiscrepancyReport({ now, session: staff, fullAdmin: false }, dependencies({
    lessons: [lesson({ mem_title: "Synthetic One(CHN)" })], state,
  }));
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0]!.students, [{ id: "S1", name: "Synthetic One" }]);
  assert.deepEqual(result.rows[0]!.operationsOwners, ["Ella"]);
  assert.equal(result.rows[0]!.ownerUnmatched, false);
});

test("equal zero credits do not become a false missing-hours issue", () => {
  assert.deepEqual(project([lesson()], [schedule({ teacher_hour: 0 })]).rows, []);
});

test("null and invalid hours are separate uncheckable candidates, never coerced to zero", () => {
  for (const teacher_hour of [null, "N/A", -1]) {
    const result = project([lesson()], [schedule({ teacher_hour })]);
    assert.equal(result.rows[0]!.difference, null);
    assert.equal(result.rows[0]!.studentHours, 0);
  }
  const missingStudent = project([lesson({ hours: null })]);
  assert.equal(missingStudent.rows[0]!.studentHours, null);
  assert.equal(missingStudent.rows[0]!.teacherHours, 1);
  assert.equal(missingStudent.rows[0]!.difference, null);
});

test("each documented teacher role gets its own hours rather than the primary teacher's credit", () => {
  const teacher_s = { teacher_s: 11, teacher_s_title: "Synthetic Assistant" };
  const result = project([lesson({ hours: 1, ...teacher_s })], [schedule({ teacher_s_hour: 0.5, ...teacher_s })]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.teacherRole, "assistant");
  assert.equal(result.rows[0]!.teacherHours, 0.5);
  assert.equal(result.rows[0]!.difference, -0.5);
});

test("group consumption is summed once per event and remains review-only", () => {
  const members = [lesson({ hours: 1 }), lesson({ mem_id: 3, mem_title: "Synthetic Three", hours: 1 })];
  const result = project(members, [schedule()], staffScope);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.studentHours, 2);
  assert.equal(result.rows[0]!.teacherHours, 1);
  assert.equal(result.rows[0]!.difference, -1);
  assert.equal(result.rows[0]!.students.length, 2);
  assert.equal(result.rows[0]!.status, "待核查");
});

test("mixed-owner groups are hidden from staff rather than leaking other learners or partial totals", () => {
  const members = [lesson({ hours: 1 }), lesson({ mem_id: 2, mem_title: "Synthetic Two", hours: 1 })];
  assert.deepEqual(project(members, [schedule()], staffScope), { rows: [], operationsOwners: [] });
  const all = project(members);
  assert.deepEqual(all.rows[0]!.operationsOwners, ["Ella", "Thea"]);
  assert.equal(all.rows[0]!.studentHours, 2);
});

test("unknown learners and ownerless learners are visible only to unrestricted review", () => {
  const unknown = lesson({ mem_id: 99, mem_title: "Unlinked Child" });
  assert.deepEqual(project([unknown], [schedule()], staffScope).rows, []);
  assert.equal(project([unknown]).rows[0]!.ownerUnmatched, true);
  const state = rows();
  (state[0]!.payload as Record<string, unknown>[])[0]!.owner = "Unknown Owner";
  assert.deepEqual(project([lesson()], [schedule()], staffScope, state).rows, []);
  assert.equal(project([lesson()], [schedule()], globalScope, state).rows[0]!.ownerUnmatched, true);
});

test("existing historical operations owners remain visible without making them newly assignable", async () => {
  for (const owner of ["Tara", "Eileen", "思佳", "Tara 教务"]) {
    const state = rows();
    (state[0]!.payload as Record<string, unknown>[])[0]!.owner = owner;
    const expected = owner === "Tara 教务" ? "Tara" : owner;
    const result = await getMonthlyHourDiscrepancyReport({ now, session: admin, fullAdmin: false, owner: expected }, dependencies({ state }));
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0]!.operationsOwners, [expected]);
    assert.equal(result.rows[0]!.ownerUnmatched, false);
    assert.deepEqual(result.operationsOwners, [expected]);
    const staffResult = await getMonthlyHourDiscrepancyReport({ now, session: staff, fullAdmin: false }, dependencies({ state }));
    assert.deepEqual(staffResult.rows, []);
  }
});

test("multiple branches and conflicting event details cannot borrow schedule teacher hours", () => {
  const result = project([lesson(), lesson({ branch_id: 2 })]);
  assert.ok(result.rows.every((item) => item.difference === null));
  assert.ok(result.rows.filter((item) => item.students.length).every((item) => item.teacherHours === null));
  const conflict = project([lesson()], [schedule({ time_title: "10:00-11:00" })]);
  assert.ok(conflict.rows.every((item) => item.difference === null));
});

test("a unique unknown-branch candidate shows both source hours once without establishing a difference", () => {
  const members = [lesson({ branch_id: undefined, hours: 1 }), lesson({ branch_id: undefined, mem_id: 3, mem_title: "Synthetic Three", hours: 1 })];
  const projection = projectJiaowubaoCompletedLessonRecords({ records: members, scheduleRecords: [schedule()], stateRows: rows() });
  const result = monthlyHourDiscrepancies({ projection, stateRows: rows(), scope: globalScope });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.teacherHours, 1);
  assert.equal(result.rows[0]!.studentHours, 2);
  assert.equal(result.rows[0]!.difference, null);
  assert.equal(result.rows[0]!.sourceMatch, "candidate");
  assert.equal(result.rows[0]!.reason, "分校来源待确认（候选对照）");
  assert.equal(result.rows[0]!.status, "待核查");
  assert.equal(projection.teachers[0]!.sourceHours, null);
  assert.ok(projection.teachers[0]!.unresolvedLessonCount > 0);
  const equal = project([lesson({ branch_id: undefined, hours: 1 })]);
  assert.equal(equal.rows.length, 1);
  assert.equal(equal.rows[0]!.difference, null);
});

test("numeric mismatch filtering includes candidate comparisons and excludes equal or invalid evidence", () => {
  const unequal = project([lesson({ branch_id: undefined, hours: 2 })]).rows[0]!;
  assert.equal(monthlyHourValuesDiffer(unequal), true);
  assert.equal(unequal.difference, null);
  assert.equal(unequal.reason, "分校来源待确认（候选对照）");
  const equal = project([lesson({ branch_id: undefined, hours: 1 })]).rows[0]!;
  assert.equal(monthlyHourValuesDiffer(equal), false);
  for (const row of [
    { ...unequal, teacherHours: null },
    { ...unequal, studentHours: null },
    { ...unequal, teacherHours: -1 },
    { ...unequal, teacherHours: 25 },
    { ...unequal, sourceMatch: "unlinked" as const },
    { ...unequal, teacherHours: 0.1 + 0.2, studentHours: 0.3 },
  ]) assert.equal(monthlyHourValuesDiffer(row), false);
  assert.equal(monthlyHourValuesDiffer(project().rows[0]!), true);
});

test("unknown-branch candidates require complete agreeing event and teacher evidence", () => {
  const incompleteOrConflicting = [
    { time_title: null }, { course_title: null }, { dated: "2026-09-08" },
    { time_title: "10:00-11:00" }, { course_title: "Other Course" },
    { team_title: "Other Class" }, { teacher_id: 11 }, { teacher_title: "Other Teacher" },
  ];
  for (const extra of incompleteOrConflicting) {
    const result = project([lesson({ branch_id: undefined, ...extra })]);
    assert.equal(result.rows.some((row) => row.sourceMatch === "candidate"), false, JSON.stringify(extra));
    assert.ok(result.rows.filter((row) => row.students.length).every((row) => row.teacherHours === null));
    assert.ok(result.rows.every((row) => row.difference === null));
  }
  const noDetails = project([lesson({ branch_id: undefined, time_title: null, course_title: null })], [schedule({ time_title: null, course_title: null })]);
  assert.equal(noDetails.rows.some((row) => row.sourceMatch === "candidate"), false);
});

test("unknown-branch candidates stay separate when a calendar has multiple branches or schedules", () => {
  const unknown = lesson({ branch_id: undefined });
  for (const result of [
    project([unknown, lesson({ mem_id: 3, mem_title: "Synthetic Three" })]),
    project([unknown], [schedule(), schedule({ time_title: "10:00-11:00" })]),
  ]) {
    assert.equal(result.rows.some((row) => row.sourceMatch === "candidate"), false);
    assert.ok(result.rows.filter((row) => row.students.length).every((row) => row.teacherHours === null));
  }
});

test("candidate display preserves staff scope and whole-group owner filtering", () => {
  const members = [lesson({ branch_id: undefined }), lesson({ branch_id: undefined, mem_id: 2, mem_title: "Synthetic Two" })];
  assert.deepEqual(project(members, [schedule()], staffScope), { rows: [], operationsOwners: [] });
  const result = project([members[0]!], [schedule()], staffScope);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.sourceMatch, "candidate");
  assert.deepEqual(result.rows[0]!.operationsOwners, ["Ella"]);
});

test("schedule-only evidence stays uncheckable and is never treated as zero student hours", () => {
  const result = project([], [schedule()]);
  assert.equal(result.rows[0]!.studentHours, null);
  assert.equal(result.rows[0]!.teacherHours, 1);
  assert.equal(result.rows[0]!.difference, null);
  assert.deepEqual(project([], [schedule()], staffScope).rows, []);
});

function sourceReader(records: readonly Readonly<{ sourceKey: string }>[], mutate?: (page: JiaowubaoCompletedLessonSnapshotPage, call: number) => JiaowubaoCompletedLessonSnapshotPage) {
  let calls = 0;
  return async (input: { month: string; pageIndex: number; revision: string | null; actor: "Ops Admin" }): Promise<JiaowubaoCompletedLessonSnapshotPage> => {
    calls += 1;
    const page: JiaowubaoCompletedLessonSnapshotPage = {
      state: "complete", month: input.month, revision, rowCount: records.length,
      pageIndex: input.pageIndex, pageCount: Math.ceil(records.length / 250), publishedAt: "2026-10-01T00:00:00.000Z",
      dataThrough: "2026-09-30", provisional: false,
      items: records.slice(input.pageIndex * 250, input.pageIndex * 250 + 250).map((record) => ({ sourceKey: record.sourceKey, record: record as Readonly<Record<string, unknown>> })),
    };
    return mutate ? mutate(page, calls) : page;
  };
}
function dependencies(input: { lessons?: ReturnType<typeof lesson>[]; schedules?: ReturnType<typeof schedule>[]; session?: DemoSessionIdentity; mutateLesson?: Parameters<typeof sourceReader>[1]; mutateSchedule?: Parameters<typeof sourceReader>[1]; state?: OpsStateRow[] } = {}) {
  return {
    readLessons: sourceReader(input.lessons ?? [lesson()], input.mutateLesson),
    readSchedules: sourceReader(input.schedules ?? [schedule()], input.mutateSchedule),
    readState: async () => input.state ?? rows(),
  };
}
const report = (deps = dependencies(), session = staff) => getMonthlyHourDiscrepancyReport({ now, session, fullAdmin: false }, deps);
const isFailure = (status: number) => (error: unknown) => error instanceof MonthlyHourDiscrepancyError && error.status === status;

test("the service defaults to the previous complete Melbourne month and returns only the actor's students", async () => {
  const result = await report(dependencies({ lessons: [lesson(), lesson({ cal_id: 101, mem_id: 2, mem_title: "Synthetic Two" })], schedules: [schedule(), schedule({ cal_id: 101 })] }));
  assert.equal(result.month, "2026-09");
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.operationsOwners, ["Ella"]);
  assert.equal(JSON.stringify(result).includes("Synthetic Two"), false);
});

test("teacher and missing-permission sessions are denied before any source read", async () => {
  let calls = 0;
  const deps = { ...dependencies(), readLessons: async () => { calls += 1; throw new Error("must not read"); } };
  await assert.rejects(report(deps, { user: "Synthetic Teacher", role: "teacher", permissions: ["*"] }), isFailure(403));
  await assert.rejects(report(deps, { ...staff, permissions: [] }), isFailure(403));
  assert.equal(calls, 0);
});

test("restricted limited-admin scope cannot see unmatched or other-scope learners", async () => {
  const session: DemoSessionIdentity = { ...admin, scopeMembers: [{ kind: "student", key: "S1" }] };
  const result = await report(dependencies({ lessons: [lesson(), lesson({ cal_id: 101, mem_id: 2, mem_title: "Synthetic Two" }), lesson({ cal_id: 102, mem_id: 99, mem_title: "Unknown Child" })], schedules: [schedule(), schedule({ cal_id: 101 }), schedule({ cal_id: 102 })] }), session);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0]!.students.map((item) => item.id), ["S1"]);
});

test("closed-month validation rejects current or future months and honors Melbourne rollover", async () => {
  await assert.rejects(getMonthlyHourDiscrepancyReport({ month: "2026-10", now, session: staff, fullAdmin: false }, dependencies()), isFailure(400));
  const boundary = await getMonthlyHourDiscrepancyReport({ now: new Date("2026-09-30T14:00:00.000Z"), session: staff, fullAdmin: false }, dependencies());
  assert.equal(boundary.month, "2026-09");
});

test("both feeds must be complete, cover the full month, and share one revision", async () => {
  await assert.rejects(report(dependencies({ mutateLesson: (page) => ({ ...page, state: "absent" }) })), isFailure(503));
  await assert.rejects(report(dependencies({ mutateSchedule: (page) => ({ ...page, provisional: true, dataThrough: "2026-09-29" }) })), isFailure(503));
  await assert.rejects(report(dependencies({ mutateSchedule: (page) => ({ ...page, revision: `sha256:${"b".repeat(64)}` }) })), isFailure(409));
});

test("the service reads every bounded page and rejects continuation drift", async () => {
  const lessons = Array.from({ length: 251 }, (_, index) => lesson({ cal_id: index + 1 }));
  const schedules = Array.from({ length: 251 }, (_, index) => schedule({ cal_id: index + 1 }));
  assert.equal((await report(dependencies({ lessons, schedules }))).rows.length, 251);
  await assert.rejects(report(dependencies({ lessons, schedules, mutateLesson: (page) => page.pageIndex === 1 ? { ...page, state: "reset", items: [] } : page })), isFailure(409));
  await assert.rejects(report(dependencies({ lessons, schedules, mutateSchedule: (page) => page.pageIndex === 1 ? { ...page, rowCount: 252 } : page })), isFailure(503));
});

test("duplicate rows, wrapper mismatch and source records outside the period fail closed", async () => {
  await assert.rejects(report(dependencies({ lessons: [lesson(), lesson()] })), isFailure(503));
  await assert.rejects(report(dependencies({ mutateLesson: (page) => ({ ...page, items: page.items.map((item) => ({ ...item, sourceKey: "forged" })) }) })), isFailure(503));
  await assert.rejects(report(dependencies({ mutateLesson: (page) => ({ ...page, items: page.items.map((item) => ({ ...item, record: { ...item.record, lessonDate: "2026-08-31" } })) }) })), isFailure(503));
});

test("a publication or assignment change before the final read invalidates the whole response", async () => {
  await assert.rejects(report(dependencies({ mutateSchedule: (page, call) => call > 1 ? { ...page, publishedAt: "2026-10-02T00:00:00.000Z" } : page })), isFailure(409));
  let calls = 0;
  const deps = { ...dependencies(), readState: async () => { calls += 1; return rows().map((row) => ({ ...row, version: calls })); } };
  await assert.rejects(report(deps), isFailure(409));
});

test("missing teacher slots remain uncheckable rather than silently dropping student evidence", () => {
  const noTeacher = { teacher_id: 0, teacher_title: null };
  const result = project([lesson({ ...noTeacher, hours: 1 })], [schedule({ ...noTeacher, teacher_hour: 0 })]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.teacher, "未匹配老师");
  assert.equal(result.rows[0]!.teacherHours, null);
  assert.equal(result.rows[0]!.studentHours, 1);
  assert.equal(result.rows[0]!.difference, null);
});

test("owner filtering retains complete totals and never widens a staff response", async () => {
  const deps = dependencies({ lessons: [lesson(), lesson({ mem_id: 2, mem_title: "Synthetic Two" })] });
  const hidden = await getMonthlyHourDiscrepancyReport({ now, session: staff, fullAdmin: false, owner: "Thea" }, deps);
  assert.deepEqual(hidden.rows, []);
  assert.deepEqual(hidden.operationsOwners, []);
  const visible = await getMonthlyHourDiscrepancyReport({ now, session: admin, fullAdmin: false, owner: "Ella" }, deps);
  assert.equal(visible.rows.length, 1);
  assert.equal(visible.rows[0]!.students.length, 2);
  const unknown = await getMonthlyHourDiscrepancyReport({ now, session: admin, fullAdmin: false, owner: "unmatched" }, dependencies({ lessons: [lesson({ mem_id: 99, mem_title: "Unlinked Child" })] }));
  assert.equal(unknown.rows[0]!.ownerUnmatched, true);
});

test("a schedule lacking both learner and teacher evidence is retained for unrestricted review", () => {
  const result = project([], [schedule({ teacher_id: 0, teacher_title: null, teacher_hour: 0 })]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.studentHours, null);
  assert.equal(result.rows[0]!.teacherHours, null);
  assert.equal(result.rows[0]!.difference, null);
  assert.equal(result.rows[0]!.ownerUnmatched, true);
});

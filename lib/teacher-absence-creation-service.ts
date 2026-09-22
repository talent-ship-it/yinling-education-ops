import { createHash } from "node:crypto";

import type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction } from "@/lib/ops-access";
import type { OpsStateRow } from "@/lib/ops-store";
import { expandLessonOccurrences, lessonOccurrenceSourceRangeForTargetRange, type LessonOccurrence } from "@/lib/lesson-occurrences";
import { DEFAULT_TEACHING_CONTROL_WATCHER, type OpsTask } from "@/lib/ops-tasks";
import { scheduleOccurrenceInstant, scheduleDateInTimezone, shiftScheduleDate } from "@/lib/schedule-calendar";
import { expandTeacherAvailability, type TeacherAvailabilityWindow } from "@/lib/teacher-availability";

type RecordValue = Record<string, unknown>;
type Entity = "bookings" | "operations" | "students" | "tasks" | "teachers";
const ENTITIES: readonly Entity[] = ["bookings", "operations", "students", "tasks", "teachers"];
const COMMAND_FIELDS = new Set(["commandKey", "sourceTeacherId", "eventStart", "eventEnd", "type", "detail", "expectedVersions"]);
const VERSION_FIELDS = new Set(ENTITIES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMMAND_KEY_PATTERN = /^teacher-absence-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE_STUDENT_STATUSES = new Set(["在读", "活跃 + 有课时", "活跃 + 无课时", "在读 + 加课待排"]);
const TZ = "Australia/Melbourne";

export type TeacherAbsenceType = "老师请假" | "请假" | "代课";
export type TeacherAbsenceCreationCommand = Readonly<{
  commandKey: string;
  sourceTeacherId: string;
  eventStart: string;
  eventEnd: string;
  type: TeacherAbsenceType;
  detail: string;
  expectedVersions: Readonly<Record<Entity, number>>;
}>;
export type TeacherAbsenceCreationGroup = Readonly<{
  studentId: string;
  operationId: string;
  affectedOccurrenceIds: readonly string[];
  subjects: readonly string[];
  firstAffectedAt: string;
  candidateTeacherIds: readonly string[];
}>;
export type PreparedTeacherAbsenceCreation = Readonly<{
  commandKey: string;
  commandIntent: Readonly<Record<string, string>>;
  sourceTeacherId: string;
  eventStart: string;
  eventEnd: string;
  type: TeacherAbsenceType;
  detail: string;
  expectedVersions: TeacherAbsenceCreationCommand["expectedVersions"];
  affectedGroups: readonly TeacherAbsenceCreationGroup[];
  operations: readonly RecordValue[];
  tasks: readonly OpsTask[];
  submittedAt: string;
  operationIds: readonly string[];
  affectedStudentIds: readonly string[];
  affectedOccurrenceCount: number;
  generatedTaskCount: number;
}>;

export type TeacherAbsenceCreationErrorCode =
  | "invalid_request" | "client_fields_forbidden" | "teacher_forbidden" | "invalid_shared_state"
  | "stale_expected_version" | "source_teacher_not_found" | "source_teacher_scope_forbidden"
  | "affected_student_not_found" | "affected_student_scope_forbidden" | "archived_student_read_only"
  | "affected_occurrence_not_found" | "teacher_subject_missing" | "absence_already_exists";

export class TeacherAbsenceCreationError extends Error {
  constructor(readonly code: TeacherAbsenceCreationErrorCode, message: string) { super(message); this.name = "TeacherAbsenceCreationError"; }
}
function fail(code: TeacherAbsenceCreationErrorCode, message: string): never { throw new TeacherAbsenceCreationError(code, message); }
function isRecord(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: RecordValue, field: string) { return typeof value[field] === "string" && value[field].trim() ? value[field].trim() : undefined; }
function requiredText(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail("invalid_request", `${field} is invalid.`);
  return value.trim();
}
function date(value: unknown, field: string) {
  const result = requiredText(value, field, 10);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(result) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) fail("invalid_request", `${field} must be a valid YYYY-MM-DD date.`);
  return result;
}
function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid_request", `${field} must be a positive state version.`);
  return value as number;
}
function stableId(prefix: "OPS-ABSENCE" | "TSK-ABSENCE", seed: string) { return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`; }
function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

export function parseTeacherAbsenceCreationCommand(value: unknown): TeacherAbsenceCreationCommand {
  if (!isRecord(value)) fail("invalid_request", "Teacher-absence command is missing.");
  if (Object.keys(value).some((field) => !COMMAND_FIELDS.has(field))) fail("client_fields_forbidden", "Only the reviewed teacher-absence command fields may be submitted.");
  const commandKey = requiredText(value.commandKey, "commandKey", 100);
  if (!COMMAND_KEY_PATTERN.test(commandKey)) fail("invalid_request", "commandKey is invalid.");
  const sourceTeacherId = requiredText(value.sourceTeacherId, "sourceTeacherId", 120);
  if (!ID_PATTERN.test(sourceTeacherId)) fail("invalid_request", "sourceTeacherId is invalid.");
  const eventStart = date(value.eventStart, "eventStart");
  const eventEnd = date(value.eventEnd, "eventEnd");
  if (eventStart > eventEnd) fail("invalid_request", "eventStart must not be after eventEnd.");
  const type = requiredText(value.type, "type", 20) as TeacherAbsenceType;
  if (!["老师请假", "请假", "代课"].includes(type)) fail("invalid_request", "type is invalid.");
  const detail = requiredText(value.detail, "detail", 2_000);
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  if (Object.keys(value.expectedVersions).some((field) => !VERSION_FIELDS.has(field as Entity))) fail("client_fields_forbidden", "expectedVersions contains an unsupported entity.");
  return { commandKey, sourceTeacherId, eventStart, eventEnd, type, detail, expectedVersions: {
    bookings: version(value.expectedVersions.bookings, "expectedVersions.bookings"),
    operations: version(value.expectedVersions.operations, "expectedVersions.operations"),
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
    teachers: version(value.expectedVersions.teachers, "expectedVersions.teachers"),
  } };
}

export function teacherAbsenceCreationIntent(command: Pick<TeacherAbsenceCreationCommand, "sourceTeacherId" | "eventStart" | "eventEnd" | "type" | "detail">) {
  return { sourceTeacherId: command.sourceTeacherId, eventStart: command.eventStart, eventEnd: command.eventEnd, type: command.type, detail: command.detail };
}

function payloadRow(rows: readonly OpsStateRow[], entity: Entity) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || !Array.isArray(row.payload) || !row.payload.every(isRecord)) fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  const ids = row.payload.map((item) => typeof item.id === "string" ? item.id.trim() : "");
  if (ids.some((id) => !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) fail("invalid_shared_state", `${entity} shared state contains duplicate or invalid ids.`);
  return { ...row, payload: row.payload as RecordValue[] };
}

function expandWithin(booking: RecordValue, eventStart: string, eventEnd: string): LessonOccurrence[] {
  try {
    if (booking.recurring === true && booking.repeatCount !== undefined && (!Number.isSafeInteger(booking.repeatCount) || Number(booking.repeatCount) < 1 || Number(booking.repeatCount) > 104)) {
      fail("invalid_shared_state", "A recurring booking repeatCount must be from 1 to 104.");
    }
    const overrides = Array.isArray(booking.occurrenceOverrides) ? booking.occurrenceOverrides : [];
    const range = lessonOccurrenceSourceRangeForTargetRange(eventStart, eventEnd, overrides as never);
    return expandLessonOccurrences(booking as never, { ...range, overrides: overrides as never }).filter((occurrence) => occurrence.date >= eventStart && occurrence.date <= eventEnd && occurrence.status !== "cancelled" && occurrence.status !== "leave");
  } catch { fail("invalid_shared_state", "A booking cannot be safely expanded for teacher absence checks."); }
}
function occurrenceInstant(occurrence: LessonOccurrence, booking: RecordValue) {
  const timezone = text(booking, "timezone");
  if (!timezone) fail("invalid_shared_state", "An affected booking is missing its timezone.");
  try { return scheduleOccurrenceInstant({ date: occurrence.date, start: occurrence.start, timezone }); } catch { fail("invalid_shared_state", "An affected occurrence has an invalid time."); }
}
function dueState(dueDate: string, submittedAt: Date, tone: OpsTask["tone"]) {
  const dueAt = scheduleOccurrenceInstant({ date: dueDate, start: "18:00", timezone: TZ });
  const today = scheduleDateInTimezone(submittedAt, TZ);
  const status: OpsTask["status"] = dueDate < today ? "overdue" : dueDate === today ? "today" : "upcoming";
  return { due: `${dueDate} 18:00`, dueAt: dueAt.toISOString(), status, tone: status === "overdue" ? "red" as const : status === "today" ? "amber" as const : tone };
}
function makeTask(input: { commandKey: string; operationId: string; studentId: string; rule: string; title: string; owner: string; dueDate: string; tone: OpsTask["tone"]; trigger: string; submittedAt: Date }): OpsTask {
  return { id: stableId("TSK-ABSENCE", `${input.commandKey}\u001f${input.studentId}\u001f${input.rule}`), title: input.title, owner: input.owner, assignees: [input.owner], watchers: [DEFAULT_TEACHING_CONTROL_WATCHER], studentId: input.studentId, ...dueState(input.dueDate, input.submittedAt, input.tone), category: "请假代课", trigger: input.trigger, ruleKey: `teacher-absence:${input.operationId}:${input.rule}`, anchorBookingId: input.operationId };
}
function historicalLastLessonDate(bookings: readonly RecordValue[], teacherId: string, studentId: string, beforeDate: string) {
  const historical: { occurrence: LessonOccurrence; booking: RecordValue }[] = [];
  for (const booking of bookings) {
    const occurrences = expandWithin(booking, shiftScheduleDate(beforeDate, -730), shiftScheduleDate(beforeDate, -1));
    historical.push(...occurrences.filter((occurrence) => occurrence.date < beforeDate && occurrence.teacherId === teacherId && occurrence.studentId === studentId && occurrence.status !== "cancelled" && occurrence.status !== "leave").map((occurrence) => ({ occurrence, booking })));
  }
  historical.sort((left, right) => left.occurrence.date.localeCompare(right.occurrence.date) || left.occurrence.start.localeCompare(right.occurrence.start) || compare(left.occurrence.occurrenceId, right.occurrence.occurrenceId));
  const last = historical.at(-1);
  if (!last) return undefined;
  const end = new Date(occurrenceInstant(last.occurrence, last.booking).getTime() + last.occurrence.scheduledDurationMinutes * 60_000);
  return shiftScheduleDate(scheduleDateInTimezone(end, TZ), 1);
}

function affectedInstantRanges(affected: readonly { booking: RecordValue; occurrence: LessonOccurrence }[]) {
  return affected.map((item) => {
    const start = occurrenceInstant(item.occurrence, item.booking).getTime();
    const end = start + item.occurrence.scheduledDurationMinutes * 60_000;
    if (!Number.isFinite(end) || end <= start) fail("invalid_shared_state", "An affected occurrence has an invalid duration.");
    return { start, end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
}

function localExpansionRange(ranges: readonly { start: number; end: number }[], timezones: readonly string[]) {
  const dates = timezones.flatMap((timezone) => ranges.flatMap((range) => [
    scheduleDateInTimezone(new Date(range.start), timezone),
    scheduleDateInTimezone(new Date(range.end), timezone),
  ]));
  if (!dates.length) fail("invalid_shared_state", "A candidate has no usable scheduling timezone.");
  dates.sort(compare);
  return { from: shiftScheduleDate(dates[0], -1), to: shiftScheduleDate(dates.at(-1)!, 1) };
}

function candidateTeacherIds(teachers: readonly RecordValue[], bookings: readonly RecordValue[], sourceTeacherId: string, studentId: string, affected: readonly { booking: RecordValue; occurrence: LessonOccurrence; subject: string }[]) {
  return teachers.filter((teacher) => {
    const id = text(teacher, "id");
    if (!id || id === sourceTeacherId || !Array.isArray(teacher.subjects) || !Array.isArray(teacher.availabilityWindows)) return false;
    if (!teacher.availabilityWindows.length || teacher.availabilityWindows.some((item) => !isRecord(item) || item.teacherId !== id)) return false;
    const assignments = Array.isArray(teacher.capacityAssignments) ? teacher.capacityAssignments.filter((item): item is string => typeof item === "string") : [];
    const alreadyAssigned = assignments.includes(studentId);
    const subjects = teacher.subjects.filter((item): item is string => typeof item === "string");
    if (!affected.every((item) => subjects.includes(item.subject))) return false;
    try {
      const requested = affectedInstantRanges(affected);
      const existingRelationship = bookings.some((booking) => {
        // A temporary cover is a real scheduling conflict below, but it does
        // not establish the permanent teacher/student capacity relationship.
        if (booking.kind === "代课") return false;
        const timezone = text(booking, "timezone");
        if (!timezone) fail("invalid_shared_state", "A booking is missing its scheduling timezone.");
        const range = localExpansionRange(requested, [timezone]);
        return expandWithin(booking, range.from, range.to).some((occurrence) => occurrence.teacherId === id && occurrence.studentId === studentId);
      });
      if (!existingRelationship && !alreadyAssigned && (teacher.acceptsStudents !== true || !Number.isSafeInteger(teacher.newStudentCapacity) || Number(teacher.newStudentCapacity) <= 0)) return false;
      const availabilityTimezones = (teacher.availabilityWindows as RecordValue[]).map((window) => text(window, "timezone") ?? "");
      if (availabilityTimezones.some((timezone) => !timezone)) return false;
      const availabilityRange = localExpansionRange(requested, availabilityTimezones);
      const windows = expandTeacherAvailability(teacher.availabilityWindows as TeacherAvailabilityWindow[], { ...availabilityRange, displayTimezone: "UTC" });
      return requested.every(({ start, end }) => {
        return windows.some((window) => window.teacherId === id && Date.parse(window.startsAt) <= start && Date.parse(window.endsAt) >= end);
      }) && !bookings.some((booking) => {
        const timezone = text(booking, "timezone");
        if (!timezone) fail("invalid_shared_state", "A booking is missing its scheduling timezone.");
        const range = localExpansionRange(requested, [timezone]);
        return expandWithin(booking, range.from, range.to).some((occurrence) => occurrence.teacherId === id && occurrence.status !== "cancelled" && occurrence.status !== "leave" && requested.some(({ start: requestedStart, end: requestedEnd }) => {
          const existingStart = occurrenceInstant(occurrence, booking).getTime();
          const existingEnd = existingStart + occurrence.scheduledDurationMinutes * 60_000;
          return requestedStart < existingEnd && existingStart < requestedEnd;
        }));
      });
    } catch { return false; }
  }).map((teacher) => text(teacher, "id")!).sort(compare);
}

export function prepareTeacherAbsenceCreation(input: Readonly<{ command: TeacherAbsenceCreationCommand; rows: readonly OpsStateRow[]; actor: string; role: DemoSessionRole; authorization?: DemoSessionIdentity; fullAdmin: boolean; now?: Date }>): PreparedTeacherAbsenceCreation {
  if (input.role === "teacher") fail("teacher_forbidden", "Teacher accounts cannot create teacher-absence workflows.");
  const bookingRow = payloadRow(input.rows, "bookings");
  const operationRow = payloadRow(input.rows, "operations");
  const studentRow = payloadRow(input.rows, "students");
  const taskRow = payloadRow(input.rows, "tasks");
  const teacherRow = payloadRow(input.rows, "teachers");
  for (const entity of ENTITIES) if (payloadRow(input.rows, entity).version !== input.command.expectedVersions[entity]) fail("stale_expected_version", `${entity} changed after the teacher-absence form was opened.`);
  const access = buildOpsAccessContext(input.rows as OpsStateRow[], input.actor, input.fullAdmin, input.authorization ?? input.role);
  if (!canWriteOpsTransaction(access, "operations", ["operations", "tasks"])
      || (!access.staff && !access.fullAdmin && !access.limitedAdmin)) {
    fail("source_teacher_scope_forbidden", "The current account cannot create teacher-absence workflows.");
  }
  const teachers = teacherRow.payload.filter((teacher) => teacher.id === input.command.sourceTeacherId);
  if (teachers.length !== 1) fail("source_teacher_not_found", "The affected teacher was not found.");
  if (operationRow.payload.some((operation) => ["老师请假", "请假", "代课"].includes(String(operation.type)) && !["已取消", "closed", "done"].includes(String(operation.status)) && operation.teacherId === input.command.sourceTeacherId && operation.eventStart === input.command.eventStart && operation.eventEnd === input.command.eventEnd)) fail("absence_already_exists", "This teacher absence workflow already exists for the selected date range.");
  const affected: { booking: RecordValue; occurrence: LessonOccurrence; subject: string }[] = [];
  for (const booking of bookingRow.payload) {
    for (const occurrence of expandWithin(booking, input.command.eventStart, input.command.eventEnd)) {
      const studentId = typeof occurrence.studentId === "string" ? occurrence.studentId : "";
      if (occurrence.teacherId !== input.command.sourceTeacherId) continue;
      const subject = text(booking, "teacherSubjectId");
      if (!studentId || !ID_PATTERN.test(studentId)) fail("invalid_shared_state", "An affected occurrence has no valid student identity.");
      if (!subject) fail("teacher_subject_missing", "受影响课程缺少老师腾讯表科目分类，请先编辑课程系列并补充分类。");
      affected.push({ booking, occurrence, subject });
    }
  }
  if (!affected.length) fail("affected_occurrence_not_found", "在所选日期范围内未找到仍由该老师教授的课程，未创建任务。");
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.valueOf())) fail("invalid_request", "The submission clock is invalid.");
  const submittedAt = now.toISOString();
  const byStudent = new Map<string, typeof affected>();
  for (const entry of affected) { const studentId = typeof entry.occurrence.studentId === "string" ? entry.occurrence.studentId : ""; const list = byStudent.get(studentId) ?? []; list.push(entry); byStudent.set(studentId, list); }
  const groups: TeacherAbsenceCreationGroup[] = [];
  const operations: RecordValue[] = [];
  const tasks: OpsTask[] = [];
  for (const [studentId, entries] of [...byStudent.entries()].sort(([left], [right]) => compare(left, right))) {
    const student = studentRow.payload.find((item) => item.id === studentId);
    if (!student) fail("affected_student_not_found", "An affected student was not found.");
    if (student.importArchived === true || !ACTIVE_STUDENT_STATUSES.has(text(student, "status") ?? "")) fail("archived_student_read_only", "Archived or inactive student records cannot receive an absence workflow.");
    if (!canOperateStudent(access, studentId)) fail("affected_student_scope_forbidden", "The current account cannot create a workflow for every affected student.");
    const operationId = stableId("OPS-ABSENCE", `${input.command.commandKey}\u001f${studentId}`);
    const occurrenceIds = entries.map((entry) => entry.occurrence.occurrenceId).sort(compare);
    const first = [...entries].sort((left, right) => occurrenceInstant(left.occurrence, left.booking).getTime() - occurrenceInstant(right.occurrence, right.booking).getTime() || compare(left.occurrence.occurrenceId, right.occurrence.occurrenceId))[0];
    const firstAffectedAt = occurrenceInstant(first.occurrence, first.booking).toISOString();
    const subjects = [...new Set(entries.map((entry) => entry.subject))].sort(compare);
    const candidates = candidateTeacherIds(teacherRow.payload, bookingRow.payload, input.command.sourceTeacherId, studentId, entries);
    groups.push({ studentId, operationId, affectedOccurrenceIds: occurrenceIds, subjects, firstAffectedAt, candidateTeacherIds: candidates });
    operations.push({ id: operationId, studentId, type: input.command.type, detail: input.command.detail, status: "待处理", createdAt: submittedAt, teacherId: input.command.sourceTeacherId, eventStart: input.command.eventStart, eventEnd: input.command.eventEnd, firstAffectedAt, affectedLessonCount: occurrenceIds.length, affectedOccurrenceIds: occurrenceIds, subjectIds: subjects, recommendedTeacherIds: candidates, creationCommandKey: input.command.commandKey });
    const owner = text(student, "owner") ?? "待分配";
    tasks.push(makeTask({ commandKey: input.command.commandKey, operationId, studentId, rule: "candidate", title: "选择可代课老师", owner: "Tiffany", dueDate: shiftScheduleDate(input.command.eventStart, -14), tone: "red", trigger: "老师请假：候选代课老师筛选", submittedAt: now }));
    tasks.push(makeTask({ commandKey: input.command.commandKey, operationId, studentId, rule: "candidate-confirm", title: "确认最终推荐老师并交龙老师确认", owner: DEFAULT_TEACHING_CONTROL_WATCHER, dueDate: shiftScheduleDate(input.command.eventStart, -14), tone: "amber", trigger: "老师请假：最终推荐确认", submittedAt: now }));
    tasks.push(makeTask({ commandKey: input.command.commandKey, operationId, studentId, rule: "parent-contact", title: "完成家长沟通并记录请假/代课原因", owner, dueDate: shiftScheduleDate(input.command.eventStart, -14), tone: "red", trigger: "老师请假：教务必须写明原因", submittedAt: now }));
    const lastLessonDate = historicalLastLessonDate(bookingRow.payload, input.command.sourceTeacherId, studentId, input.command.eventStart);
    if (lastLessonDate) tasks.push(makeTask({ commandKey: input.command.commandKey, operationId, studentId, rule: "lp-handover", title: "请原老师补充代课 LP 指定内容与资料", owner, dueDate: lastLessonDate, tone: "blue", trigger: "老师请假：代课 LP 交接", submittedAt: now }));
    tasks.push(makeTask({ commandKey: input.command.commandKey, operationId, studentId, rule: "cover-prep", title: "确认代课老师已完成备课", owner, dueDate: shiftScheduleDate(input.command.eventStart, -7), tone: "amber", trigger: "老师请假：代课老师一周备课", submittedAt: now }));
  }
  return { commandKey: input.command.commandKey, commandIntent: { sourceTeacherId: input.command.sourceTeacherId, eventStart: input.command.eventStart, eventEnd: input.command.eventEnd, type: input.command.type, detail: input.command.detail }, sourceTeacherId: input.command.sourceTeacherId, eventStart: input.command.eventStart, eventEnd: input.command.eventEnd, type: input.command.type, detail: input.command.detail, expectedVersions: input.command.expectedVersions, affectedGroups: groups, operations: [...operations, ...operationRow.payload], tasks: [...tasks, ...(taskRow.payload as unknown as OpsTask[])], submittedAt, operationIds: groups.map((group) => group.operationId), affectedStudentIds: groups.map((group) => group.studentId), affectedOccurrenceCount: affected.length, generatedTaskCount: tasks.length };
}

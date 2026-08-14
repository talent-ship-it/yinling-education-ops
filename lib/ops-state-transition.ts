import { meetingIdForOccurrenceValue } from "./bbb-analytics";
import type { OpsAccessContext } from "./ops-access";
import type { OpsStateRow } from "./ops-store";
import {
  expandLessonOccurrences,
  type LegacyLessonSeries,
  type LessonOccurrence,
  type LessonOccurrenceOverride,
} from "./lesson-occurrences";
import {
  expandTeacherAvailability,
  type TeacherAvailabilityWindow,
} from "./teacher-availability";

type RecordValue = Record<string, unknown>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const BOOKING_PARENT_STATUSES = new Set(["待确认", "已确认"]);
const EDITABLE_OCCURRENCE_FIELDS = new Set([
  "occurrenceId",
  "status",
  "date",
  "start",
  "durationMinutes",
  "teacherId",
  "classroom",
]);
const OCCURRENCE_SCHEDULE_FIELDS = new Set([
  "status",
  "date",
  "start",
  "durationMinutes",
  "teacherId",
]);
const SETTLEMENT_FIELDS = new Set([
  "settledAt",
  "settledBy",
  "attendanceReference",
  "attendanceReasons",
  "settlementOverrideReason",
  "studentId",
  "packageId",
  "subjectId",
]);
const OPERATION_CONFIRMATION_FIELDS = new Set([
  "affectedOccurrenceIds",
  "confirmationAction",
  "confirmationCommandKey",
  "confirmedAt",
  "confirmedBy",
]);
const OPERATION_TYPES = new Set([
  "调课",
  "请假",
  "学生请假",
  "老师请假",
  "停课",
  "代课",
  "换老师",
  "老师离职",
]);
const ARCHIVED_STUDENT_REFERENCE_ENTITIES = new Set([
  "tasks",
  "lpItems",
  "operations",
  "renewals",
  "messages",
  "files",
  "bookings",
  "payroll",
]);
const ATOMIC_ATTACHMENT_FILE_ID = /^(?:FU|REPORT)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATOMIC_ATTACHMENT_SOURCE = /^\/api\/fu-attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OpsStateTransitionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 = 403,
  ) {
    super(message);
    this.name = "OpsStateTransitionError";
  }
}

function invalid(message: string): never {
  throw new OpsStateTransitionError(message, 400);
}

function forbidden(message: string): never {
  throw new OpsStateTransitionError(message, 403);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function same(left: unknown, right: unknown) {
  return canonical(left) === canonical(right);
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) invalid(`${label} 格式不正确。`);
  return value.trim();
}

function records(value: unknown, label: string): RecordValue[] {
  if (!Array.isArray(value) || !value.every(isRecord)) invalid(`${label} 资料格式不正确。`);
  const result = value as RecordValue[];
  const ids = result.map((item) => requiredText(item.id, `${label}.id`));
  if (new Set(ids).size !== ids.length) invalid(`${label} 含有重复 ID。`);
  return result;
}

function rowsFor(rows: readonly OpsStateRow[], entity: string) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row) invalid(`${entity} 共享资料不存在。`);
  return records(row.payload, entity);
}

function byId(items: readonly RecordValue[]) {
  return new Map(items.map((item) => [requiredText(item.id, "record.id"), item]));
}

function omit(value: RecordValue, fields: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.has(key)));
}

function changedFields(left: RecordValue | undefined, right: RecordValue | undefined) {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  return [...keys].filter((key) => !same(left?.[key], right?.[key]));
}

function studentId(value: RecordValue | undefined) {
  return typeof value?.studentId === "string" ? value.studentId.trim() : "";
}

function archivedStudentIds(rows: readonly OpsStateRow[]) {
  return new Set(rowsFor(rows, "students")
    .filter((student) => student.importArchived === true)
    .map((student) => requiredText(student.id, "student.id")));
}

function assertArchivedStudentReferencesReadOnly(input: {
  entity: string;
  currentPayload: unknown;
  nextPayload: unknown;
  rows: readonly OpsStateRow[];
}) {
  if (!ARCHIVED_STUDENT_REFERENCE_ENTITIES.has(input.entity)) return;
  const archivedIds = archivedStudentIds(input.rows);
  if (!archivedIds.size) return;
  const current = byId(records(input.currentPayload, input.entity));
  const next = byId(records(input.nextPayload, input.entity));
  const ids = new Set([...current.keys(), ...next.keys()]);
  for (const id of ids) {
    const before = current.get(id);
    const after = next.get(id);
    if (same(before, after)) continue;
    if (archivedIds.has(studentId(before)) || archivedIds.has(studentId(after))) {
      forbidden("已归档学生的历史业务资料只能查看，不能新增、修改或删除。");
    }
  }
}

function isAtomicAttachmentFile(value: RecordValue | undefined) {
  return Boolean(value && (
    (typeof value.id === "string" && ATOMIC_ATTACHMENT_FILE_ID.test(value.id))
    || (typeof value.source === "string" && ATOMIC_ATTACHMENT_SOURCE.test(value.source))
  ));
}

function assertAtomicAttachmentFilesReadOnly(currentPayload: unknown, nextPayload: unknown) {
  const current = byId(records(currentPayload, "files"));
  const next = byId(records(nextPayload, "files"));
  for (const id of new Set([...current.keys(), ...next.keys()])) {
    const before = current.get(id);
    const after = next.get(id);
    if (same(before, after)) continue;
    if (isAtomicAttachmentFile(before) || isAtomicAttachmentFile(after)) {
      forbidden("FU 与 Report 附件索引只能由原子上传流程更新。");
    }
  }
}

function addDays(value: string, days: number) {
  if (!DATE_PATTERN.test(value)) invalid("课次日期格式不正确。");
  const result = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(result.valueOf()) || result.toISOString().slice(0, 10) !== value) {
    invalid("课次日期不是有效日期。");
  }
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function bookingSeries(value: RecordValue): LegacyLessonSeries {
  const duration = value.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    invalid("排课时长格式不正确。");
  }
  return {
    id: requiredText(value.id, "booking.id"),
    date: requiredText(value.date, "booking.date"),
    start: requiredText(value.start, "booking.start"),
    duration,
    recurring: value.recurring === true,
    ...(typeof value.repeatCount === "number" ? { repeatCount: value.repeatCount } : {}),
    studentId: requiredText(value.studentId, "booking.studentId"),
    teacherId: requiredText(value.teacherId, "booking.teacherId"),
    ...(typeof value.packageId === "string" && value.packageId.trim() ? { packageId: value.packageId.trim() } : {}),
    ...(typeof value.course === "string" && value.course.trim() ? { course: value.course.trim() } : {}),
  };
}

function bookingOverrides(value: RecordValue): LessonOccurrenceOverride[] {
  const raw = value.occurrenceOverrides;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every(isRecord)) invalid("单节课程资料格式不正确。");
  const overrides = raw as LessonOccurrenceOverride[];
  const ids = overrides.map((item) => requiredText(item.occurrenceId, "occurrenceId"));
  if (new Set(ids).size !== ids.length) invalid("单节课程资料含有重复课次 ID。");
  return overrides;
}

function expandBooking(value: RecordValue, rangeStart: string, rangeEnd: string) {
  try {
    return expandLessonOccurrences(bookingSeries(value), {
      rangeStart,
      rangeEnd,
      overrides: bookingOverrides(value),
    });
  } catch (error) {
    invalid(error instanceof Error ? `排课资料无效：${error.message}` : "排课资料无效。");
  }
}

function sourceDateForOccurrence(occurrenceId: string, seriesId: string) {
  const prefix = `${seriesId}:`;
  if (!occurrenceId.startsWith(prefix)) forbidden("课次 ID 与课程系列不一致。");
  const sourceDate = occurrenceId.slice(prefix.length);
  if (!DATE_PATTERN.test(sourceDate)) forbidden("课次 ID 格式不正确。");
  addDays(sourceDate, 0);
  return sourceDate;
}

function zonedParts(instant: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    invalid("排课时区格式不正确。");
  }
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function offsetMs(instant: Date, timezone: string) {
  const parts = zonedParts(instant, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
}

function occurrenceInstant(occurrence: LessonOccurrence, booking: RecordValue) {
  const timezone = requiredText(booking.timezone, "booking.timezone");
  if (!DATE_PATTERN.test(occurrence.date) || !TIME_PATTERN.test(occurrence.start)) {
    invalid("课次日期或时间格式不正确。");
  }
  const [year, month, day] = occurrence.date.split("-").map(Number);
  const [hour, minute] = occurrence.start.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock - offsetMs(new Date(wallClock), timezone));
  const instant = new Date(wallClock - offsetMs(first, timezone));
  const roundTrip = zonedParts(instant, timezone);
  if (
    roundTrip.year !== year
    || roundTrip.month !== month
    || roundTrip.day !== day
    || roundTrip.hour !== hour
    || roundTrip.minute !== minute
  ) {
    invalid("所选时间在该时区不存在。");
  }
  return instant;
}

function occurrencesNear(booking: RecordValue, date: string) {
  const rangeStart = addDays(date, -8);
  const rangeEnd = addDays(date, 8);
  const occurrences = expandBooking(booking, rangeStart, rangeEnd);
  const included = new Set(occurrences.map((item) => item.occurrenceId));
  for (const override of bookingOverrides(booking)) {
    if (!override.date || override.date < addDays(date, -1) || override.date > addDays(date, 1)) continue;
    const sourceDate = sourceDateForOccurrence(override.occurrenceId, requiredText(booking.id, "booking.id"));
    for (const occurrence of expandBooking(booking, sourceDate, sourceDate)) {
      if (!included.has(occurrence.occurrenceId)) {
        included.add(occurrence.occurrenceId);
        occurrences.push(occurrence);
      }
    }
  }
  return occurrences;
}

function assertClassroom(value: unknown, occurrenceId: string) {
  if (!isRecord(value)) invalid("在线教室资料格式不正确。");
  const allowed = new Set(["occurrenceId", "meetingId", "status", "createdAt"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) forbidden("在线教室包含不能由通用保存修改的字段。");
  if (value.occurrenceId !== occurrenceId) forbidden("在线教室课次 ID 不一致。");
  if (value.meetingId !== meetingIdForOccurrenceValue(occurrenceId)) forbidden("在线教室会议 ID 不正确。");
  if (!["ready", "running", "ended"].includes(String(value.status))) invalid("在线教室状态不正确。");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) invalid("在线教室创建时间不正确。");
}

function assertTeacherAvailability(
  occurrence: LessonOccurrence,
  booking: RecordValue,
  teacher: RecordValue,
) {
  if (!Array.isArray(teacher.availabilityWindows)) forbidden("所选老师没有已确认的月度 AVA。");
  const start = occurrenceInstant(occurrence, booking);
  const end = new Date(start.getTime() + occurrence.scheduledDurationMinutes * 60_000);
  let availability;
  try {
    availability = expandTeacherAvailability(teacher.availabilityWindows as TeacherAvailabilityWindow[], {
      from: addDays(start.toISOString().slice(0, 10), -1),
      to: addDays(start.toISOString().slice(0, 10), 1),
      displayTimezone: "UTC",
    });
  } catch {
    forbidden("所选老师的月度 AVA 资料无效。");
  }
  if (!availability.some((window) =>
    window.teacherId === occurrence.teacherId
    && Date.parse(window.startsAt) <= start.getTime()
    && Date.parse(window.endsAt) >= end.getTime())) {
    forbidden("所选课次不在老师已确认的月度 AVA 内。");
  }
}

function assertNoOccurrenceConflict(
  occurrence: LessonOccurrence,
  booking: RecordValue,
  bookings: readonly RecordValue[],
) {
  const start = occurrenceInstant(occurrence, booking);
  const end = new Date(start.getTime() + occurrence.scheduledDurationMinutes * 60_000);
  for (const candidateBooking of bookings) {
    for (const candidate of occurrencesNear(candidateBooking, occurrence.date)) {
      if (candidate.occurrenceId === occurrence.occurrenceId) continue;
      if (["cancelled", "leave"].includes(candidate.status)) continue;
      if (candidate.studentId !== occurrence.studentId && candidate.teacherId !== occurrence.teacherId) continue;
      const candidateStart = occurrenceInstant(candidate, candidateBooking);
      const candidateEnd = new Date(candidateStart.getTime() + candidate.scheduledDurationMinutes * 60_000);
      if (start < candidateEnd && candidateStart < end) {
        forbidden("所选课次与学生或老师的现有课程冲突。");
      }
    }
  }
}

function assertOccurrenceEdit(input: {
  currentBooking: RecordValue;
  nextBooking: RecordValue;
  currentOverride?: RecordValue;
  nextOverride?: RecordValue;
  bookings: readonly RecordValue[];
  teachers: readonly RecordValue[];
  context: OpsAccessContext;
}) {
  const occurrenceId = requiredText(input.nextOverride?.occurrenceId ?? input.currentOverride?.occurrenceId, "occurrenceId");
  const changed = changedFields(input.currentOverride, input.nextOverride);
  if (changed.some((field) => !EDITABLE_OCCURRENCE_FIELDS.has(field))) {
    forbidden("单节课程只能修改时间、老师、取消状态或在线教室资料。");
  }
  if (changed.some((field) => SETTLEMENT_FIELDS.has(field))) {
    forbidden("课次结算资料只能由专用结算流程修改。");
  }
  const currentStatus = input.currentOverride?.status;
  const nextStatus = input.nextOverride?.status;
  if ([currentStatus, nextStatus].some((status) => ["completed", "abnormal", "leave"].includes(String(status)))) {
    forbidden("完成、异常和请假课次只能由专用流程修改。");
  }
  if (input.currentBooking.status === "已完成" || input.nextBooking.status === "已完成") {
    forbidden("已完成课程系列不能通过通用保存修改课次。");
  }

  const seriesId = requiredText(input.nextBooking.id, "booking.id");
  const sourceDate = sourceDateForOccurrence(occurrenceId, seriesId);
  const currentOccurrence = expandBooking(input.currentBooking, sourceDate, sourceDate)
    .find((item) => item.occurrenceId === occurrenceId);
  if (!currentOccurrence) forbidden("只能修改课程系列中真实存在的具体课次。");
  const nextOccurrence = expandBooking(input.nextBooking, sourceDate, sourceDate)
    .find((item) => item.occurrenceId === occurrenceId);
  if (!nextOccurrence) forbidden("修改后的具体课次不存在。");
  if (!["confirmed", "cancelled"].includes(nextOccurrence.status)) {
    forbidden("通用单节修改只允许确认或取消。");
  }

  if (input.nextOverride?.classroom !== undefined) {
    assertClassroom(input.nextOverride.classroom, occurrenceId);
    if (nextOccurrence.status !== "confirmed") forbidden("已取消课次不能修改在线教室资料。");
  }

  const scheduleChanged = changed.some((field) => OCCURRENCE_SCHEDULE_FIELDS.has(field));
  if (!scheduleChanged || nextOccurrence.status === "cancelled") return;
  if (![60, 90, 120].includes(nextOccurrence.scheduledDurationMinutes)) invalid("单节课程时长只能是 60、90 或 120 分钟。");
  const teacherId = requiredText(nextOccurrence.teacherId, "occurrence.teacherId");
  requiredText(nextOccurrence.studentId, "occurrence.studentId");
  const teacher = input.teachers.find((candidate) => candidate.id === teacherId);
  if (!teacher) forbidden("所选老师不存在。");
  if (input.context.teacher && !input.context.teacherIds.has(teacherId)) {
    forbidden("老师账号不能把课次改给其他老师。");
  }
  assertTeacherAvailability(nextOccurrence, input.nextBooking, teacher);
  assertNoOccurrenceConflict(nextOccurrence, input.nextBooking, input.bookings);
}

function assertBookingsTransition(input: {
  currentPayload: unknown;
  nextPayload: unknown;
  rows: readonly OpsStateRow[];
  context: OpsAccessContext;
}) {
  const current = records(input.currentPayload, "bookings");
  const next = records(input.nextPayload, "bookings");
  const currentById = byId(current);
  const nextById = byId(next);
  if (currentById.size !== nextById.size || [...currentById.keys()].some((id) => !nextById.has(id))) {
    forbidden("新增、删除或整组修改排课必须使用专用排课流程。");
  }
  const teachers = rowsFor(input.rows, "teachers");
  let changedOccurrenceCount = 0;
  for (const [id, currentBooking] of currentById) {
    const nextBooking = nextById.get(id)!;
    if (!same(
      omit(currentBooking, new Set(["status", "occurrenceOverrides"])),
      omit(nextBooking, new Set(["status", "occurrenceOverrides"])),
    )) {
      forbidden("课程系列的学生、老师、科目、课包和排课规则只能由专用排课流程修改。");
    }
    const statusChanged = !same(currentBooking.status, nextBooking.status);
    if (statusChanged && (!BOOKING_PARENT_STATUSES.has(String(currentBooking.status)) || !BOOKING_PARENT_STATUSES.has(String(nextBooking.status)))) {
      forbidden("课程完成状态只能按具体课次通过专用流程更新。");
    }

    const currentOverrides = new Map(bookingOverrides(currentBooking).map((item) => [item.occurrenceId, item as RecordValue]));
    const nextOverrides = new Map(bookingOverrides(nextBooking).map((item) => [item.occurrenceId, item as RecordValue]));
    const occurrenceIds = new Set([...currentOverrides.keys(), ...nextOverrides.keys()]);
    for (const occurrenceId of occurrenceIds) {
      const before = currentOverrides.get(occurrenceId);
      const after = nextOverrides.get(occurrenceId);
      if (same(before, after)) continue;
      changedOccurrenceCount += 1;
      if (statusChanged || changedOccurrenceCount > 1) {
        forbidden("每次通用保存只能修改一个具体课次，且不能同时修改课程系列状态。");
      }
      assertOccurrenceEdit({
        currentBooking,
        nextBooking,
        currentOverride: before,
        nextOverride: after,
        bookings: next,
        teachers,
        context: input.context,
      });
    }
  }
}

function assertOperationsTransition(currentPayload: unknown, nextPayload: unknown, rows: readonly OpsStateRow[]) {
  const current = records(currentPayload, "operations");
  const next = records(nextPayload, "operations");
  const currentById = byId(current);
  const nextById = byId(next);
  if ([...currentById.keys()].some((id) => !nextById.has(id))) {
    forbidden("异常记录不能通过通用保存删除。");
  }
  const students = byId(rowsFor(rows, "students"));
  const teachers = byId(rowsFor(rows, "teachers"));

  for (const operation of next) {
    const id = requiredText(operation.id, "operation.id");
    const existing = currentById.get(id);
    if (!existing) {
      if (operation.status !== "待处理") forbidden("新异常记录必须从待处理状态开始。");
      if ([...OPERATION_CONFIRMATION_FIELDS].some((field) => Object.hasOwn(operation, field))) {
        forbidden("异常最终确认资料只能由专用确认流程生成。");
      }
      if (Object.hasOwn(operation, "chosenTeacherId")) forbidden("新异常记录不能预先写入代课确认人选。");
      if (!OPERATION_TYPES.has(String(operation.type))) invalid("异常类型不正确。");
      const studentId = requiredText(operation.studentId, "operation.studentId");
      if (!students.has(studentId)) forbidden("异常记录关联的学生不存在。");
      continue;
    }

    const changed = changedFields(existing, operation);
    if (!changed.length) continue;
    if (existing.status !== "待处理" || operation.status !== "待处理") {
      forbidden("异常最终确认只能使用专用确认流程。");
    }
    if (changed.some((field) => field !== "chosenTeacherId")) {
      forbidden("待处理异常只能通过通用保存选择候选老师。");
    }
    if (operation.chosenTeacherId !== undefined) {
      const teacherId = requiredText(operation.chosenTeacherId, "operation.chosenTeacherId");
      if (!teachers.has(teacherId)) forbidden("所选候选老师不存在。");
      const recommended = Array.isArray(existing.recommendedTeacherIds)
        ? existing.recommendedTeacherIds.filter((value): value is string => typeof value === "string")
        : [];
      if (!recommended.includes(teacherId)) forbidden("所选老师不在已记录的候选范围内。");
    }
  }
}

function assertTeachersTransition(currentPayload: unknown, nextPayload: unknown) {
  const current = records(currentPayload, "teachers");
  const next = records(nextPayload, "teachers");
  const currentById = byId(current);
  const nextById = byId(next);
  if ([...currentById.keys()].some((id) => !nextById.has(id))) {
    forbidden("老师档案不能通过通用保存删除。");
  }
  for (const teacher of next) {
    const existing = currentById.get(requiredText(teacher.id, "teacher.id"));
    const assignments = teacher.capacityAssignments ?? [];
    if (!Array.isArray(assignments) || !assignments.every((value) => typeof value === "string" && value.trim())) {
      invalid("老师容量占用资料格式不正确。");
    }
    if (existing) {
      if (!same(existing.capacityAssignments ?? [], assignments)) {
        forbidden("老师容量占用只能由专用排课流程更新。");
      }
    } else if (assignments.length) {
      forbidden("新增老师不能预写容量占用。");
    }
  }
}

function packages(value: RecordValue) {
  const raw = value.lessonPackages;
  if (raw === undefined) return [];
  return records(raw, "lessonPackages");
}

function ledger(value: RecordValue) {
  const raw = value.lessonLedger;
  if (raw === undefined) return [];
  return records(raw, "lessonLedger");
}

function history(value: RecordValue, field: string) {
  const raw = value[field];
  if (raw === undefined) return [];
  return records(raw, field);
}

function assertAppendOnlyHistory(
  current: readonly RecordValue[],
  next: readonly RecordValue[],
  label: string,
) {
  const currentById = byId(current);
  const nextById = byId(next);
  for (const [id, entry] of currentById) {
    if (!nextById.has(id) || !same(entry, nextById.get(id))) {
      forbidden(`${label}只能追加，已有记录不能删除或修改。`);
    }
  }
}

function assertPurchaseRecords(currentPackage: RecordValue, nextPackage: RecordValue) {
  const current = history(currentPackage, "purchaseRecords");
  const next = history(nextPackage, "purchaseRecords");
  assertAppendOnlyHistory(current, next, "课包购买记录");
  const currentIds = new Set(current.map((purchase) => requiredText(purchase.id, "purchase.id")));
  for (const purchase of next.filter((candidate) => !currentIds.has(requiredText(candidate.id, "purchase.id")))) {
    if (typeof purchase.hours !== "number" || !Number.isFinite(purchase.hours) || purchase.hours <= 0) {
      invalid("新增课包购买课时必须是正数。");
    }
    if (typeof purchase.purchasedAt !== "string" || !Number.isFinite(Date.parse(purchase.purchasedAt))) {
      invalid("新增课包购买时间格式不正确。");
    }
  }
}

function assertStudentsTransition(currentPayload: unknown, nextPayload: unknown) {
  const current = records(currentPayload, "students");
  const next = records(nextPayload, "students");
  const currentById = byId(current);
  const nextById = byId(next);
  if ([...currentById.keys()].some((id) => !nextById.has(id))) {
    forbidden("学生档案不能通过通用保存删除。");
  }
  for (const student of next) {
    const existing = currentById.get(requiredText(student.id, "student.id"));
    if (existing?.importArchived === true && !same(existing, student)) {
      forbidden("已归档学生档案只能查看，不能通过通用保存修改。");
    }
    if (
      (!existing && (Object.hasOwn(student, "importArchived") || Object.hasOwn(student, "importArchivedReason")))
      || (existing && (
        !same(existing.importArchived, student.importArchived)
        || !same(existing.importArchivedReason, student.importArchivedReason)
      ))
    ) {
      forbidden("学生导入归档标记只能由正式导入流程修改。");
    }
    if (existing && !same(ledger(existing), ledger(student))) {
      forbidden("学生扣课时流水只能由专用课次结算流程更新。");
    }
    if (!existing && ledger(student).length) {
      forbidden("新增学生不能预写扣课时流水。");
    }
    const currentPackages = byId(existing ? packages(existing) : []);
    const nextPackages = byId(packages(student));
    if ([...currentPackages.keys()].some((id) => !nextPackages.has(id))) {
      forbidden("已有课包不能通过通用保存删除。");
    }
    for (const [packageId, lessonPackage] of nextPackages) {
      const currentPackage = currentPackages.get(packageId);
      if (currentPackage && !same(currentPackage.consumedHours ?? 0, lessonPackage.consumedHours ?? 0)) {
        forbidden("课包已消耗课时只能由专用课次结算流程更新。");
      }
      if (currentPackage) assertPurchaseRecords(currentPackage, lessonPackage);
      if (!currentPackage && Number(lessonPackage.consumedHours ?? 0) !== 0) {
        forbidden("新课包不能预写已消耗课时。");
      }
      if (!currentPackage) {
        for (const purchase of history(lessonPackage, "purchaseRecords")) {
          if (typeof purchase.hours !== "number" || !Number.isFinite(purchase.hours) || purchase.hours <= 0) {
            invalid("新课包购买课时必须是正数。");
          }
          if (typeof purchase.purchasedAt !== "string" || !Number.isFinite(Date.parse(purchase.purchasedAt))) {
            invalid("新课包购买时间格式不正确。");
          }
        }
      }
    }
    if (existing) {
      assertAppendOnlyHistory(
        history(existing, "followUpHistory"),
        history(student, "followUpHistory"),
        "学生跟进历史",
      );
    }
  }
}

function assertLpItemsTransition(currentPayload: unknown, nextPayload: unknown) {
  const current = records(currentPayload, "lpItems");
  const next = records(nextPayload, "lpItems");
  const currentById = byId(current);
  const nextById = byId(next);
  if ([...currentById.keys()].some((id) => !nextById.has(id))) {
    forbidden("LP 工作流不能通过通用保存删除。");
  }
  for (const item of next) {
    const existing = currentById.get(requiredText(item.id, "lpItem.id"));
    if (!existing) continue;
    for (const field of ["revisions", "stageAudit", "resultAudit"] as const) {
      assertAppendOnlyHistory(history(existing, field), history(item, field), `LP ${field}`);
    }
    const currentRevision = existing.revisionNumber ?? 0;
    const nextRevision = item.revisionNumber ?? 0;
    if (!Number.isSafeInteger(currentRevision) || !Number.isSafeInteger(nextRevision) || (nextRevision as number) < (currentRevision as number)) {
      forbidden("LP 修订版本号不能回退。");
    }
  }
}

function isPayrollLedger(value: RecordValue) {
  return value.kind === "teacher_hours" || value.kind === "reversal";
}

function assertPayrollTransition(currentPayload: unknown, nextPayload: unknown) {
  const current = records(currentPayload, "payroll");
  const next = records(nextPayload, "payroll");
  const currentLedger = new Map(current.filter(isPayrollLedger).map((item) => [requiredText(item.id, "payroll.id"), item]));
  const nextLedger = new Map(next.filter(isPayrollLedger).map((item) => [requiredText(item.id, "payroll.id"), item]));
  if (currentLedger.size !== nextLedger.size) forbidden("老师课时流水只能由专用课次结算流程更新。");
  for (const [id, entry] of currentLedger) {
    if (!nextLedger.has(id) || !same(entry, nextLedger.get(id))) {
      forbidden("老师课时流水只能由专用课次结算流程更新。");
    }
  }
}

/**
 * Enforces cross-entity business invariants after role/scope merging and before
 * the generic JSON entity write. Dedicated atomic APIs call the store directly
 * and therefore remain the only writers for settlement/capacity/confirmation.
 */
export function assertOpsStateTransition(input: {
  entity: string;
  currentPayload: unknown;
  nextPayload: unknown;
  rows: readonly OpsStateRow[];
  context: OpsAccessContext;
}) {
  assertArchivedStudentReferencesReadOnly(input);
  switch (input.entity) {
    case "bookings":
      assertBookingsTransition(input);
      return;
    case "operations":
      assertOperationsTransition(input.currentPayload, input.nextPayload, input.rows);
      return;
    case "teachers":
      assertTeachersTransition(input.currentPayload, input.nextPayload);
      return;
    case "students":
      assertStudentsTransition(input.currentPayload, input.nextPayload);
      return;
    case "lpItems":
      assertLpItemsTransition(input.currentPayload, input.nextPayload);
      return;
    case "payroll":
      assertPayrollTransition(input.currentPayload, input.nextPayload);
      return;
    case "files":
      assertAtomicAttachmentFilesReadOnly(input.currentPayload, input.nextPayload);
      return;
    default:
      return;
  }
}

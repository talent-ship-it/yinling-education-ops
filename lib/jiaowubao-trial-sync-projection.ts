import { mapJiaowubaoSnapshotParticipants } from "./jiaowubao-open-api-schedule-reader";
import {
  completeTrialSchedulingReminderTasks,
  generateJiaowubaoTrialTasks,
  isTrialIntake,
  matchTrialScheduleEvents,
  replaceRuleTasks,
  trialPlannerHintFromParticipants,
  TRIAL_JWB_RULE_PREFIX,
  type TrialScheduleLink,
} from "./trial-operations";
import { sortTasksByDueAt, type OpsTask } from "./ops-tasks";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import type { JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "./ops-store";
import type { JiaowubaoTrialSyncMatchRef } from "./jiaowubao-trial-sync";

type RecordValue = Record<string, unknown>;
type RawScheduleEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number];

export class JiaowubaoTrialSyncProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalise(value: unknown) {
  return text(value).toLocaleLowerCase("en-AU");
}

function records(rows: readonly OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  if (!Array.isArray(payload) || !payload.every(record)) {
    throw new JiaowubaoTrialSyncProjectionError("state_unavailable", `${entity} 权威资料不可用。`);
  }
  return payload as RecordValue[];
}

function safeSourceKey(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  const candidate = text(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(candidate) ? candidate : null;
}

function buildStudentLookup(students: readonly RecordValue[], allowedStudentIds: ReadonlySet<string>) {
  const memberCandidates = new Map<string, string[]>();
  const nameCandidates = new Map<string, string[]>();
  for (const student of students) {
    const id = text(student.id);
    if (!id || student.importArchived === true || normalise(student.importArchived) === "true") continue;
    const memberId = safeSourceKey(student.jwbSourceRow);
    if (memberId) memberCandidates.set(memberId, [...new Set([...(memberCandidates.get(memberId) ?? []), id])]);
    const name = text(student.name);
    if (!name) continue;
    for (const key of new Set([normalizeStudentImportName(name), studentImportAutomaticJwbNameKey(name)])) {
      if (!key) continue;
      nameCandidates.set(key, [...new Set([...(nameCandidates.get(key) ?? []), id])]);
    }
  }
  const internalByMember = new Map<string, string>();
  for (const [key, ids] of memberCandidates) {
    if (ids.length === 1 && allowedStudentIds.has(ids[0]!)) internalByMember.set(key, ids[0]!);
  }
  const internalByNameKey = new Map<string, string>();
  for (const [key, ids] of nameCandidates) {
    if (ids.length === 1 && allowedStudentIds.has(ids[0]!)) internalByNameKey.set(key, ids[0]!);
  }
  return {
    internalByMember,
    internalByNameKey,
    memberCandidates: new Map([...memberCandidates].map(([key, ids]) => [key, [...ids]])),
    nameCandidates: new Map([...nameCandidates].map(([key, ids]) => [key, [...ids]])),
  };
}

function teacherIdFromSourceLabel(teachers: readonly RecordValue[], label: string | null) {
  const key = normalise(label);
  if (!key) return null;
  const ids = teachers.flatMap((teacher) => normalise(teacher.name) === key && text(teacher.id) ? [text(teacher.id)] : []);
  return new Set(ids).size === 1 ? ids[0]! : null;
}

function sameScheduleLink(left: unknown, right: TrialScheduleLink) {
  if (!record(left)) return false;
  const leftSemantic = Object.fromEntries(Object.entries(left).filter(([key]) => key !== "matchedAt"));
  const rightSemantic = Object.fromEntries(Object.entries(right).filter(([key]) => key !== "matchedAt"));
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

function isOpsTask(value: RecordValue): value is RecordValue & OpsTask {
  return Boolean(text(value.id) && text(value.title) && text(value.studentId));
}

function managedBookingOwnsPayment(input: Readonly<{
  bookings: readonly RecordValue[];
  tasks: readonly OpsTask[];
  lpItemId: string;
  studentId: string;
}>) {
  const trialBookingIds = new Set(input.bookings.flatMap((booking) =>
    booking.kind === "试听" && text(booking.studentId) === input.studentId && text(booking.id)
      ? [text(booking.id)]
      : []));
  return input.tasks.some((task) => task.requestAnchorBookingId === input.lpItemId
    && Boolean(task.anchorBookingId && trialBookingIds.has(task.anchorBookingId))
    && (task.ruleKey === "trial.payment-n2" || task.ruleKey === "trial.payment-urgent"));
}

export type JiaowubaoTrialSyncProjection = Readonly<{
  nextLpItems: readonly RecordValue[];
  nextTasks: readonly OpsTask[];
  studentIds: readonly string[];
  evidence: readonly Readonly<{
    lpItemId: string;
    eventId: string;
    studentId: string;
    paymentManagedByBooking: boolean;
  }>[];
}>;

/**
 * Rebuilds the whole narrow projection from current ops rows and raw immutable
 * JWB events. The browser's pairs are references only; they never provide a
 * teacher, student, task, deadline, or LP payload that can be persisted.
 */
export function prepareJiaowubaoTrialSyncProjection(input: Readonly<{
  rows: readonly OpsStateRow[];
  references: readonly JiaowubaoTrialSyncMatchRef[];
  rawEvents: readonly RawScheduleEvent[];
  snapshotRevision: string;
  matchedAt: Date | string;
}>): JiaowubaoTrialSyncProjection {
  const lpItems = records(input.rows, "lpItems");
  const students = records(input.rows, "students");
  const teachers = records(input.rows, "teachers");
  const bookings = records(input.rows, "bookings");
  const taskRecords = records(input.rows, "tasks");
  if (!taskRecords.every(isOpsTask)) {
    throw new JiaowubaoTrialSyncProjectionError("state_unavailable", "任务权威资料格式无效。");
  }
  const tasks = taskRecords as (RecordValue & OpsTask)[];
  const eventById = new Map(input.rawEvents.map((event) => [event.eventId, event]));
  if (eventById.size !== input.rawEvents.length
    || !/^sha256:[a-f0-9]{64}$/.test(input.snapshotRevision)
    || input.references.some((reference) => eventById.get(reference.eventId)?.startsAt !== reference.startsAt)) {
    throw new JiaowubaoTrialSyncProjectionError("source_mismatch", "教务宝试听匹配证据不完整。");
  }

  const requestedLpItems = input.references.map((reference) => {
    const matches = lpItems.filter((item) => text(item.id) === reference.lpItemId);
    if (matches.length !== 1) throw new JiaowubaoTrialSyncProjectionError("lp_not_found", "试听 LP 已不存在。");
    return matches[0]!;
  });
  const allowedStudentIds = new Set(requestedLpItems.map((item) => text(item.studentId)).filter(Boolean));
  const studentLookup = buildStudentLookup(students, allowedStudentIds);
  const matchedAt = new Date(input.matchedAt);
  if (!Number.isFinite(matchedAt.valueOf())) {
    throw new JiaowubaoTrialSyncProjectionError("invalid_clock", "试听同步时钟无效。");
  }

  const sourceEvents = input.rawEvents.flatMap((raw) => {
    // A truncated participant list cannot prove the student identity used by
    // a trial match. Leave it out of the candidate set so a submitted
    // reference to that event fails the exact recomputation below.
    if (raw.sourceStudentsTruncated) return [];
    const visibleStudentIds = [...new Set(mapJiaowubaoSnapshotParticipants(raw.sourceParticipants, studentLookup))];
    return [{
      eventId: raw.eventId,
      startsAt: raw.startsAt,
      endsAt: raw.endsAt,
      courseName: raw.courseName,
      teacherId: teacherIdFromSourceLabel(teachers, raw.sourceTeacherLabel),
      teacherName: raw.sourceTeacherLabel,
      visibleStudentIds,
      trialPlannerHint: trialPlannerHintFromParticipants(raw.sourceParticipants),
    }];
  });
  const preparedMatches = matchTrialScheduleEvents({
    lpItems: requestedLpItems.map((item) => ({
      id: text(item.id),
      studentId: text(item.studentId),
      workflowType: text(item.workflowType),
      stage: text(item.stage),
      ...(text(item.requestedAt) ? { requestedAt: text(item.requestedAt) } : {}),
      ...(record(item.fields) ? { fields: item.fields } : {}),
      ...(isTrialIntake(item.trialIntake) ? { trialIntake: item.trialIntake } : {}),
    })),
    students: students.map((student) => ({
      id: text(student.id),
      name: text(student.name),
      owner: text(student.owner),
      planner: text(student.planner),
    })),
    teachers: teachers.map((teacher) => ({ id: text(teacher.id), name: text(teacher.name) })),
    events: sourceEvents,
    matchedAt,
    sourceRevision: input.snapshotRevision,
  });
  const referenceByLpId = new Map(input.references.map((reference) => [reference.lpItemId, reference]));
  if (preparedMatches.length !== input.references.length
    || preparedMatches.some((match) => {
      const reference = referenceByLpId.get(match.lpItemId);
      return !reference || match.link.eventId !== reference.eventId || match.link.startsAt !== reference.startsAt;
    })) {
    throw new JiaowubaoTrialSyncProjectionError("match_rejected", "教务宝排课与试听 LP 不能再无歧义匹配。");
  }

  const matchByLpId = new Map(preparedMatches.map((match) => [match.lpItemId, match]));
  const nextLpItems = lpItems.map((item) => {
    const match = matchByLpId.get(text(item.id));
    if (!match) return item;
    const existing = item.trialSchedule;
    const link = sameScheduleLink(existing, match.link) && record(existing) && text(existing.matchedAt)
      ? { ...match.link, matchedAt: text(existing.matchedAt) }
      : match.link;
    return { ...item, trialSchedule: link };
  });

  let nextTasks: OpsTask[] = [...tasks];
  const evidence: JiaowubaoTrialSyncProjection["evidence"][number][] = [];
  for (const match of preparedMatches) {
    const sourceLp = requestedLpItems.find((item) => text(item.id) === match.lpItemId)!;
    const previousEventId = record(sourceLp.trialSchedule) ? text(sourceLp.trialSchedule.eventId) : "";
    const currentAnchor = `JWB:${match.link.eventId}`;
    const previousAnchor = previousEventId ? `JWB:${previousEventId}` : "";
    // Open tasks from an older link must not survive a source rematch. Keep
    // completed history, including legacy rows created before request anchors
    // were added.
    nextTasks = nextTasks.filter((task) => task.status === "done"
      || task.ruleKey?.startsWith(TRIAL_JWB_RULE_PREFIX) !== true
      || !(task.requestAnchorBookingId === match.lpItemId
        || Boolean(previousAnchor && task.anchorBookingId === previousAnchor))
      || task.anchorBookingId === currentAnchor);
    const paymentManagedByBooking = managedBookingOwnsPayment({
      bookings,
      tasks: nextTasks,
      lpItemId: match.lpItemId,
      studentId: match.studentId,
    });
    const generated = generateJiaowubaoTrialTasks({ ...match, now: matchedAt, paymentManagedByBooking });
    nextTasks = replaceRuleTasks(nextTasks, generated, {
      anchor: currentAnchor,
      rulePrefixes: [TRIAL_JWB_RULE_PREFIX],
    });
    nextTasks = completeTrialSchedulingReminderTasks(nextTasks, {
      lpItemId: match.lpItemId,
      eventId: match.link.eventId,
      completedAt: matchedAt,
    });
    evidence.push({
      lpItemId: match.lpItemId,
      eventId: match.link.eventId,
      studentId: match.studentId,
      paymentManagedByBooking,
    });
  }

  return {
    nextLpItems,
    nextTasks: sortTasksByDueAt(nextTasks),
    studentIds: [...new Set(preparedMatches.map((match) => match.studentId))].sort(),
    evidence,
  };
}

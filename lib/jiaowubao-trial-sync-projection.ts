import { trialAccountFromParticipants } from "./trial-account-label";
import { enrichTrialHandover } from "./trial-handover-enrichment";
import { mapJiaowubaoSnapshotParticipants } from "./jiaowubao-open-api-schedule-reader";
import {
  completeTrialSchedulingReminderTasks,
  generateJiaowubaoTrialTasks,
  isTrialIntake,
  matchTrialScheduleEvents,
  replaceRuleTasks,
  trialPlannerHintFromParticipants,
  TRIAL_JWB_RULE_PREFIX,
  TRIAL_JWB_SCHEDULE_RULE_KEYS,
  TRIAL_TEACHER_REPLY_RULE_KEYS,
  type TrialScheduleLink,
} from "./trial-operations";
import { sortTasksByDueAt, type OpsTask } from "./ops-tasks";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import type { JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "./ops-store";
import { jiaowubaoTrialMissingScheduleRefs, type JiaowubaoTrialSyncMatchRef, type JiaowubaoTrialSyncWindow } from "./jiaowubao-trial-sync";

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
  const metadataKeys = new Set(["matchedAt", "studentName", "durationMinutes", "sharedAccountLabel", "sharedAccountLetter"]);
  const leftSemantic = Object.fromEntries(Object.entries(left).filter(([key]) => !metadataKeys.has(key)));
  const rightSemantic = Object.fromEntries(Object.entries(right).filter(([key]) => !metadataKeys.has(key)));
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
  references: readonly JiaowubaoTrialSyncMatchRef[];
  revocations: readonly JiaowubaoTrialSyncMatchRef[];
  evidence: readonly Readonly<{
    lpItemId: string;
    eventId: string;
    studentId: string;
    paymentManagedByBooking: boolean;
  }>[];
}>;

function reviewedScheduleMetadata(item: RecordValue) {
  const metadata: { trialScheduleReview?: { source: "screenshot-review"; eventId: string }; trialSchedule?: TrialScheduleLink } = {};
  if (record(item.trialScheduleReview) && item.trialScheduleReview.source === "screenshot-review" && text(item.trialScheduleReview.eventId)) metadata.trialScheduleReview = { source: "screenshot-review", eventId: text(item.trialScheduleReview.eventId) };
  if (record(item.trialSchedule) && item.trialSchedule.confirmation === "screenshot-review") metadata.trialSchedule = item.trialSchedule as TrialScheduleLink;
  return metadata;
}

/**
 * Rebuilds the whole narrow projection from current ops rows and raw immutable
 * JWB events. The browser's pairs are references only; they never provide a
 * teacher, student, task, deadline, or LP payload that can be persisted.
 */
export function prepareJiaowubaoTrialSyncProjection(input: Readonly<{
  rows: readonly OpsStateRow[];
  references?: readonly JiaowubaoTrialSyncMatchRef[];
  revocations?: readonly JiaowubaoTrialSyncMatchRef[];
  /** Present only after the entire immutable source window was read. */
  window?: JiaowubaoTrialSyncWindow;
  rawEvents: readonly RawScheduleEvent[];
  snapshotRevision: string;
  matchedAt: Date | string;
  enrichHandover?: boolean;
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
    || input.references?.some((reference) => eventById.get(reference.eventId)?.startsAt !== reference.startsAt)) {
    throw new JiaowubaoTrialSyncProjectionError("source_mismatch", "教务宝试听匹配证据不完整。");
  }

  // References select writes, never the competitors used to prove uniqueness.
  const activeLpItems = lpItems.filter((item) => ["试听 LP", "换老师试听"].includes(text(item.workflowType))
      && text(item.stage) !== "完成");
  const allowedStudentIds = new Set(activeLpItems.map((item) => text(item.studentId)).filter(Boolean));
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
      ...trialAccountFromParticipants(raw.sourceParticipants),
    }];
  });
  const allMatches = matchTrialScheduleEvents({
    lpItems: activeLpItems.map((item) => ({
      id: text(item.id),
      studentId: text(item.studentId),
      workflowType: text(item.workflowType),
      stage: text(item.stage),
      ...(text(item.requestedAt) ? { requestedAt: text(item.requestedAt) } : {}),
      ...(typeof item.trialPaid === "boolean" ? { trialPaid: item.trialPaid } : {}),
      ...(record(item.fields) ? { fields: item.fields } : {}),
      ...(isTrialIntake(item.trialIntake) ? { trialIntake: item.trialIntake } : {}),
      ...reviewedScheduleMetadata(item),
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
  }).filter((match) => !lpItems.some((item) => text(item.id) !== match.lpItemId
    && record(item.trialSchedule) && text(item.trialSchedule.eventId) === match.link.eventId));
  const preparedMatches = input.references
    ? allMatches.filter((match) => input.references!.some((reference) => reference.lpItemId === match.lpItemId))
    : allMatches;
  if (input.references) {
    const referenceByLpId = new Map(input.references.map((reference) => [reference.lpItemId, reference]));
    if (preparedMatches.length !== input.references.length
      || preparedMatches.some((match) => {
        const reference = referenceByLpId.get(match.lpItemId);
        return !reference || match.link.eventId !== reference.eventId || match.link.startsAt !== reference.startsAt;
      })) {
      throw new JiaowubaoTrialSyncProjectionError("match_rejected", "教务宝排课与试听 LP 不能再无歧义匹配。");
    }
  }

  const missing = input.window ? jiaowubaoTrialMissingScheduleRefs({
    lpItems: activeLpItems.map((item) => ({ id: text(item.id), workflowType: text(item.workflowType),
      stage: text(item.stage), trialSchedule: item.trialSchedule })),
    eventIds: new Set(eventById.keys()), window: input.window, now: matchedAt,
  }).filter((reference) => !allMatches.some((match) => match.lpItemId === reference.lpItemId)) : [];
  const revocations = input.revocations
    ? missing.filter((reference) => input.revocations!.some((requested) => requested.lpItemId === reference.lpItemId
      && requested.eventId === reference.eventId && requested.startsAt === reference.startsAt))
    : input.references ? [] : missing;
  if (input.revocations && (revocations.length !== input.revocations.length
    || revocations.some((reference) => preparedMatches.some((match) => match.lpItemId === reference.lpItemId)))) {
    throw new JiaowubaoTrialSyncProjectionError("source_mismatch", "撤销排课需要完整新快照证明未开始的原排课已不存在。");
  }

  const matchByLpId = new Map(preparedMatches.map((match) => [match.lpItemId, match]));
  const nextLpItems = lpItems.map((item) => {
    if (revocations.some((reference) => reference.lpItemId === text(item.id))) {
      const next = { ...item };
      delete next.trialSchedule;
      return next;
    }
    const match = matchByLpId.get(text(item.id));
    if (!match) return item;
    const existing = item.trialSchedule;
    const link = sameScheduleLink(existing, match.link) && record(existing) && text(existing.matchedAt)
      ? { ...match.link, matchedAt: text(existing.matchedAt) }
      : match.link;
    return { ...(input.enrichHandover === false ? item : enrichTrialHandover(item, eventById.get(link.eventId)!, students)), trialSchedule: link };
  });

  let nextTasks: OpsTask[] = tasks.filter((task) => task.status === "done"
    || task.ruleKey?.startsWith(TRIAL_JWB_RULE_PREFIX) !== true
    || !revocations.some((reference) => task.anchorBookingId === `JWB:${reference.eventId}`
      && task.studentId === text(lpItems.find((item) => text(item.id) === reference.lpItemId)?.studentId)
      && (!task.requestAnchorBookingId || task.requestAnchorBookingId === reference.lpItemId)));
  const evidence: JiaowubaoTrialSyncProjection["evidence"][number][] = [];
  for (const match of preparedMatches) {
    const sourceLp = activeLpItems.find((item) => text(item.id) === match.lpItemId)!;
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
    nextTasks = nextTasks.filter((task) => task.status === "done"
      || task.requestAnchorBookingId !== match.lpItemId
      || !(TRIAL_TEACHER_REPLY_RULE_KEYS as readonly string[]).includes(task.ruleKey ?? ""));
    const paymentManagedByBooking = managedBookingOwnsPayment({
      bookings,
      tasks: nextTasks,
      lpItemId: match.lpItemId,
      studentId: match.studentId,
    });
    const generated = generateJiaowubaoTrialTasks({ ...match, now: matchedAt, paymentManagedByBooking });
    nextTasks = replaceRuleTasks(nextTasks, generated, {
      anchor: currentAnchor,
      ruleKeys: TRIAL_JWB_SCHEDULE_RULE_KEYS,
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
    studentIds: [...new Set([...preparedMatches.map((match) => match.studentId),
      ...revocations.map((reference) => text(lpItems.find((item) => text(item.id) === reference.lpItemId)?.studentId))])].sort(),
    revocations,
    references: preparedMatches.map((match) => ({
      lpItemId: match.lpItemId,
      eventId: match.link.eventId,
      startsAt: match.link.startsAt,
    })).sort((left, right) => left.lpItemId.localeCompare(right.lpItemId)
      || left.eventId.localeCompare(right.eventId)),
    evidence,
  };
}

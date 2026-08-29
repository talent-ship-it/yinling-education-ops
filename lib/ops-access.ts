import {
  DEMO_LIMITED_ADMIN_USER,
  isDemoStaff,
  type DemoUser,
} from "@/lib/demo-users";
import { bookingHasEffectiveTeacher } from "@/lib/booking-teacher-scope";
import type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";
import { EXAM_RULE_NO_LONGER_APPLICABLE_RESULT } from "@/lib/exam-tasks";
import {
  projectManagedExamRecord,
  type ManagedExamProjectionSnapshot,
  type ManagedExamStudentProjection,
} from "@/lib/managed-exam-refresh";
import {
  isManagedTrialPaymentConfirmationTask,
  managedTrialPaymentTaskLifecycleChange,
  type ManagedTrialPaymentProjectionSnapshot,
  type ManagedTrialPaymentStudentProjection,
} from "@/lib/managed-trial-payment";
import type { OpsStateRow, OpsVersionRow } from "@/lib/ops-store";

export type { ManagedExamProjectionSnapshot, ManagedExamStudentProjection } from "@/lib/managed-exam-refresh";
export type { ManagedTrialPaymentProjectionSnapshot, ManagedTrialPaymentStudentProjection } from "@/lib/managed-trial-payment";

type RecordValue = Record<string, unknown>;

export type OpsAccessContext = {
  actor: DemoUser;
  role: DemoSessionRole;
  fullAdmin: boolean;
  limitedAdmin: boolean;
  staff: boolean;
  teacher: boolean;
  /** Null only for a legacy transition session that predates lifecycle authorization. */
  permissions: Set<string> | null;
  entityScope: Set<string>;
  restrictedStudentScope: boolean;
  studentIds: Set<string>;
  activeStudentIds: Set<string>;
  /** Server-only scope facts used to authorize a managed task without exposing its student row. */
  allActiveStudentIds: Set<string>;
  studentOwnerById: Map<string, string>;
  studentPlannerById: Map<string, string>;
  studentExamIdsById: Map<string, Set<string>>;
  /** Exact scheduled trial anchor -> student authority for payment tasks. */
  trialBookingStudentById: Map<string, string>;
  /** Exact current Jiaowubao-linked trial LP authority for payment tasks. */
  trialLpStudentById: Map<string, string>;
  trialLpPlannerById: Map<string, string>;
  trialLpEventById: Map<string, string>;
  teacherIds: Set<string>;
};

const ACCESS_SCOPE_ENTITIES = ["bookings", "students", "teachers"] as const;

export class OpsAccessError extends Error {}

const STAFF_READ_ENTITIES = new Set([
  "students", "teachers", "tasks", "bookings", "courses", "lpItems", "operations", "renewals", "messages", "files",
]);
const TEACHER_READ_ENTITIES = new Set([
  "students", "teachers", "tasks", "bookings", "courses", "messages", "files",
]);
const STAFF_WRITE_ENTITIES = new Set([
  "students", "tasks", "bookings", "lpItems", "operations", "renewals", "messages", "files",
]);
const TEACHER_WRITE_ENTITIES = new Set(["bookings", "messages"]);

function normalise(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function samePerson(left: unknown, right: string) {
  return normalise(left) === normalise(right);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payloadRecords(rows: OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  return Array.isArray(payload) ? payload.filter(isRecord) : [];
}

function teachersIncludeActor(rows: OpsStateRow[], actor: string) {
  return payloadRecords(rows, "teachers").some((teacher) => samePerson(teacher.name, actor));
}

function rowStudentId(value: RecordValue) {
  return typeof value.studentId === "string" ? value.studentId : "";
}

function rowId(value: RecordValue) {
  return typeof value.id === "string" ? value.id : "";
}

function rowTeacherId(value: RecordValue) {
  return typeof value.teacherId === "string" ? value.teacherId : "";
}

/**
 * Optional Task recipient fields support dual assignment without breaking the
 * legacy single-owner records already persisted in ops_state.
 */
function taskRecipients(value: RecordValue, field: "assignees" | "watchers") {
  const recipients = value[field];
  return Array.isArray(recipients)
    ? recipients.filter((recipient): recipient is string => typeof recipient === "string" && Boolean(recipient.trim()))
    : [];
}

function taskInvolves(value: RecordValue, actor: string) {
  return samePerson(value.owner, actor)
    || taskRecipients(value, "assignees").some((recipient) => samePerson(recipient, actor))
    || taskRecipients(value, "watchers").some((recipient) => samePerson(recipient, actor));
}

function taskAssignedTo(value: RecordValue, actor: string) {
  return samePerson(value.owner, actor)
    || taskRecipients(value, "assignees").some((recipient) => samePerson(recipient, actor));
}

function managedTrialPaymentTaskIdentity(value: RecordValue) {
  const ruleKey = value.ruleKey;
  const anchor = typeof value.anchorBookingId === "string" ? value.anchorBookingId.trim() : "";
  if (value.category !== "试听" || !anchor) return false;
  if (ruleKey === "trial.payment-n2" || ruleKey === "trial.payment-urgent") {
    return { kind: "booking", bookingId: anchor, ruleKey } as const;
  }
  const lpItemId = typeof value.requestAnchorBookingId === "string"
    ? value.requestAnchorBookingId.trim()
    : "";
  const event = anchor.match(/^JWB:([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/);
  if (ruleKey !== "trial.jiaowubao.payment-n2"
    || !event
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(lpItemId)) return false;
  return { kind: "jiaowubao", lpItemId, eventId: event[1]!, ruleKey } as const;
}

/**
 * Cross-owner payment access is intentionally narrower than student scope:
 * exact trial anchor, exact current planner, one assignee, and teaching-control
 * as the only watcher. A student's operations owner does not inherit it.
 */
function managedTrialPaymentTaskMatchesStudent(context: OpsAccessContext, value: RecordValue) {
  const identity = managedTrialPaymentTaskIdentity(value);
  const studentId = rowStudentId(value);
  const actionableStatus = typeof value.status === "string"
    && (["overdue", "today", "upcoming", "waiting"].includes(value.status)
      || value.status === "done" && value.completionOutcome === "cannot_do"
      || isManagedTrialPaymentConfirmationTask(value));
  if (!identity || !actionableStatus || !studentId || !context.allActiveStudentIds.has(studentId)) return false;
  const planner = identity.kind === "booking"
    ? context.studentPlannerById.get(studentId)
    : context.trialLpPlannerById.get(identity.lpItemId);
  const authorityMatches = identity.kind === "booking"
    ? context.trialBookingStudentById.get(identity.bookingId) === studentId
    : context.trialLpStudentById.get(identity.lpItemId) === studentId
      && context.trialLpEventById.get(identity.lpItemId) === identity.eventId;
  if (!authorityMatches) return false;
  if (!isConfiguredRecipient(planner) || !samePerson(value.owner, planner!)) return false;
  const assignees = taskRecipients(value, "assignees");
  const watchers = taskRecipients(value, "watchers");
  return assignees.length === 1
    && samePerson(assignees[0], planner!)
    && watchers.length === 1
    && samePerson(watchers[0], DEMO_LIMITED_ADMIN_USER);
}

function managedExamTaskIdentity(value: RecordValue) {
  if (value.category !== "考试" || typeof value.ruleKey !== "string" || typeof value.anchorBookingId !== "string") return false;
  const match = value.ruleKey.match(/^exam:([^:]+):(planning|care|recall|results)$/);
  if (!match || value.anchorBookingId !== `exam:${match[1]}`) return false;
  return { examId: match[1], suffix: match[2] as "planning" | "care" | "recall" | "results" };
}

function isConfiguredRecipient(value: string | undefined) {
  const recipient = value?.trim();
  return Boolean(recipient && !/^(?:待分配|待确认|未知|角色待配置[:：])/.test(recipient));
}

function canonicalTrialPlanner(value: string | undefined) {
  return ["Tara", "Eileen", "Abby"].find((planner) => samePerson(value, planner));
}

function managedExamTaskBelongsToKnownExam(context: OpsAccessContext, value: RecordValue) {
  const identity = managedExamTaskIdentity(value);
  const targetStudentId = rowStudentId(value);
  return Boolean(identity
    && targetStudentId
    && context.studentExamIdsById.get(targetStudentId)?.has(identity.examId));
}

/**
 * The elevated task path is deliberately narrower than ordinary task access:
 * the rule/anchor must identify a real exam on that student and recipients are
 * derived only from the student's owner/planner fields.
 */
function managedExamTaskMatchesStudent(context: OpsAccessContext, value: RecordValue) {
  const identity = managedExamTaskIdentity(value);
  const targetStudentId = rowStudentId(value);
  if (!identity
    || !context.allActiveStudentIds.has(targetStudentId)
    || !managedExamTaskBelongsToKnownExam(context, value)) return false;
  const expectedOwner = identity.suffix === "results" || identity.suffix === "planning"
    ? context.studentPlannerById.get(targetStudentId)
    : context.studentOwnerById.get(targetStudentId);
  if (!isConfiguredRecipient(expectedOwner) || !samePerson(value.owner, expectedOwner!)) return false;
  const assignees = taskRecipients(value, "assignees");
  const watchers = taskRecipients(value, "watchers");
  return assignees.length === 1
    && samePerson(assignees[0], expectedOwner!)
    && watchers.length === 1
    && samePerson(watchers[0], DEMO_LIMITED_ADMIN_USER);
}

function sameManagedExamTask(existing: RecordValue, replacement: RecordValue) {
  const before = managedExamTaskIdentity(existing);
  const after = managedExamTaskIdentity(replacement);
  return Boolean(before && after
    && before.examId === after.examId
    && before.suffix === after.suffix
    && rowId(existing) === rowId(replacement)
    && rowStudentId(existing) === rowStudentId(replacement));
}

const MANAGED_EXAM_COMPLETION_FIELDS = ["status", "tone", "closedAt", "result"] as const;

function managedExamCompletion(value: RecordValue) {
  return Object.fromEntries(MANAGED_EXAM_COMPLETION_FIELDS.map((field) => [field, value[field]]));
}

function managedExamCoordinatorCompletionAllowed(existing: RecordValue, replacement: RecordValue) {
  if (JSON.stringify(managedExamCompletion(existing)) === JSON.stringify(managedExamCompletion(replacement))) return true;
  const closesAutomatically = replacement.status === "done"
    && replacement.result === EXAM_RULE_NO_LONGER_APPLICABLE_RESULT
    && typeof replacement.closedAt === "string";
  const reopensAutomaticClosure = existing.status === "done"
    && existing.result === EXAM_RULE_NO_LONGER_APPLICABLE_RESULT
    && replacement.status === "waiting"
    && replacement.result === undefined
    && replacement.closedAt === undefined;
  return closesAutomatically || reopensAutomaticClosure;
}

function managedExamCoordinatorChangeAllowed(
  existing: RecordValue,
  replacement: RecordValue,
  context: OpsAccessContext,
) {
  const existingIdentity = managedExamTaskIdentity(existing);
  return Boolean(existingIdentity
    && sameManagedExamTask(existing, replacement)
    && canOperateStudent(context, rowStudentId(existing))
    && context.studentExamIdsById.get(rowStudentId(existing))?.has(existingIdentity.examId)
    && managedExamTaskMatchesStudent(context, replacement)
    && managedExamCoordinatorCompletionAllowed(existing, replacement));
}

function managedExamAssigneeChangeAllowed(
  existing: RecordValue,
  replacement: RecordValue,
  context: OpsAccessContext,
) {
  if (!sameManagedExamTask(existing, replacement)
    || !managedExamTaskMatchesStudent(context, existing)
    || !managedExamTaskMatchesStudent(context, replacement)
    || !context.allActiveStudentIds.has(rowStudentId(existing))) return false;
  const actor = context.actor;
  if (!taskAssignedTo(existing, actor) || !taskAssignedTo(replacement, actor)) return false;
  const mutable = new Set<string>(MANAGED_EXAM_COMPLETION_FIELDS);
  const stable = (value: RecordValue) => Object.fromEntries(
    Object.entries(value).filter(([key]) => !mutable.has(key)),
  );
  return JSON.stringify(stable(existing)) === JSON.stringify(stable(replacement));
}

function taskExplicitlyVisibleToTeacher(value: RecordValue, actor: string) {
  return taskRecipients(value, "assignees").some((recipient) => samePerson(recipient, actor))
    || (value.teacherVisible === true && taskInvolves(value, actor));
}

export function buildOpsAccessContext(
  rows: OpsStateRow[],
  actor: DemoUser,
  fullAdmin: boolean,
  signedIdentity?: DemoSessionRole | DemoSessionIdentity,
): OpsAccessContext {
  const signedRole = typeof signedIdentity === "string" ? signedIdentity : signedIdentity?.role;
  const permissions = typeof signedIdentity === "object" && Array.isArray(signedIdentity.permissions)
    ? new Set(signedIdentity.permissions)
    : null;
  const scopeMembers = typeof signedIdentity === "object" && Array.isArray(signedIdentity.scopeMembers)
    ? signedIdentity.scopeMembers.filter((member) => member && typeof member.kind === "string" && typeof member.key === "string")
    : [];
  const unrestrictedScope = scopeMembers.some((member) => member.kind === "all" && member.key === "*");
  const studentScopeKeys = unrestrictedScope
    ? new Set<string>()
    : new Set(scopeMembers.filter((member) => member.kind === "student").map((member) => normalise(member.key)));
  const teacherScopeKeys = unrestrictedScope
    ? new Set<string>()
    : new Set(scopeMembers.filter((member) => member.kind === "teacher").map((member) => normalise(member.key)));
  const entityScope = unrestrictedScope
    ? new Set<string>()
    : new Set(scopeMembers.filter((member) => member.kind === "entity").map((member) => member.key.trim()).filter(Boolean));
  const restrictedStudentScope = studentScopeKeys.size > 0 || teacherScopeKeys.size > 0;
  const signedAdmin = signedRole === "admin";
  const limitedAdmin = !fullAdmin && (signedRole
    ? signedRole === "limited-admin" || signedAdmin
    : actor === DEMO_LIMITED_ADMIN_USER);
  const staff = signedRole ? signedRole === "staff" : isDemoStaff(actor);
  const teacher = signedRole ? signedRole === "teacher" : teachersIncludeActor(rows, actor);
  const role: DemoSessionRole = fullAdmin
    ? "admin"
    : signedAdmin
      ? "admin"
    : limitedAdmin
      ? "limited-admin"
      : teacher
        ? "teacher"
        : "staff";

  const teachers = payloadRecords(rows, "teachers");
  const actorTeacherIds = new Set(teachers.filter((item) => samePerson(item.name, actor)).map(rowId).filter(Boolean));
  const explicitlyScopedTeacherIds = new Set(teachers
    .filter((item) => teacherScopeKeys.has(normalise(rowId(item))))
    .map(rowId)
    .filter(Boolean));
  const teacherNameCounts = new Map<string, number>();
  for (const rosterTeacher of teachers) {
    const name = normalise(rosterTeacher.name);
    if (name) teacherNameCounts.set(name, (teacherNameCounts.get(name) ?? 0) + 1);
  }
  const explicitlyScopedTeacherNames = new Set(teachers
    .filter((item) => explicitlyScopedTeacherIds.has(rowId(item)))
    .map((item) => normalise(item.name))
    .filter((name) => name && teacherNameCounts.get(name) === 1));
  const teacherIds = teacherScopeKeys.size > 0 ? explicitlyScopedTeacherIds : actorTeacherIds;
  const bookings = payloadRecords(rows, "bookings");
  const trialBookingStudentById = new Map(
    bookings
      .filter((booking) => booking.kind === "试听" && rowId(booking) && rowStudentId(booking))
      .map((booking) => [rowId(booking), rowStudentId(booking)]),
  );
  const students = payloadRecords(rows, "students");
  const studentIds = new Set(
    students
      .filter((student) => {
        if (fullAdmin || limitedAdmin) return true;
        if (staff) return samePerson(student.owner, actor);
        if (!teacher) return false;
        return samePerson(student.teacher, actor)
          || bookings.some((booking) => booking.studentId === student.id
            && bookingHasEffectiveTeacher(booking, teacherIds));
      })
      .map(rowId)
      .filter(Boolean),
  );
  if (restrictedStudentScope) {
    const directlyScopedStudentIds = new Set(students
      .filter((student) => studentScopeKeys.has(normalise(rowId(student))))
      .map(rowId)
      .filter(Boolean));
    const teacherScopedStudentIds = new Set(students.flatMap((student) => {
      const studentId = rowId(student);
      if (!studentId) return [];
      const rosterAssigned = explicitlyScopedTeacherNames.has(normalise(student.teacher));
      const bookingAssigned = bookings.some((booking) => rowStudentId(booking) === studentId
        && bookingHasEffectiveTeacher(booking, explicitlyScopedTeacherIds));
      return rosterAssigned || bookingAssigned ? [studentId] : [];
    }));
    for (const studentId of studentIds) {
      if (!directlyScopedStudentIds.has(studentId) && !teacherScopedStudentIds.has(studentId)) studentIds.delete(studentId);
    }
    for (const booking of bookings) {
      if (studentIds.has(rowStudentId(booking)) && rowTeacherId(booking)) teacherIds.add(rowTeacherId(booking));
    }
  }
  const activeStudentIds = new Set(
    students
      .filter((student) => student.importArchived !== true && studentIds.has(rowId(student)))
      .map(rowId)
      .filter(Boolean),
  );

  const allActiveStudentIds = new Set(
    students
      .filter((student) => student.importArchived !== true)
      .map(rowId)
      .filter(Boolean),
  );
  const studentOwnerById = new Map<string, string>();
  const studentPlannerById = new Map<string, string>();
  const studentExamIdsById = new Map<string, Set<string>>();
  for (const student of students) {
    const studentId = rowId(student);
    if (!studentId) continue;
    studentOwnerById.set(studentId, String(student.owner ?? ""));
    studentPlannerById.set(studentId, String(student.planner ?? ""));
    studentExamIdsById.set(studentId, new Set((Array.isArray(student.exams) ? student.exams : [])
      .filter(isRecord)
      .map((exam) => rowId(exam))
      .filter(Boolean)));
  }

  const lpCandidatesById = new Map<string, RecordValue[]>();
  for (const lpItem of payloadRecords(rows, "lpItems")) {
    const id = rowId(lpItem);
    if (!id || lpItem.workflowType !== "试听 LP" || lpItem.stage === "完成") continue;
    lpCandidatesById.set(id, [...(lpCandidatesById.get(id) ?? []), lpItem]);
  }
  const trialLpStudentById = new Map<string, string>();
  const trialLpPlannerById = new Map<string, string>();
  const trialLpEventById = new Map<string, string>();
  for (const [id, candidates] of lpCandidatesById) {
    if (candidates.length !== 1) continue;
    const lpItem = candidates[0]!;
    const studentId = rowStudentId(lpItem);
    const intake = isRecord(lpItem.trialIntake) ? lpItem.trialIntake : null;
    const schedule = isRecord(lpItem.trialSchedule) ? lpItem.trialSchedule : null;
    const plannerCandidate = typeof intake?.planner === "string" && intake.planner.trim()
      ? intake.planner.trim()
      : studentPlannerById.get(studentId) ?? "";
    const planner = canonicalTrialPlanner(plannerCandidate);
    const eventId = typeof schedule?.eventId === "string" ? schedule.eventId.trim() : "";
    const sourceRevision = typeof schedule?.sourceRevision === "string" ? schedule.sourceRevision.trim() : "";
    if (!studentId
      || schedule?.source !== "jiaowubao-open-api"
      || !/^sha256:[a-f0-9]{64}$/.test(sourceRevision)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(eventId)
      || !planner) continue;
    trialLpStudentById.set(id, studentId);
    trialLpPlannerById.set(id, planner);
    trialLpEventById.set(id, eventId);
  }

  return {
    actor,
    role,
    fullAdmin,
    limitedAdmin,
    staff,
    teacher,
    permissions,
    entityScope,
    restrictedStudentScope,
    studentIds,
    activeStudentIds,
    allActiveStudentIds,
    studentOwnerById,
    studentPlannerById,
    studentExamIdsById,
    trialBookingStudentById,
    trialLpStudentById,
    trialLpPlannerById,
    trialLpEventById,
    teacherIds,
  };
}

/**
 * Scoped access is derived from these three payloads. Their versions travel with
 * every scoped write so the database can reject a request if assignment changed
 * after the page was loaded.
 */
export function getAccessScopeVersions(rows: OpsStateRow[], context: OpsAccessContext) {
  if (context.fullAdmin || (context.limitedAdmin && !context.restrictedStudentScope)) return null;

  return Object.fromEntries(ACCESS_SCOPE_ENTITIES.map((entity) => [
    entity,
    rows.find((row) => row.entity === entity)?.version ?? -1,
  ]));
}

export function canReadOpsEntity(context: OpsAccessContext, entity: string) {
  if (context.entityScope.size > 0 && !context.entityScope.has(entity)) return false;
  if (entity === "audit" && context.restrictedStudentScope) return false;
  if (entity === "payroll") return context.fullAdmin;
  if (context.permissions) {
    if (context.permissions.has("*")) return context.fullAdmin;
    const required = entity === "bookings" || entity === "teachers"
      ? ["operations.read", "bookings.read.assigned"]
      : ["operations.read", "students.read.assigned"];
    if (!required.some((permission) => context.permissions!.has(permission))) return false;
    if (context.fullAdmin || context.limitedAdmin) return true;
    if (context.staff) return STAFF_READ_ENTITIES.has(entity);
    if (context.teacher) return TEACHER_READ_ENTITIES.has(entity);
    return false;
  }
  if (context.fullAdmin || context.limitedAdmin) return true;
  if (context.staff) return STAFF_READ_ENTITIES.has(entity);
  if (context.teacher) return TEACHER_READ_ENTITIES.has(entity);
  return false;
}

export function canWriteOpsEntity(context: OpsAccessContext, entity: string) {
  if (entity === "audit") return false;
  if (context.entityScope.size > 0 && !context.entityScope.has(entity)) return false;
  if (entity === "payroll") return context.fullAdmin;
  if (context.permissions) {
    if (context.permissions.has("*")) return context.fullAdmin;
    const required = entity === "bookings"
      ? ["operations.write", "bookings.write.assigned"]
      : entity === "messages"
        ? ["operations.write", "messages.write.assigned"]
        : ["operations.write"];
    if (!required.some((permission) => context.permissions!.has(permission))) return false;
    if (context.fullAdmin || context.limitedAdmin) return true;
    if (context.staff) return STAFF_WRITE_ENTITIES.has(entity);
    if (context.teacher) return TEACHER_WRITE_ENTITIES.has(entity);
    return false;
  }
  if (context.fullAdmin || context.limitedAdmin) return true;
  if (context.staff) return STAFF_WRITE_ENTITIES.has(entity);
  if (context.teacher) return TEACHER_WRITE_ENTITIES.has(entity);
  return false;
}

/** Raw source snapshots and global audit-style surfaces cannot be projected safely. */
export function canReadUnrestrictedOpsData(context: OpsAccessContext) {
  if (!context.fullAdmin && !context.limitedAdmin) return false;
  if (context.restrictedStudentScope || context.entityScope.size > 0) return false;
  if (context.permissions === null) return true;
  return context.permissions.has("operations.read")
    || (context.fullAdmin && context.permissions.has("*"));
}

/**
 * Authorizes the user-facing command and then applies an explicit entity scope
 * to every projection the server-owned atomic transaction will mutate. Derived
 * projections do not grant a separate direct-write capability to the caller.
 */
export function canWriteOpsTransaction(
  context: OpsAccessContext,
  commandEntity: string,
  mutatedEntities: readonly string[],
) {
  return canWriteOpsEntity(context, commandEntity)
    && (context.entityScope.size === 0
      || mutatedEntities.every((entity) => context.entityScope.has(entity)));
}

export function canAccessStudent(context: OpsAccessContext, studentId: string) {
  return context.fullAdmin
    || (context.limitedAdmin && !context.restrictedStudentScope)
    || context.studentIds.has(studentId);
}

export function canOperateStudent(context: OpsAccessContext, studentId: string) {
  return canAccessStudent(context, studentId) && context.activeStudentIds.has(studentId);
}

function canReadRecord(context: OpsAccessContext, entity: string, value: RecordValue) {
  if (context.fullAdmin || (context.limitedAdmin && !context.restrictedStudentScope)) {
    return entity !== "payroll" || context.fullAdmin;
  }
  if (entity === "courses") return true;
  if (entity === "teachers") {
    if (context.restrictedStudentScope) return context.teacherIds.has(rowId(value));
    return context.staff || ((context.teacher || context.limitedAdmin) && context.teacherIds.has(rowId(value)));
  }
  if (entity === "students") return canAccessStudent(context, rowId(value));
  if (entity === "tasks") {
    if (managedTrialPaymentTaskIdentity(value)) {
      return context.staff
        && managedTrialPaymentTaskMatchesStudent(context, value)
        && taskAssignedTo(value, context.actor);
    }
    if (context.staff && managedExamTaskBelongsToKnownExam(context, value)) {
      if (canAccessStudent(context, rowStudentId(value))) return true;
      return managedExamTaskMatchesStudent(context, value) && taskAssignedTo(value, context.actor);
    }
    if (!canAccessStudent(context, rowStudentId(value))) return false;
    if (context.limitedAdmin) return true;
    if (context.teacher) return taskExplicitlyVisibleToTeacher(value, context.actor);
    return context.staff && taskInvolves(value, context.actor);
  }
  if (["lpItems", "renewals"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
  if (entity === "bookings") {
    if (context.limitedAdmin) return canAccessStudent(context, rowStudentId(value));
    return context.teacher
      ? bookingHasEffectiveTeacher(value, context.teacherIds)
      : canAccessStudent(context, rowStudentId(value));
  }
  if (["operations", "messages", "files"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
  return false;
}

export function filterOpsStateRows(rows: OpsStateRow[], context: OpsAccessContext) {
  return rows.flatMap((row) => {
    if (!canReadOpsEntity(context, row.entity)) return [];
    if (context.fullAdmin || (context.limitedAdmin && !context.restrictedStudentScope) || !Array.isArray(row.payload)) return [row];
    return [{ ...row, payload: row.payload.filter(isRecord).filter((value) => canReadRecord(context, row.entity, value)) }];
  });
}

/**
 * Returns only the student identity and the exact structured exams addressed
 * by a legitimate managed exam task for this staff actor. Admins do not need
 * this side channel because their regular students payload is already global.
 */
export function managedExamStudentProjections(rows: OpsStateRow[], context: OpsAccessContext): ManagedExamStudentProjection[] {
  if (!context.staff || context.fullAdmin || context.limitedAdmin || context.restrictedStudentScope) return [];
  const students = payloadRecords(rows, "students");
  const tasks = payloadRecords(rows, "tasks");
  const examIdsByStudent = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (context.studentIds.has(rowStudentId(task)) || !context.allActiveStudentIds.has(rowStudentId(task))) continue;
    if (!managedExamTaskMatchesStudent(context, task) || !taskAssignedTo(task, context.actor)) continue;
    const identity = managedExamTaskIdentity(task);
    const studentId = rowStudentId(task);
    if (!identity || !studentId) continue;
    const examIds = examIdsByStudent.get(studentId) ?? new Set<string>();
    examIds.add(identity.examId);
    examIdsByStudent.set(studentId, examIds);
  }
  return students.flatMap((student) => {
    const studentId = rowId(student);
    const examIds = examIdsByStudent.get(studentId);
    if (!studentId || !examIds) return [];
    const exams = Array.isArray(student.exams)
      ? student.exams
          .filter(isRecord)
          .filter((exam) => examIds.has(rowId(exam)))
          .map(projectManagedExamRecord)
          .filter((exam): exam is NonNullable<typeof exam> => exam !== null)
      : [];
    if (!exams.length) return [];
    return [{
      id: studentId,
      name: typeof student.name === "string" ? student.name : "",
      initials: typeof student.initials === "string" ? student.initials : "",
      owner: typeof student.owner === "string" ? student.owner : "",
      exams,
    }];
  });
}

/**
 * Builds the projection and both authority versions from the same read. Missing
 * or malformed authority rows fail closed instead of returning a misleading
 * empty projection with no freshness proof.
 */
export function managedExamStudentProjectionSnapshot(
  rows: OpsStateRow[],
  context: OpsAccessContext,
): ManagedExamProjectionSnapshot {
  const versions = Object.fromEntries(["students", "tasks"].map((entity) => {
    const row = rows.find((candidate) => candidate.entity === entity);
    if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || !Array.isArray(row.payload)) {
      throw new OpsAccessError("考试提醒权威资料不可用。");
    }
    return [entity, row.version];
  })) as { students: number; tasks: number };
  return {
    versions,
    students: managedExamStudentProjections(rows, context),
  };
}

/** Minimal identity side channel for a planner assigned to a cross-owner payment task. */
export function managedTrialPaymentStudentProjections(
  rows: OpsStateRow[],
  context: OpsAccessContext,
): ManagedTrialPaymentStudentProjection[] {
  if (!context.staff || context.fullAdmin || context.limitedAdmin || context.restrictedStudentScope) return [];
  const studentIds = new Set(payloadRecords(rows, "tasks").flatMap((task) => {
    const studentId = rowStudentId(task);
    if (context.studentIds.has(studentId)
      || !managedTrialPaymentTaskMatchesStudent(context, task)
      || !taskAssignedTo(task, context.actor)) return [];
    return [studentId];
  }));
  return payloadRecords(rows, "students").flatMap((student) => {
    const id = rowId(student);
    if (!studentIds.has(id)) return [];
    return [{
      id,
      name: typeof student.name === "string" ? student.name : "",
      initials: typeof student.initials === "string" ? student.initials : "",
    }];
  });
}

export function managedTrialPaymentStudentProjectionSnapshot(
  rows: OpsStateRow[],
  context: OpsAccessContext,
): ManagedTrialPaymentProjectionSnapshot {
  const versions = Object.fromEntries(["bookings", "students", "lpItems", "tasks"].map((entity) => {
    const row = rows.find((candidate) => candidate.entity === entity);
    if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || !Array.isArray(row.payload)) {
      throw new OpsAccessError("试听收费提醒权威资料不可用。");
    }
    return [entity, row.version];
  })) as { bookings: number; students: number; lpItems: number; tasks: number };
  return { versions, students: managedTrialPaymentStudentProjections(rows, context) };
}

export function filterOpsVersions(rows: OpsVersionRow[], context: OpsAccessContext) {
  return rows.filter((row) => canReadOpsEntity(context, row.entity));
}

function canModifyRecord(context: OpsAccessContext, entity: string, value: RecordValue) {
  if (entity === "students" && !canOperateStudent(context, rowId(value))) return false;
  if (context.fullAdmin || (context.limitedAdmin && !context.restrictedStudentScope)) {
    return entity !== "payroll" || context.fullAdmin;
  }
  if (context.limitedAdmin) {
    return entity === "students"
      ? canOperateStudent(context, rowId(value))
      : canOperateStudent(context, rowStudentId(value));
  }
  if (entity === "students") {
    return context.staff
      && samePerson(value.owner, context.actor)
      && canOperateStudent(context, rowId(value));
  }
  if (entity === "bookings") {
    return context.teacher
      ? context.teacherIds.has(rowTeacherId(value)) && canOperateStudent(context, rowStudentId(value))
      : context.staff && canOperateStudent(context, rowStudentId(value));
  }
  if (entity === "tasks") {
    return context.staff
      && canOperateStudent(context, rowStudentId(value))
      && samePerson(value.owner, context.actor);
  }
  if (["lpItems", "renewals"].includes(entity)) return canOperateStudent(context, rowStudentId(value));
  if (["operations", "messages", "files"].includes(entity)) return canOperateStudent(context, rowStudentId(value));
  return false;
}

/**
 * State is currently stored as one JSON payload per entity. For non-admin roles,
 * merge only records within the session user's scope and retain everyone else's rows.
 */
export function mergeScopedPayload(input: {
  entity: string;
  currentPayload: unknown;
  submittedPayload: unknown;
  context: OpsAccessContext;
}) {
  const { entity, currentPayload, submittedPayload, context } = input;
  if (!canWriteOpsEntity(context, entity)) throw new OpsAccessError("当前账号没有修改这部分资料的权限。");
  if (context.fullAdmin || (context.limitedAdmin && !context.restrictedStudentScope)) return submittedPayload;
  if (!Array.isArray(currentPayload) || !Array.isArray(submittedPayload)) {
    throw new OpsAccessError("当前账号只能修改已分配的资料记录。");
  }

  const current = currentPayload.filter(isRecord);
  const submitted = submittedPayload.filter(isRecord);
  if (submitted.length !== submittedPayload.length || submitted.some((value) => !rowId(value))) {
    throw new OpsAccessError("资料记录格式不正确。");
  }

  const currentById = new Map(current.map((value) => [rowId(value), value]));
  const submittedById = new Map(submitted.map((value) => [rowId(value), value]));
  const merged = current.map((existing) => {
    const replacement = submittedById.get(rowId(existing));
    if (!replacement) return existing;
    const unchanged = JSON.stringify(existing) === JSON.stringify(replacement);
    if (unchanged) return existing;
    const touchesManagedExamTask = entity === "tasks"
      && Boolean(managedExamTaskIdentity(existing) || managedExamTaskIdentity(replacement));
    const touchesManagedTrialPaymentTask = entity === "tasks"
      && Boolean(managedTrialPaymentTaskIdentity(existing) || managedTrialPaymentTaskIdentity(replacement));
    if (touchesManagedTrialPaymentTask) {
      if (context.staff
        && managedTrialPaymentTaskLifecycleChange(existing, replacement)
        && managedTrialPaymentTaskMatchesStudent(context, existing)
        && managedTrialPaymentTaskMatchesStudent(context, replacement)
        && taskAssignedTo(existing, context.actor)
        && taskAssignedTo(replacement, context.actor)) return replacement;
      throw new OpsAccessError("试听收费提醒只能通过专用确认流程完成。");
    }
    if (touchesManagedExamTask && context.staff) {
      if (managedExamCoordinatorChangeAllowed(existing, replacement, context)
        || managedExamAssigneeChangeAllowed(existing, replacement, context)) return replacement;
      throw new OpsAccessError("不能修改未分配给当前账号的资料。");
    }
    if (!canModifyRecord(context, entity, existing) || !canModifyRecord(context, entity, replacement)) {
      throw new OpsAccessError("不能修改未分配给当前账号的资料。");
    }
    return replacement;
  });

  for (const replacement of submitted) {
    if (currentById.has(rowId(replacement))) continue;
    const managedExamIdentity = entity === "tasks" && managedExamTaskIdentity(replacement);
    if (entity === "tasks" && managedTrialPaymentTaskIdentity(replacement)) {
      throw new OpsAccessError("试听收费提醒只能由权威排课或定时流程创建。");
    }
    const managedExamCreate = entity === "tasks"
      && context.staff
      && canOperateStudent(context, rowStudentId(replacement))
      && managedExamTaskMatchesStudent(context, replacement);
    if (entity === "students"
      || (managedExamIdentity ? !managedExamCreate : !canModifyRecord(context, entity, replacement))) {
      throw new OpsAccessError("不能新增未分配给当前账号的资料。");
    }
    merged.push(replacement);
  }

  return merged;
}

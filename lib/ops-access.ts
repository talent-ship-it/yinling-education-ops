import {
  DEMO_LIMITED_ADMIN_USER,
  isDemoStaff,
  type DemoUser,
} from "@/lib/demo-users";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import { EXAM_RULE_NO_LONGER_APPLICABLE_RESULT } from "@/lib/exam-tasks";
import type { OpsStateRow, OpsVersionRow } from "@/lib/ops-store";

type RecordValue = Record<string, unknown>;

export type OpsAccessContext = {
  actor: DemoUser;
  role: DemoSessionRole;
  fullAdmin: boolean;
  limitedAdmin: boolean;
  staff: boolean;
  teacher: boolean;
  studentIds: Set<string>;
  activeStudentIds: Set<string>;
  /** Server-only scope facts used to authorize a managed task without exposing its student row. */
  allActiveStudentIds: Set<string>;
  studentOwnerById: Map<string, string>;
  studentPlannerById: Map<string, string>;
  studentExamIdsById: Map<string, Set<string>>;
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

function managedExamTaskIdentity(value: RecordValue) {
  if (value.category !== "考试" || typeof value.ruleKey !== "string" || typeof value.anchorBookingId !== "string") return false;
  const match = value.ruleKey.match(/^exam:([^:]+):(care|recall|results)$/);
  if (!match || value.anchorBookingId !== `exam:${match[1]}`) return false;
  return { examId: match[1], suffix: match[2] as "care" | "recall" | "results" };
}

function isConfiguredRecipient(value: string | undefined) {
  const recipient = value?.trim();
  return Boolean(recipient && !/^(?:待分配|待确认|未知|角色待配置[:：])/.test(recipient));
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
  if (!identity || !managedExamTaskBelongsToKnownExam(context, value)) return false;
  const expectedOwner = identity.suffix === "results"
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
  signedRole?: DemoSessionRole,
): OpsAccessContext {
  const limitedAdmin = actor === DEMO_LIMITED_ADMIN_USER;
  const staff = signedRole ? signedRole === "staff" : isDemoStaff(actor);
  const teacher = signedRole ? signedRole === "teacher" : teachersIncludeActor(rows, actor);
  const role: DemoSessionRole = fullAdmin
    ? "admin"
    : limitedAdmin
      ? "limited-admin"
      : teacher
        ? "teacher"
        : "staff";

  const teachers = payloadRecords(rows, "teachers");
  const teacherIds = new Set(teachers.filter((item) => samePerson(item.name, actor)).map(rowId).filter(Boolean));
  const bookings = payloadRecords(rows, "bookings");
  const students = payloadRecords(rows, "students");
  const studentIds = new Set(
    students
      .filter((student) => {
        if (fullAdmin || limitedAdmin) return true;
        if (staff) return samePerson(student.owner, actor);
        if (!teacher) return false;
        return samePerson(student.teacher, actor)
          || bookings.some((booking) => teacherIds.has(String(booking.teacherId ?? "")) && booking.studentId === student.id);
      })
      .map(rowId)
      .filter(Boolean),
  );
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

  return {
    actor,
    role,
    fullAdmin,
    limitedAdmin,
    staff,
    teacher,
    studentIds,
    activeStudentIds,
    allActiveStudentIds,
    studentOwnerById,
    studentPlannerById,
    studentExamIdsById,
    teacherIds,
  };
}

/**
 * Scoped access is derived from these three payloads. Their versions travel with
 * every scoped write so the database can reject a request if assignment changed
 * after the page was loaded.
 */
export function getAccessScopeVersions(rows: OpsStateRow[], context: OpsAccessContext) {
  if (context.fullAdmin || context.limitedAdmin) return null;

  return Object.fromEntries(ACCESS_SCOPE_ENTITIES.map((entity) => [
    entity,
    rows.find((row) => row.entity === entity)?.version ?? -1,
  ]));
}

export function canReadOpsEntity(context: OpsAccessContext, entity: string) {
  if (entity === "payroll") return context.fullAdmin;
  if (context.fullAdmin || context.limitedAdmin) return true;
  if (context.staff) return STAFF_READ_ENTITIES.has(entity);
  if (context.teacher) return TEACHER_READ_ENTITIES.has(entity);
  return false;
}

export function canWriteOpsEntity(context: OpsAccessContext, entity: string) {
  if (entity === "audit") return false;
  if (entity === "payroll") return context.fullAdmin;
  if (context.fullAdmin || context.limitedAdmin) return true;
  if (context.staff) return STAFF_WRITE_ENTITIES.has(entity);
  if (context.teacher) return TEACHER_WRITE_ENTITIES.has(entity);
  return false;
}

export function canAccessStudent(context: OpsAccessContext, studentId: string) {
  return context.fullAdmin || context.limitedAdmin || context.studentIds.has(studentId);
}

export function canOperateStudent(context: OpsAccessContext, studentId: string) {
  return canAccessStudent(context, studentId) && context.activeStudentIds.has(studentId);
}

function canReadRecord(context: OpsAccessContext, entity: string, value: RecordValue) {
  if (context.fullAdmin || context.limitedAdmin) return entity !== "payroll" || context.fullAdmin;
  if (entity === "courses") return true;
  if (entity === "teachers") return context.staff || (context.teacher && context.teacherIds.has(rowId(value)));
  if (entity === "students") return canAccessStudent(context, rowId(value));
  if (entity === "tasks") {
    if (context.staff && managedExamTaskBelongsToKnownExam(context, value)) {
      if (canAccessStudent(context, rowStudentId(value))) return true;
      return managedExamTaskMatchesStudent(context, value) && taskAssignedTo(value, context.actor);
    }
    if (!canAccessStudent(context, rowStudentId(value))) return false;
    if (context.teacher) return taskExplicitlyVisibleToTeacher(value, context.actor);
    return context.staff && taskInvolves(value, context.actor);
  }
  if (["lpItems", "renewals"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
  if (entity === "bookings") {
    return context.teacher
      ? context.teacherIds.has(String(value.teacherId ?? ""))
      : canAccessStudent(context, rowStudentId(value));
  }
  if (["operations", "messages", "files"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
  return false;
}

export function filterOpsStateRows(rows: OpsStateRow[], context: OpsAccessContext) {
  return rows.flatMap((row) => {
    if (!canReadOpsEntity(context, row.entity)) return [];
    if (context.fullAdmin || context.limitedAdmin || !Array.isArray(row.payload)) return [row];
    return [{ ...row, payload: row.payload.filter(isRecord).filter((value) => canReadRecord(context, row.entity, value)) }];
  });
}

export function filterOpsVersions(rows: OpsVersionRow[], context: OpsAccessContext) {
  return rows.filter((row) => canReadOpsEntity(context, row.entity));
}

function canModifyRecord(context: OpsAccessContext, entity: string, value: RecordValue) {
  if (entity === "students" && !canOperateStudent(context, rowId(value))) return false;
  if (context.fullAdmin || context.limitedAdmin) return entity !== "payroll" || context.fullAdmin;
  if (entity === "students") {
    return context.staff
      && samePerson(value.owner, context.actor)
      && canOperateStudent(context, rowId(value));
  }
  if (entity === "bookings") {
    return context.teacher
      ? context.teacherIds.has(String(value.teacherId ?? "")) && canOperateStudent(context, rowStudentId(value))
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
  if (context.fullAdmin || context.limitedAdmin) return submittedPayload;
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

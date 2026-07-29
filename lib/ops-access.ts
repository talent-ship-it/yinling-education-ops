import {
  DEMO_LIMITED_ADMIN_USER,
  isDemoStaff,
  isDemoTeacher,
  type DemoUser,
} from "@/lib/demo-users";
import type { OpsStateRow, OpsVersionRow } from "@/lib/ops-store";

type RecordValue = Record<string, unknown>;

export type OpsAccessContext = {
  actor: DemoUser;
  fullAdmin: boolean;
  limitedAdmin: boolean;
  staff: boolean;
  teacher: boolean;
  studentIds: Set<string>;
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
const TEACHER_WRITE_ENTITIES = new Set(["tasks", "bookings", "messages", "files"]);

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

function rowStudentId(value: RecordValue) {
  return typeof value.studentId === "string" ? value.studentId : "";
}

function rowId(value: RecordValue) {
  return typeof value.id === "string" ? value.id : "";
}

export function buildOpsAccessContext(rows: OpsStateRow[], actor: DemoUser, fullAdmin: boolean): OpsAccessContext {
  const limitedAdmin = actor === DEMO_LIMITED_ADMIN_USER;
  const staff = isDemoStaff(actor);
  const teacher = isDemoTeacher(actor);

  if (fullAdmin || limitedAdmin) {
    return { actor, fullAdmin, limitedAdmin, staff, teacher, studentIds: new Set(), teacherIds: new Set() };
  }

  const teachers = payloadRecords(rows, "teachers");
  const teacherIds = new Set(teachers.filter((item) => samePerson(item.name, actor)).map(rowId).filter(Boolean));
  const bookings = payloadRecords(rows, "bookings");
  const students = payloadRecords(rows, "students");
  const studentIds = new Set(
    students
      .filter((student) => {
        if (staff) return samePerson(student.owner, actor);
        if (!teacher) return false;
        return samePerson(student.teacher, actor)
          || bookings.some((booking) => teacherIds.has(String(booking.teacherId ?? "")) && booking.studentId === student.id);
      })
      .map(rowId)
      .filter(Boolean),
  );

  return { actor, fullAdmin, limitedAdmin, staff, teacher, studentIds, teacherIds };
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

function canReadRecord(context: OpsAccessContext, entity: string, value: RecordValue) {
  if (context.fullAdmin || context.limitedAdmin) return entity !== "payroll" || context.fullAdmin;
  if (entity === "courses") return true;
  if (entity === "teachers") return context.staff || (context.teacher && context.teacherIds.has(rowId(value)));
  if (entity === "students") return canAccessStudent(context, rowId(value));
  if (["tasks", "lpItems", "renewals"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
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
  if (context.fullAdmin || context.limitedAdmin) return entity !== "payroll" || context.fullAdmin;
  if (entity === "students") return context.staff && samePerson(value.owner, context.actor) && Boolean(rowId(value));
  if (entity === "bookings") {
    return context.teacher
      ? context.teacherIds.has(String(value.teacherId ?? "")) && canAccessStudent(context, rowStudentId(value))
      : context.staff && canAccessStudent(context, rowStudentId(value));
  }
  if (["tasks", "lpItems", "renewals"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
  if (["operations", "messages", "files"].includes(entity)) return canAccessStudent(context, rowStudentId(value));
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
    if (!canModifyRecord(context, entity, existing) || !canModifyRecord(context, entity, replacement)) {
      throw new OpsAccessError("不能修改未分配给当前账号的资料。");
    }
    return replacement;
  });

  for (const replacement of submitted) {
    if (currentById.has(rowId(replacement))) continue;
    if (entity === "students" || !canModifyRecord(context, entity, replacement)) {
      throw new OpsAccessError("不能新增未分配给当前账号的资料。");
    }
    merged.push(replacement);
  }

  return merged;
}

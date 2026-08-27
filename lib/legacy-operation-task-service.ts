import type { OpsStateRow } from "@/lib/ops-store";

type Value = Record<string, unknown>;
const COMMAND = /^operation-task-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = new Set(["学生请假", "停课", "换老师"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function record(value: unknown): value is Value { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function required(value: unknown, field: string, max: number) { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new LegacyOperationTaskError("invalid_request", `${field} is invalid.`); return value.trim(); }
function id(value: unknown, field: string) { const result = required(value, field, 120); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(result)) throw new LegacyOperationTaskError("invalid_request", `${field} is invalid.`); return result; }
function date(value: unknown, field: string) { const result = required(value, field, 10); if (!DATE.test(result) || Number.isNaN(new Date(`${result}T00:00:00Z`).valueOf())) throw new LegacyOperationTaskError("invalid_request", `${field} is invalid.`); return result; }
function version(value: unknown, field: string) { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new LegacyOperationTaskError("invalid_request", `${field} is invalid.`); return value as number; }
export type LegacyOperationTaskCommand = Readonly<{ commandKey: string; type: "学生请假" | "停课" | "换老师"; detail: string; studentId?: string; teacherId?: string; eventStart: string; eventEnd: string; sourceBookingId?: string; expectedVersions: Readonly<{ bookings: number; operations: number; students: number; tasks: number; teachers: number }> }>;
export class LegacyOperationTaskError extends Error { constructor(readonly code: "invalid_request" | "invalid_shared_state" | "no_affected_occurrences", message: string) { super(message); this.name = "LegacyOperationTaskError"; } }
export type PreparedLegacyOperationTask = Readonly<{ commandKey: string; commandIntent: Readonly<Record<string, unknown>>; expectedVersions: LegacyOperationTaskCommand["expectedVersions"]; type: LegacyOperationTaskCommand["type"]; detail: string; studentId?: string; teacherId?: string; eventStart: string; eventEnd: string; sourceBookingId?: string }>;

export function parseLegacyOperationTaskCommand(value: unknown): LegacyOperationTaskCommand {
  if (!record(value)) throw new LegacyOperationTaskError("invalid_request", "Legacy operation command is missing.");
  const allowed = new Set(["commandKey", "type", "detail", "studentId", "teacherId", "eventStart", "eventEnd", "sourceBookingId", "expectedVersions"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new LegacyOperationTaskError("invalid_request", "Only reviewed operation command fields may be submitted.");
  const commandKey = required(value.commandKey, "commandKey", 100); if (!COMMAND.test(commandKey)) throw new LegacyOperationTaskError("invalid_request", "commandKey is invalid.");
  const type = required(value.type, "type", 20) as LegacyOperationTaskCommand["type"]; if (!TYPES.has(type)) throw new LegacyOperationTaskError("invalid_request", "type is invalid.");
  const eventStart = date(value.eventStart, "eventStart"); const eventEnd = date(value.eventEnd, "eventEnd"); if (eventStart > eventEnd) throw new LegacyOperationTaskError("invalid_request", "eventStart must not be after eventEnd.");
  if (!record(value.expectedVersions) || Object.keys(value.expectedVersions).some((key) => !["bookings", "operations", "students", "tasks", "teachers"].includes(key))) throw new LegacyOperationTaskError("invalid_request", "expectedVersions is invalid.");
  const command: LegacyOperationTaskCommand = { commandKey, type, detail: required(value.detail, "detail", 2000), eventStart, eventEnd, expectedVersions: {
    bookings: version(value.expectedVersions.bookings, "expectedVersions.bookings"),
    operations: version(value.expectedVersions.operations, "expectedVersions.operations"),
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
    teachers: version(value.expectedVersions.teachers, "expectedVersions.teachers"),
  },
    ...(value.studentId !== undefined ? { studentId: id(value.studentId, "studentId") } : {}), ...(value.teacherId !== undefined ? { teacherId: id(value.teacherId, "teacherId") } : {}), ...(value.sourceBookingId !== undefined ? { sourceBookingId: id(value.sourceBookingId, "sourceBookingId") } : {}) };
  if ((type === "学生请假" || type === "停课") && !command.studentId) throw new LegacyOperationTaskError("invalid_request", "studentId is required for student leave.");
  if (type === "换老师" && (!command.studentId || !command.teacherId)) throw new LegacyOperationTaskError("invalid_request", "studentId and teacherId are required for teacher replacement.");
  return command;
}
export function legacyOperationTaskIntent(command: LegacyOperationTaskCommand) { return { type: command.type, detail: command.detail, ...(command.studentId ? { studentId: command.studentId } : {}), ...(command.teacherId ? { teacherId: command.teacherId } : {}), eventStart: command.eventStart, eventEnd: command.eventEnd, ...(command.sourceBookingId ? { sourceBookingId: command.sourceBookingId } : {}) }; }

function row(rows: readonly OpsStateRow[], entity: string) { const found = rows.find((candidate) => candidate.entity === entity); if (!found || !Number.isSafeInteger(found.version) || found.version < 1 || !Array.isArray(found.payload)) throw new LegacyOperationTaskError("invalid_shared_state", `${entity} shared state is unavailable.`); return found.payload as Value[]; }

/**
 * The service is intentionally a semantic parser only.  Recurrence,
 * occurrence overrides, candidate teachers, scope and task deadlines belong
 * to the same database statement as the operations/tasks write.  Keeping no
 * client-derived rows here prevents a stale browser snapshot from becoming a
 * second authority.
 */
export function prepareLegacyOperationTask(command: LegacyOperationTaskCommand, rows: readonly OpsStateRow[], actor: string): PreparedLegacyOperationTask {
  // The route authenticates and scope-checks this signed actor before calling
  // the semantic parser; keep the argument explicit for that contract even
  // though database authority performs the actual actor-bound projection.
  void actor;
  for (const entity of ["bookings", "operations", "students", "tasks", "teachers"] as const) row(rows, entity);
  return { commandKey: command.commandKey, commandIntent: legacyOperationTaskIntent(command), expectedVersions: command.expectedVersions, type: command.type, detail: command.detail, eventStart: command.eventStart, eventEnd: command.eventEnd,
    ...(command.studentId ? { studentId: command.studentId } : {}), ...(command.teacherId ? { teacherId: command.teacherId } : {}), ...(command.sourceBookingId ? { sourceBookingId: command.sourceBookingId } : {}) };
}

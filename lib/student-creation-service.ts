import { createHash } from "node:crypto";

import type { OpsStateRow } from "@/lib/ops-store";
import { displayTimezoneOptions } from "@/lib/display-preferences";
import { resolveStudentDisplayName } from "@/lib/student-intake";
import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, DEMO_STAFF_USERS, isRetiredOperationsIdentity, normaliseDemoUserName } from "@/lib/demo-users";

type Value = Record<string, unknown>;
const COMMAND = /^student-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = new Set(["name", "course", "segment", "guardianWechat", "lpNeed", "owner", "planner", "grade", "location", "timezone", "notes", "remainingHours"]);
const VERSION_FIELDS = new Set(["students", "tasks"]);
export type StudentCreationFields = Readonly<{
  name: string; course: string; segment: "试听" | "已报名"; guardianWechat: string;
  lpNeed: "待确认" | "无需LP" | "试听LP" | "新生LP" | "老生新LP" | "代课LP" | "LP修改";
  owner: string; planner: string; grade: string; location: string; timezone: string; notes: string;
  remainingHours?: number;
}>;
export type StudentCreationCommand = Readonly<{
  commandKey: string; studentFields: StudentCreationFields; expectedVersions: Readonly<{ students: number; tasks: number }>;
}>;
export type PreparedStudentCreation = Readonly<{
  commandKey: string; commandIntent: Readonly<Record<string, unknown>>; studentFields: StudentCreationFields;
  expectedVersions: StudentCreationCommand["expectedVersions"];
}>;

export class StudentCreationError extends Error {
  constructor(readonly code: "invalid_request" | "client_fields_forbidden" | "invalid_shared_state" | "scope_forbidden", message: string) { super(message); this.name = "StudentCreationError"; }
}
function fail(code: StudentCreationError["code"], message: string): never { throw new StudentCreationError(code, message); }
function record(value: unknown): value is Value { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, field: string, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail("invalid_request", `${field} is invalid.`);
  return value.trim();
}
function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid_request", `${field} must be a positive state version.`);
  return value as number;
}
const allowedOwners = new Set<string>([DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, ...DEMO_STAFF_USERS]);
const allowedPlanners = new Set(["待分配", "Tara", "Eileen"]);
const allowedTimezones = new Set<string>(displayTimezoneOptions.map((option) => option.id));

export function parseStudentCreationCommand(value: unknown): StudentCreationCommand {
  if (!record(value)) fail("invalid_request", "Student-creation command is missing.");
  if (Object.keys(value).some((key) => !["commandKey", "studentFields", "expectedVersions"].includes(key))) fail("client_fields_forbidden", "Only the reviewed student-creation command fields may be submitted.");
  const commandKey = text(value.commandKey, "commandKey", 100);
  if (!COMMAND.test(commandKey)) fail("invalid_request", "commandKey is invalid.");
  if (!record(value.studentFields)) fail("invalid_request", "studentFields is required.");
  if (Object.keys(value.studentFields).some((key) => !FIELDS.has(key))) fail("client_fields_forbidden", "studentFields contains an unsupported field.");
  const segment = text(value.studentFields.segment, "studentFields.segment", 20) as StudentCreationFields["segment"];
  const lpNeed = text(value.studentFields.lpNeed, "studentFields.lpNeed", 20) as StudentCreationFields["lpNeed"];
  if (!(new Set(["试听", "已报名"]) as Set<string>).has(segment)) fail("invalid_request", "studentFields.segment is invalid.");
  if (!(new Set(["待确认", "无需LP", "试听LP", "新生LP", "老生新LP", "代课LP", "LP修改"]) as Set<string>).has(lpNeed)) fail("invalid_request", "studentFields.lpNeed is invalid.");
  const fields: StudentCreationFields = {
    name: typeof value.studentFields.name === "string" ? value.studentFields.name.trim() : "", course: text(value.studentFields.course, "studentFields.course", 240), segment,
    guardianWechat: typeof value.studentFields.guardianWechat === "string" ? value.studentFields.guardianWechat.trim() : "",
    lpNeed, owner: text(value.studentFields.owner, "studentFields.owner", 120), planner: text(value.studentFields.planner, "studentFields.planner", 120),
    grade: text(value.studentFields.grade, "studentFields.grade", 120), location: text(value.studentFields.location, "studentFields.location", 120),
    timezone: text(value.studentFields.timezone, "studentFields.timezone", 100), notes: typeof value.studentFields.notes === "string" ? value.studentFields.notes.trim() : "无特殊备注",
    ...(value.studentFields.remainingHours === undefined ? {} : { remainingHours: value.studentFields.remainingHours as number }),
  };
  if (fields.name.length > 240 || fields.guardianWechat.length > 240 || fields.notes.length > 4000) fail("invalid_request", "studentFields text is too long.");
  if (fields.remainingHours !== undefined && (!Number.isFinite(fields.remainingHours) || fields.remainingHours < 0)) fail("invalid_request", "studentFields.remainingHours is invalid.");
  if (!record(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  if (Object.keys(value.expectedVersions).some((key) => !VERSION_FIELDS.has(key))) fail("client_fields_forbidden", "expectedVersions contains an unsupported entity.");
  return { commandKey, studentFields: fields, expectedVersions: { students: version(value.expectedVersions.students, "expectedVersions.students"), tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks") } };
}

export function studentCreationIntent(command: Pick<StudentCreationCommand, "studentFields" | "expectedVersions">) {
  return { studentFields: command.studentFields, expectedVersions: command.expectedVersions };
}

/**
 * Canonicalize only the semantic command. This deliberately has no current
 * role, owner-scope, or shared-state dependency, so an already-committed
 * command can be replayed after those mutable facts drift.
 */
export function canonicalizeStudentCreationCommand(command: StudentCreationCommand): StudentCreationCommand {
  const resolved = resolveStudentDisplayName({ segment: command.studentFields.segment, name: command.studentFields.name, guardianWechat: command.studentFields.guardianWechat });
  if (!resolved.ok) fail("invalid_request", resolved.message);
  if (!allowedTimezones.has(command.studentFields.timezone)) fail("invalid_request", "studentFields.timezone is not an approved display timezone.");
  if (!allowedOwners.has(command.studentFields.owner)) fail("invalid_request", "studentFields.owner is not an approved operations owner.");
  if (!allowedPlanners.has(command.studentFields.planner)) fail("invalid_request", "studentFields.planner is not an approved planner.");
  return { ...command, studentFields: { ...command.studentFields, name: resolved.displayName, guardianWechat: resolved.guardianWechat ?? "" } };
}

/** Apply mutable current actor/owner authorization only on a ledger miss. */
export function authorizeStudentCreationCommand(command: StudentCreationCommand, actor: string, elevated: boolean): StudentCreationCommand {
  if (isRetiredOperationsIdentity(command.studentFields.owner)) {
    fail("scope_forbidden", "已归档账号不能接收新学生，请选择在职负责人。");
  }
  if (!elevated && normaliseDemoUserName(command.studentFields.owner) !== normaliseDemoUserName(actor)) {
    fail("scope_forbidden", "教务账号只能为自己负责的学生建档。");
  }
  return command;
}

/** Backwards-compatible combined helper for existing non-replay callers/tests. */
export function normalizeStudentCreationCommand(command: StudentCreationCommand, actor: string, elevated: boolean): StudentCreationCommand {
  return authorizeStudentCreationCommand(canonicalizeStudentCreationCommand(command), actor, elevated);
}

export function prepareStudentCreation(command: StudentCreationCommand, rows: readonly OpsStateRow[]): PreparedStudentCreation {
  for (const entity of ["students", "tasks"] as const) {
    const row = rows.find((candidate) => candidate.entity === entity);
    if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || !Array.isArray(row.payload)) fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  return { commandKey: command.commandKey, commandIntent: studentCreationIntent(command), studentFields: command.studentFields, expectedVersions: command.expectedVersions };
}

export function deterministicStudentId(commandKey: string) { return `STU-${createHash("sha256").update(commandKey).digest("hex").slice(0, 24)}`; }

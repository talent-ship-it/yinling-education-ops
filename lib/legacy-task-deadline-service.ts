import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER } from "@/lib/demo-users";
import { hasAutomaticTaskDeadline } from "@/lib/ops-tasks";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";

type RecordValue = Record<string, unknown>;

const COMMAND_FIELDS = new Set([
  "commandKey",
  "action",
  "taskId",
  "melbourneDateTime",
  "expectedVersions",
]);
const VERSION_FIELDS = new Set(["students", "tasks"]);
const COMMAND_KEY_PATTERN = /^legacy-task-deadline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MELBOURNE_DATE_TIME_PATTERN = /^([1-9]\d{3})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const MELBOURNE_TIME_ZONE = "Australia/Melbourne";

export type LegacyTaskDeadlineAction = "set" | "clear";

/**
 * The browser submits a Melbourne wall-clock value, never a UTC instant. The
 * route converts and validates it on the server before the database repeats
 * the same validation under its row locks.
 */
type LegacyTaskDeadlineCommandBase = Readonly<{
  commandKey: string;
  taskId: string;
  expectedVersions: Readonly<{ students: number; tasks: number }>;
}>;

export type LegacyTaskDeadlineSetCommand = LegacyTaskDeadlineCommandBase & Readonly<{
  action: "set";
  melbourneDateTime: string;
}>;

/** Accepted only so an already-committed historical clear can replay its receipt. */
export type LegacyTaskDeadlineClearReplayCommand = LegacyTaskDeadlineCommandBase & Readonly<{
  action: "clear";
}>;

export type LegacyTaskDeadlineCommand =
  | LegacyTaskDeadlineSetCommand
  | LegacyTaskDeadlineClearReplayCommand;

export type LegacyTaskDeadlineSetIntent = Readonly<{
  action: "set";
  taskId: string;
  melbourneDateTime: string;
}>;

export type LegacyTaskDeadlineClearReplayIntent = Readonly<{
  action: "clear";
  taskId: string;
}>;

export type LegacyTaskDeadlineIntent =
  | LegacyTaskDeadlineSetIntent
  | LegacyTaskDeadlineClearReplayIntent;

export type PreparedLegacyTaskDeadline = Readonly<{
  commandKey: string;
  commandIntent: LegacyTaskDeadlineSetIntent;
  action: "set";
  taskId: string;
  melbourneDateTime: string;
  dueAt: string;
  expectedVersions: LegacyTaskDeadlineSetCommand["expectedVersions"];
}>;

export type LegacyTaskDeadlineServiceErrorCode =
  | "invalid_request"
  | "clear_disabled"
  | "client_fields_forbidden"
  | "admin_forbidden"
  | "teacher_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "task_not_found"
  | "task_not_legacy"
  | "task_closed"
  | "archived_student_read_only"
  | "melbourne_time_invalid"
  | "melbourne_time_nonexistent"
  | "melbourne_time_ambiguous";

export class LegacyTaskDeadlineServiceError extends Error {
  constructor(
    readonly code: LegacyTaskDeadlineServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: LegacyTaskDeadlineServiceErrorCode, message: string): never {
  throw new LegacyTaskDeadlineServiceError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("invalid_request", `${field} 无效。`);
  }
  return value.trim();
}

function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid_request", `${field} 必须是正整数版本号。`);
  }
  return value as number;
}

function assertOnlyFields(value: RecordValue, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail("client_fields_forbidden", "截止时间命令只接受已审核的任务、操作、时间和版本字段。");
  }
}

function localMinuteFormatter() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

const MELBOURNE_LOCAL_MINUTE_FORMATTER = localMinuteFormatter();

function localMinuteKey(value: Date) {
  const parts = Object.fromEntries(
    MELBOURNE_LOCAL_MINUTE_FORMATTER
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function assertCalendarMinute(match: RegExpMatchArray) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute) {
    fail("melbourne_time_invalid", "截止日期或时间不存在。请检查日期和时间后重试。");
  }
  return calendar.getTime();
}

/**
 * Resolves one exact Australia/Melbourne wall-clock minute. The scan makes
 * both DST gaps and repeated local times explicit instead of silently taking
 * a browser/runtime-specific offset.
 */
export function melbourneDateTimeToUtc(value: string) {
  const match = value.match(MELBOURNE_DATE_TIME_PATTERN);
  if (!match) {
    fail("melbourne_time_invalid", "请选择准确的墨尔本截止日期和时间。");
  }
  const wallClock = assertCalendarMinute(match);
  const candidates: Date[] = [];
  const minute = 60_000;
  // Melbourne offsets stay inside this window. Minute steps also make this
  // strict for the datetime-local control's minute precision.
  for (let instant = wallClock - 16 * 60 * minute; instant <= wallClock + 16 * 60 * minute; instant += minute) {
    const candidate = new Date(instant);
    if (localMinuteKey(candidate) === value) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    fail("melbourne_time_nonexistent", "该墨尔本本地时间因夏令时切换不存在，请选择其他时间。");
  }
  if (candidates.length !== 1) {
    fail("melbourne_time_ambiguous", "该墨尔本本地时间因夏令时切换出现两次，请选择其他时间。");
  }
  return candidates[0]!;
}

export function hasLegacyTaskDeadlineAdminAccess(actor: string | null, fullAdmin: boolean) {
  return actor === DEMO_LIMITED_ADMIN_USER || (actor === DEMO_ADMIN_USER && fullAdmin);
}

export function parseLegacyTaskDeadlineCommand(value: unknown): LegacyTaskDeadlineCommand {
  if (!isRecord(value)) fail("invalid_request", "截止时间命令无效。");
  assertOnlyFields(value, COMMAND_FIELDS);
  const commandKey = requiredText(value.commandKey, "commandKey", 96);
  if (!COMMAND_KEY_PATTERN.test(commandKey)) fail("invalid_request", "commandKey 无效。");
  if (value.action !== "set" && value.action !== "clear") {
    fail("invalid_request", "action 必须是 set 或历史 clear 重试。");
  }
  const taskId = requiredText(value.taskId, "taskId");
  if (!ID_PATTERN.test(taskId)) fail("invalid_request", "taskId 无效。");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions 缺失。");
  assertOnlyFields(value.expectedVersions, VERSION_FIELDS);
  const expectedVersions = {
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
  };
  if (value.action === "clear") {
    if (value.melbourneDateTime !== undefined) {
      fail("client_fields_forbidden", "历史 clear 重试不能附带新的日期或时间。");
    }
    return {
      commandKey,
      action: "clear",
      taskId,
      expectedVersions,
    };
  }
  const melbourneDateTime = requiredText(value.melbourneDateTime, "melbourneDateTime", 16);
  if (!MELBOURNE_DATE_TIME_PATTERN.test(melbourneDateTime)) {
    fail("invalid_request", "设置截止时间必须提供准确的墨尔本日期和时间。");
  }
  // Validate user-facing DST failures before any state read/write. The SQL
  // command independently repeats this exact safe conversion under lock.
  melbourneDateTimeToUtc(melbourneDateTime);
  return {
    commandKey,
    action: "set",
    taskId,
    expectedVersions,
    melbourneDateTime,
  };
}

export function legacyTaskDeadlineIntent(command: LegacyTaskDeadlineSetCommand): LegacyTaskDeadlineSetIntent;
export function legacyTaskDeadlineIntent(command: LegacyTaskDeadlineClearReplayCommand): LegacyTaskDeadlineClearReplayIntent;
export function legacyTaskDeadlineIntent(command: LegacyTaskDeadlineCommand): LegacyTaskDeadlineIntent;
export function legacyTaskDeadlineIntent(command: LegacyTaskDeadlineCommand): LegacyTaskDeadlineIntent {
  if (command.action === "clear") {
    return { action: "clear", taskId: command.taskId };
  }
  return {
    action: "set",
    taskId: command.taskId,
    melbourneDateTime: command.melbourneDateTime,
  };
}

/** New clear commands are forbidden after the historical receipt lookup. */
export function assertLegacyTaskDeadlineSetCommand(
  command: LegacyTaskDeadlineCommand,
): asserts command is LegacyTaskDeadlineSetCommand {
  if (command.action === "clear") {
    fail("clear_disabled", "准确截止时间只能修改，不能清除。");
  }
}

function payloadRow(rows: readonly OpsStateRow[], entity: "students" | "tasks") {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1
    || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
    fail("invalid_shared_state", `${entity} 共享资料不可用。`);
  }
  const ids = row.payload.map((item) => typeof item.id === "string" ? item.id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("invalid_shared_state", `${entity} 共享资料含有重复或缺失的 ID。`);
  }
  return { ...row, payload: row.payload as RecordValue[] };
}

function legacyTask(rows: readonly OpsStateRow[], taskId: string) {
  const students = payloadRow(rows, "students");
  const tasks = payloadRow(rows, "tasks");
  const task = tasks.payload.find((item) => item.id === taskId);
  if (!task) fail("task_not_found", "没有找到该任务，请刷新后重试。");
  if (hasAutomaticTaskDeadline(task)) {
    fail("task_not_legacy", "系统规则任务的截止时间不能在这里手动修改。");
  }
  if (task.status === "done") {
    fail("task_closed", "已完成任务不能补写或调整截止时间。");
  }
  if (typeof task.studentId !== "string" || !task.studentId.trim()) {
    fail("invalid_shared_state", "任务缺少有效学生关联。");
  }
  const student = students.payload.find((item) => item.id === task.studentId);
  if (student?.importArchived === true) {
    fail("archived_student_read_only", "历史归档学生的任务不能修改。");
  }
  return { task, students, tasks };
}

/** Authorizes a command against the latest state without requiring fresh OCC. */
export function authorizeLegacyTaskDeadlineCommand(input: {
  command: LegacyTaskDeadlineCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  fullAdmin: boolean;
}) {
  if (!hasLegacyTaskDeadlineAdminAccess(input.actor, input.fullAdmin)) {
    fail(input.role === "teacher" ? "teacher_forbidden" : "admin_forbidden", "只有教务管理员可以补写历史任务的截止时间。");
  }
  return legacyTask(input.rows, input.command.taskId);
}

/**
 * Derives the only accepted command intent from the server's state snapshot.
 * It intentionally never sends a browser-provided tasks projection to SQL.
 */
export function prepareLegacyTaskDeadline(input: {
  command: LegacyTaskDeadlineSetCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  fullAdmin: boolean;
}): PreparedLegacyTaskDeadline {
  const identity = authorizeLegacyTaskDeadlineCommand(input);
  if (identity.students.version !== input.command.expectedVersions.students
    || identity.tasks.version !== input.command.expectedVersions.tasks) {
    fail("stale_expected_version", "学生或任务资料刚刚发生变化，请刷新后重试。");
  }
  const dueAt = melbourneDateTimeToUtc(input.command.melbourneDateTime).toISOString();
  return {
    commandKey: input.command.commandKey,
    commandIntent: legacyTaskDeadlineIntent(input.command),
    action: input.command.action,
    taskId: input.command.taskId,
    melbourneDateTime: input.command.melbourneDateTime,
    dueAt,
    expectedVersions: input.command.expectedVersions,
  };
}

/** UI/server convenience: only the deliberately unbound legacy cohort may edit. */
export function isLegacyTaskDeadlineEditable(task: RecordValue) {
  return !hasAutomaticTaskDeadline(task)
    && task.status !== "done";
}

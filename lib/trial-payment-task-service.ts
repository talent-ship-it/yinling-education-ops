import type { DemoSessionRole } from "@/lib/demo-session-token";
import {
  isManagedTrialPaymentTaskRecipient,
  managedTrialPaymentTaskKind,
} from "@/lib/managed-trial-payment";
import type { OpsStateRow } from "@/lib/ops-store";

type RecordValue = Record<string, unknown>;

const COMMAND_PATTERN = /^trial-payment-complete:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_ENTITIES = ["bookings", "students", "lpItems", "tasks", "teachers"] as const;

export type TrialPaymentCompletionCommand = Readonly<{
  commandKey: string;
  taskId: string;
  expectedVersions: Readonly<Record<(typeof VERSION_ENTITIES)[number], number>>;
}>;

export class TrialPaymentTaskServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "task_not_found"
      | "task_forbidden"
      | "invalid_shared_state",
    message: string,
  ) {
    super(message);
    this.name = "TrialPaymentTaskServiceError";
  }
}

function fail(code: TrialPaymentTaskServiceError["code"], message: string): never {
  throw new TrialPaymentTaskServiceError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const REMINDER_PAYMENT_METHODS = new Set([
  "后置付费试听",
  "付费试听（未付费）",
  "在读学生付费试听",
]);

function canonicalTrialPlanner(value: unknown) {
  if (typeof value !== "string") return "";
  const key = value.trim().toLocaleLowerCase("en-AU");
  return ["Tara", "Eileen", "Abby"].find((planner) => planner.toLocaleLowerCase("en-AU") === key) ?? "";
}

function records(rows: readonly OpsStateRow[], entity: string) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Array.isArray(row.payload) || !row.payload.every(isRecord)
    || !Number.isSafeInteger(row.version) || row.version < 1) {
    fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  return row.payload as RecordValue[];
}

export function parseTrialPaymentCompletionCommand(value: unknown): TrialPaymentCompletionCommand {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["commandKey", "taskId", "expectedVersions"].includes(key))
    || typeof value.commandKey !== "string" || !COMMAND_PATTERN.test(value.commandKey)
    || typeof value.taskId !== "string" || !value.taskId.trim()
    || !isRecord(value.expectedVersions)
    || Object.keys(value.expectedVersions).sort().join("\0") !== [...VERSION_ENTITIES].sort().join("\0")) {
    fail("invalid_request", "试听收费确认命令不完整。");
  }
  const suppliedVersions = value.expectedVersions;
  const expectedVersions = Object.fromEntries(VERSION_ENTITIES.map((entity) => {
    const version = suppliedVersions[entity];
    if (!Number.isSafeInteger(version) || (version as number) < 1) {
      fail("invalid_request", `expectedVersions.${entity} is invalid.`);
    }
    return [entity, version as number];
  })) as TrialPaymentCompletionCommand["expectedVersions"];
  return { commandKey: value.commandKey, taskId: value.taskId.trim(), expectedVersions };
}

export function trialPaymentCompletionIntent(command: Pick<TrialPaymentCompletionCommand, "taskId">) {
  return { action: "complete", taskId: command.taskId } as const;
}

export function authorizeTrialPaymentTaskCompletion(input: {
  command: TrialPaymentCompletionCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
}) {
  if (input.role !== "staff") fail("task_forbidden", "只有任务指定的规划老师可以确认试听付款。");
  const tasks = records(input.rows, "tasks");
  const matches = tasks.filter((task) => task.id === input.command.taskId);
  if (matches.length !== 1) fail("task_not_found", "没有找到这项试听收费提醒。");
  const task = matches[0];
  const kind = managedTrialPaymentTaskKind(task);
  const bookingId = typeof task.anchorBookingId === "string" ? task.anchorBookingId : "";
  const studentId = typeof task.studentId === "string" ? task.studentId : "";
  if (!kind || !isManagedTrialPaymentTaskRecipient(task, input.actor)) {
    fail("task_forbidden", "这项试听收费提醒没有分配给当前规划老师。");
  }
  const students = records(input.rows, "students").filter((candidate) => candidate.id === studentId
    && candidate.importArchived !== true);
  if (students.length !== 1) {
    fail("task_forbidden", "试听学生或规划老师分配已经变化，请刷新后重试。");
  }
  const student = students[0]!;
  const lpItems = records(input.rows, "lpItems");
  records(input.rows, "teachers");
  if (kind === "booking") {
    const booking = records(input.rows, "bookings").filter((candidate) => candidate.id === bookingId
      && candidate.studentId === studentId && candidate.kind === "试听");
    if (booking.length !== 1 || student.planner !== input.actor) {
      fail("task_forbidden", "试听排课或规划老师分配已经变化，请刷新后重试。");
    }
    return { kind, task, booking: booking[0], student } as const;
  }

  records(input.rows, "bookings");
  const lpItemId = typeof task.requestAnchorBookingId === "string" ? task.requestAnchorBookingId : "";
  const eventId = bookingId.startsWith("JWB:") ? bookingId.slice(4) : "";
  const lpMatches = lpItems.filter((candidate) => candidate.id === lpItemId
    && candidate.studentId === studentId
    && candidate.workflowType === "试听 LP"
    && candidate.stage !== "完成");
  if (lpMatches.length !== 1) {
    fail("task_forbidden", "教务宝试听 LP 已变化，请刷新后重试。");
  }
  const lpItem = lpMatches[0]!;
  const schedule = isRecord(lpItem.trialSchedule) ? lpItem.trialSchedule : null;
  const intake = isRecord(lpItem.trialIntake) ? lpItem.trialIntake : null;
  const fields = isRecord(lpItem.fields) ? lpItem.fields : null;
  const planner = canonicalTrialPlanner(
    typeof intake?.planner === "string" && intake.planner.trim()
      ? intake.planner
      : student.planner,
  );
  if (schedule?.source !== "jiaowubao-open-api"
    || typeof schedule.sourceRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(schedule.sourceRevision)
    || schedule.eventId !== eventId
    || !planner
    || planner !== input.actor
    || !REMINDER_PAYMENT_METHODS.has(String(fields?.trialPaymentMethod ?? ""))) {
    fail("task_forbidden", "教务宝试听排课或规划老师分配已经变化，请刷新后重试。");
  }
  return { kind, task, lpItem, student } as const;
}

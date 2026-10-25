import {
  TRIAL_LEDGER_RESULT_STATUSES,
  TRIAL_OPERATIONS,
  type LpResultStatus,
} from "./lp-workflows";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const TRIAL_LEDGER_WORKFLOW_TYPES = ["试听 LP", "换老师试听"] as const;
export const TRIAL_LEDGER_PLANNERS = ["Tara", "Eileen", "Abby"] as const;
export const DEFAULT_TRIAL_RESULT_STATUS = "试听未进行" as const;

export const TRIAL_LEDGER_OVERRIDE_FIELDS = [
  "studentName",
  "guardianWechat",
  "workflowType",
  "lessonMonth",
  "requestedAt",
  "scheduledAt",
  "operationsOwner",
  "planner",
  "subject",
  "teacher",
] as const;

export const TRIAL_LEDGER_FIELDS = [
  ...TRIAL_LEDGER_OVERRIDE_FIELDS,
  "resultStatus",
  "trialPaid",
  "lpFinalized",
  "trialLedgerNote",
] as const;

export type TrialLedgerOverrideField = (typeof TRIAL_LEDGER_OVERRIDE_FIELDS)[number];
export type TrialLedgerField = (typeof TRIAL_LEDGER_FIELDS)[number];
export type TrialLedgerFieldValue = string | boolean;
export type TrialLedgerOverrides = Partial<Record<TrialLedgerOverrideField, string>>;

export type TrialLedgerAuditEntry = Readonly<{
  id: string;
  workflowId: string;
  action: "trial_ledger_field_changed";
  occurredAt: string;
  actor: string;
  field: Exclude<TrialLedgerField, "resultStatus">;
  fromValue?: TrialLedgerFieldValue;
  toValue?: TrialLedgerFieldValue;
}>;

export type TrialLedgerRecord = Readonly<{
  id: string;
  workflowType?: string;
  resultStatus?: LpResultStatus;
  trialLedgerOverrides?: TrialLedgerOverrides;
  trialPaid?: boolean;
  trialLpFinalized?: boolean;
  trialLedgerNote?: string;
  trialLedgerAudit?: readonly TrialLedgerAuditEntry[];
}>;

export type TrialLedgerCommand = Readonly<{
  commandKey: string;
  lpItemId: string;
  field: TrialLedgerField;
  expectedValue?: TrialLedgerFieldValue;
  value?: TrialLedgerFieldValue;
}>;

export class TrialLedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TrialLedgerError("invalid_command", `${field} 包含未允许的字段。`);
  }
}

function requiredText(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TrialLedgerError("invalid_command", `${field} 无效。`);
  }
  return value.trim();
}

function canonicalInstant(value: unknown, field: string) {
  const text = requiredText(value, field, 40);
  const instant = new Date(text);
  if (!Number.isFinite(instant.valueOf())) {
    throw new TrialLedgerError("invalid_command", `${field} 必须是有效日期和时间。`);
  }
  return instant.toISOString();
}

function normalizeNullableText(value: unknown, field: string, max: number) {
  if (value === null || value === undefined || value === "") return undefined;
  return requiredText(value, field, max);
}

export function normalizeTrialLedgerFieldValue(
  field: TrialLedgerField,
  value: unknown,
): TrialLedgerFieldValue | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  switch (field) {
    case "workflowType": {
      const normalized = requiredText(value, field, 40);
      if (!(TRIAL_LEDGER_WORKFLOW_TYPES as readonly string[]).includes(normalized)) {
        throw new TrialLedgerError("invalid_command", "LP 类型只能是试听 LP 或换老师试听。");
      }
      return normalized;
    }
    case "lessonMonth": {
      const normalized = requiredText(value, field, 7);
      if (!MONTH.test(normalized)) {
        throw new TrialLedgerError("invalid_command", "上课月份必须使用 YYYY-MM。");
      }
      return normalized;
    }
    case "requestedAt":
    case "scheduledAt":
      return canonicalInstant(value, field);
    case "operationsOwner": {
      const normalized = requiredText(value, field, 120);
      if (!(TRIAL_OPERATIONS as readonly string[]).includes(normalized)) {
        throw new TrialLedgerError("invalid_command", "教务必须来自试听手册规定的六名教务。");
      }
      return normalized;
    }
    case "planner": {
      const normalized = requiredText(value, field, 120);
      if (!(TRIAL_LEDGER_PLANNERS as readonly string[]).includes(normalized)) {
        throw new TrialLedgerError("invalid_command", "课程规划老师必须是 Tara、Eileen 或 Abby。");
      }
      return normalized;
    }
    case "resultStatus": {
      const normalized = requiredText(value, field, 40);
      if (!(TRIAL_LEDGER_RESULT_STATUSES as readonly string[]).includes(normalized)) {
        throw new TrialLedgerError("invalid_command", "试听状态不在允许的结果中。");
      }
      return normalized;
    }
    case "lpFinalized":
      if (typeof value !== "boolean") {
        throw new TrialLedgerError("invalid_command", "LP定稿必须是是、否或自动判断。");
      }
      return value;
    case "trialPaid":
      if (typeof value !== "boolean") {
        throw new TrialLedgerError("invalid_command", "是否付费必须是是、否或自动判断。");
      }
      return value;
    case "trialLedgerNote":
      return normalizeNullableText(value, field, 2_000);
    case "studentName":
    case "guardianWechat":
    case "subject":
    case "teacher":
      return normalizeNullableText(value, field, 240);
  }
}

function parseNullableValue(field: TrialLedgerField, value: unknown) {
  return normalizeTrialLedgerFieldValue(field, value);
}

export function parseTrialLedgerCommand(input: unknown): TrialLedgerCommand {
  if (!record(input)) throw new TrialLedgerError("invalid_command", "试听台账命令必须是对象。");
  exactKeys(input, ["commandKey", "lpItemId", "field", "expectedValue", "value"], "command");
  const commandKey = requiredText(input.commandKey, "commandKey", 80).toLocaleLowerCase("en-AU");
  if (!UUID_V4.test(commandKey)) throw new TrialLedgerError("invalid_command", "commandKey 必须是 UUID v4。");
  const lpItemId = requiredText(input.lpItemId, "lpItemId", 160);
  if (!LP_ID.test(lpItemId)) throw new TrialLedgerError("invalid_command", "lpItemId 无效。");
  const field = input.field;
  if (typeof field !== "string" || !(TRIAL_LEDGER_FIELDS as readonly string[]).includes(field)) {
    throw new TrialLedgerError("invalid_command", "试听台账字段无效。");
  }
  const typedField = field as TrialLedgerField;
  const expectedValue = parseNullableValue(typedField, input.expectedValue);
  const value = parseNullableValue(typedField, input.value);
  return {
    commandKey,
    lpItemId,
    field: typedField,
    ...(expectedValue !== undefined ? { expectedValue } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

export function trialLedgerCommandIntent(command: TrialLedgerCommand) {
  return {
    lpItemId: command.lpItemId,
    field: command.field,
    expectedValue: command.expectedValue ?? null,
    value: command.value ?? null,
  } as const;
}

export function trialLedgerStoredValue(
  item: TrialLedgerRecord,
  field: TrialLedgerField,
): TrialLedgerFieldValue | undefined {
  if ((TRIAL_LEDGER_OVERRIDE_FIELDS as readonly string[]).includes(field)) {
    const value = item.trialLedgerOverrides?.[field as TrialLedgerOverrideField];
    return value === undefined ? undefined : normalizeTrialLedgerFieldValue(field, value);
  }
  if (field === "trialPaid") return item.trialPaid;
  if (field === "lpFinalized") return item.trialLpFinalized;
  if (field === "trialLedgerNote") {
    return item.trialLedgerNote?.trim() || undefined;
  }
  return item.resultStatus;
}

export function isTrialLedgerWorkflow(item: Pick<TrialLedgerRecord, "workflowType">) {
  return (TRIAL_LEDGER_WORKFLOW_TYPES as readonly string[]).includes(item.workflowType ?? "");
}

/** Trial rows always have a usable handbook status, including legacy blanks. */
export function effectiveTrialResultStatus(
  item: Pick<TrialLedgerRecord, "workflowType" | "resultStatus">,
): LpResultStatus | undefined {
  if (item.resultStatus && (TRIAL_LEDGER_RESULT_STATUSES as readonly string[]).includes(item.resultStatus)) {
    return item.resultStatus;
  }
  return isTrialLedgerWorkflow(item) ? DEFAULT_TRIAL_RESULT_STATUS : undefined;
}

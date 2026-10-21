import { TRIAL_LEDGER_RESULT_STATUSES, TRIAL_OPERATIONS } from "./lp-workflows";
import {
  effectiveTrialResultStatus,
  isTrialLedgerWorkflow,
  trialLedgerStoredValue,
  type TrialLedgerField,
  type TrialLedgerRecord,
} from "./trial-ledger";

export const TENCENT_TRIAL_LEDGER_FILE_ID = "IKPhQMAvLSMn";
export const TENCENT_TRIAL_LEDGER_SHEET_ID = "wl6ehC";
export const TENCENT_TRIAL_LEDGER_URL = "https://docs.qq.com/smartsheet/DSUtQaFFNQXZMU01u";

export const TENCENT_TRIAL_LEDGER_FIELDS = [
  "学生姓名",
  "家长微信名",
  "LP 类型",
  "上课月份",
  "请求日期/时间",
  "上课日期和时间（墨尔本）",
  "教务",
  "课程规划老师",
  "科目",
  "老师",
  "试听状态",
  "是否付费",
  "备注",
] as const;

export type TencentTrialLedgerField = (typeof TENCENT_TRIAL_LEDGER_FIELDS)[number];
export type TencentTrialLedgerFieldKind = "text" | "option" | "datetime";

export const TENCENT_TRIAL_LEDGER_FIELD_KINDS: Readonly<Record<TencentTrialLedgerField, TencentTrialLedgerFieldKind>> = {
  学生姓名: "text",
  家长微信名: "text",
  "LP 类型": "option",
  上课月份: "text",
  "请求日期/时间": "datetime",
  "上课日期和时间（墨尔本）": "datetime",
  教务: "option",
  课程规划老师: "option",
  科目: "text",
  老师: "text",
  试听状态: "option",
  是否付费: "option",
  备注: "text",
};

const TENCENT_TRIAL_LEDGER_OPTIONS = {
  workflowType: ["试听 LP", "换老师试听"],
  operationsOwner: TRIAL_OPERATIONS,
  planner: ["Tara", "Eileen", "Abby"],
  resultStatus: TRIAL_LEDGER_RESULT_STATUSES,
} as const;

const TENCENT_TRIAL_LEDGER_OPTION_ALIASES: Readonly<Record<string, string>> = {
  Tara龙: "Tara",
};

export type TencentTrialLedgerMirrorRow = Readonly<{
  lpItemId: string;
  values: Readonly<Record<TencentTrialLedgerField, string>>;
}>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function child(value: unknown, key: string) {
  return record(value) && record(value[key]) ? value[key] as JsonRecord : {};
}

function canonicalInstant(value: unknown) {
  const candidate = text(value);
  if (!candidate) return "";
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : "";
}

function dateInMelbourne(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function storedText(item: JsonRecord, field: TrialLedgerField) {
  const value = trialLedgerStoredValue(item as TrialLedgerRecord, field);
  return typeof value === "string" ? value : "";
}

function effectiveText(item: JsonRecord, field: TrialLedgerField, automatic: unknown) {
  return storedText(item, field) || text(automatic);
}

function canonicalOption(
  value: unknown,
  allowed: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
) {
  const candidate = text(value);
  const canonical = aliases[candidate] ?? candidate;
  return allowed.includes(canonical) ? canonical : "";
}

function safeMonthFromInstant(value: string) {
  if (!value) return "";
  try {
    return dateInMelbourne(value).slice(0, 7);
  } catch {
    return "";
  }
}

function asTrialLedgerRecord(value: unknown): JsonRecord | null {
  if (!record(value) || !text(value.id) || !isTrialLedgerWorkflow(value as TrialLedgerRecord)) return null;
  return value;
}

/**
 * Builds the exact 13-column Tencent SmartSheet projection from one consistent
 * Supabase state snapshot. Supabase remains authoritative; Tencent is a
 * single-way review mirror, so every effective value is derived here.
 */
export function buildTencentTrialLedgerMirrorRows(input: Readonly<{
  lpItems: readonly unknown[];
  students: readonly unknown[];
}>): TencentTrialLedgerMirrorRow[] {
  const students = new Map(input.students.filter(record).map((student) => [text(student.id), student]));

  return input.lpItems
    .map(asTrialLedgerRecord)
    .filter((item): item is JsonRecord => item !== null)
    .map((item) => {
      const student = students.get(text(item.studentId)) ?? {};
      const intake = child(item, "trialIntake");
      const fields = child(item, "fields");
      const schedule = child(item, "trialSchedule");
      const automaticScheduledAt = canonicalInstant(schedule.startsAt);
      const scheduledAt = canonicalInstant(effectiveText(item, "scheduledAt", automaticScheduledAt));
      const requestedAt = canonicalInstant(effectiveText(
        item,
        "requestedAt",
        text(intake.requestSentAt) || text(item.requestedAt),
      ));
      const automaticPaid = ["付费试听（已付费）", "在读学生付费试听"]
        .includes(text(fields.trialPaymentMethod));
      const paid = trialLedgerStoredValue(item as TrialLedgerRecord, "trialPaid");

      return {
        lpItemId: text(item.id),
        values: {
          学生姓名: effectiveText(
            item,
            "studentName",
            text(schedule.studentName) || text(intake.studentName) || text(student.name),
          ),
          家长微信名: effectiveText(item, "guardianWechat", text(student.guardianWechat) || text(student.guardian)),
          "LP 类型": canonicalOption(
            effectiveText(item, "workflowType", item.workflowType),
            TENCENT_TRIAL_LEDGER_OPTIONS.workflowType,
          ),
          上课月份: effectiveText(item, "lessonMonth", safeMonthFromInstant(scheduledAt)),
          "请求日期/时间": requestedAt,
          "上课日期和时间（墨尔本）": scheduledAt,
          教务: canonicalOption(
            effectiveText(item, "operationsOwner", item.owner),
            TENCENT_TRIAL_LEDGER_OPTIONS.operationsOwner,
          ),
          课程规划老师: canonicalOption(
            effectiveText(item, "planner", text(intake.planner) || text(student.planner)),
            TENCENT_TRIAL_LEDGER_OPTIONS.planner,
            TENCENT_TRIAL_LEDGER_OPTION_ALIASES,
          ),
          科目: effectiveText(item, "subject", text(fields.subject) || text(student.course)),
          老师: effectiveText(
            item,
            "teacher",
            text(schedule.teacherName) || text(fields.assignedTeacher) || text(student.teacher),
          ),
          试听状态: canonicalOption(
            effectiveTrialResultStatus(item as TrialLedgerRecord),
            TENCENT_TRIAL_LEDGER_OPTIONS.resultStatus,
          ),
          是否付费: (typeof paid === "boolean" ? paid : automaticPaid) ? "是" : "否",
          备注: storedText(item, "trialLedgerNote"),
        },
      } satisfies TencentTrialLedgerMirrorRow;
    })
    .sort((left, right) => {
      const scheduled = right.values["上课日期和时间（墨尔本）"]
        .localeCompare(left.values["上课日期和时间（墨尔本）"]);
      return scheduled || left.lpItemId.localeCompare(right.lpItemId);
    });
}

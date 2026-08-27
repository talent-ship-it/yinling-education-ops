/**
 * Workflow deadlines confirmed by the operations requirements. These are
 * business contracts rather than administrator preferences, so they are not
 * part of the editable Rules payload.
 */
export const FIXED_REMINDER_RULES = Object.freeze({
  parentSpecifiedContentDaysAfterRequest: 0,
  lpReviewDaysBeforeTrial: 3,
  preparationDaysBeforeTrial: 2,
  minimumDaysBeforeTrial: 1,
  schedulingFeedbackHoursAfterRequest: 24,
  parentNoReplyFollowUpHoursAfterRequest: 4,
  teachingControlEscalationHoursAfterRequest: 8,
  parentProgressSyncHoursAfterRequest: 24,
  parentProgressSyncIntervalHours: 24,
} as const);

export const RULE_OPTIONS = Object.freeze({
  lowHours: Object.freeze(["3", "5", "8", "10"] as const),
  examDays: Object.freeze(["7", "14", "30", "60"] as const),
});

export type LowHoursRule = (typeof RULE_OPTIONS.lowHours)[number];
export type ExamDaysRule = (typeof RULE_OPTIONS.examDays)[number];

export type Rules = {
  lowHours: LowHoursRule;
  examDays: ExamDaysRule;
};

export const DEFAULT_RULES: Rules = Object.freeze({
  lowHours: "5",
  examDays: "30",
});

export class OpsRulesValidationError extends Error {
  constructor(message = "规则设置无效，只能使用系统提供的固定选项。") {
    super(message);
    this.name = "OpsRulesValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function includesOption<const T extends readonly string[]>(options: T, value: unknown): value is T[number] {
  return typeof value === "string" && options.includes(value);
}

function normaliseLegacyOption<const T extends readonly string[]>(
  options: T,
  value: unknown,
  fallback: T[number],
): T[number] {
  const candidate = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : value;
  return includesOption(options, candidate) ? candidate : fallback;
}

/**
 * Reads both the current two-field payload and the legacy six-field payload.
 * Unknown legacy fields are discarded and invalid values fall back safely.
 */
export function normalizeRules(value: unknown): Rules {
  if (!isRecord(value)) return { ...DEFAULT_RULES };
  return {
    lowHours: normaliseLegacyOption(RULE_OPTIONS.lowHours, value.lowHours, DEFAULT_RULES.lowHours),
    examDays: normaliseLegacyOption(RULE_OPTIONS.examDays, value.examDays, DEFAULT_RULES.examDays),
  };
}

export function rulesMatch(left: unknown, right: unknown) {
  const normalizedLeft = normalizeRules(left);
  const normalizedRight = normalizeRules(right);
  return normalizedLeft.lowHours === normalizedRight.lowHours
    && normalizedLeft.examDays === normalizedRight.examDays;
}

/**
 * Validates an API write. Unlike read normalization this is deliberately
 * strict: both editable fields must be present, no other fields are accepted,
 * and values must come from the published option lists.
 */
export function parseRulesWrite(value: unknown): Rules {
  if (!isRecord(value)) throw new OpsRulesValidationError();

  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "examDays" || keys[1] !== "lowHours") {
    throw new OpsRulesValidationError("规则写入必须且只能包含低课时阈值和考试提醒窗口。");
  }
  if (!includesOption(RULE_OPTIONS.lowHours, value.lowHours)) {
    throw new OpsRulesValidationError("低课时阈值必须从 3、5、8、10 中选择。");
  }
  if (!includesOption(RULE_OPTIONS.examDays, value.examDays)) {
    throw new OpsRulesValidationError("考试提醒窗口必须从 7、14、30、60 天中选择。");
  }

  return { lowHours: value.lowHours, examDays: value.examDays };
}

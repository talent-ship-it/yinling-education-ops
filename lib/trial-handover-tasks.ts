import { isFrozenLegacyTask, type OpsTask } from "./ops-tasks";

export const TRIAL_JWB_REQUEST_FOLLOW_UP_RULE = "trial.jiaowubao.request-follow-up-n3";
const REQUEST_ACTION_RULES = [
  "trial.manual-request.specified-content",
  "trial.manual-request.writing",
  "trial.manual-request.paper-send",
];
const REQUEST_FOLLOW_UP_COMPLETED_RESULT = "二要一发所需动作均已完成";
const LP_FINALIZED_RESULT = "试听台账已确认LP定稿";
const LP_FINALIZE_RULES = [
  "trial.jiaowubao.lp-finalize-tomorrow-n3",
  "trial.jiaowubao.lp-materials-n2",
];

type RequestFields = Readonly<{
  specifiedContentStatus?: unknown;
  writingRequired?: unknown;
  paperRequired?: unknown;
}>;

function specifiedContentNeedsFollowUp(value: unknown) {
  const status = typeof value === "string" ? value.trim() : "";
  return ["需教务跟进", "需要跟进"].includes(status);
}

export function trialRequestFollowUpRules(fields: RequestFields | undefined, intake: RequestFields | undefined) {
  const source = fields ?? {};
  const fallback = intake ?? {};
  const rules: string[] = [];
  if (specifiedContentNeedsFollowUp(source.specifiedContentStatus)) rules.push(REQUEST_ACTION_RULES[0]!);
  if ((source.writingRequired ?? fallback.writingRequired) === true) rules.push(REQUEST_ACTION_RULES[1]!);
  if ((source.paperRequired ?? fallback.paperRequired) === true) rules.push(REQUEST_ACTION_RULES[2]!);
  return rules;
}

function belongsToAction(candidate: OpsTask, source: OpsTask) {
  return candidate.requestAnchorBookingId === source.anchorBookingId
    && candidate.studentId === source.studentId
    && candidate.ruleKey === TRIAL_JWB_REQUEST_FOLLOW_UP_RULE;
}

function actionCompleted(current: readonly OpsTask[], source: Pick<OpsTask, "anchorBookingId" | "studentId">, ruleKey: string) {
  return current.some((action) => action.anchorBookingId === source.anchorBookingId
    && action.studentId === source.studentId && action.ruleKey === ruleKey
    && action.status === "done" && action.completionOutcome !== "cannot_do");
}

function allRequiredActionsCompleted(current: readonly OpsTask[], source: OpsTask, candidate: OpsTask) {
  const rules = candidate.trialRequestFollowUpRules;
  return Array.isArray(rules) && rules.length > 0
    && rules.every((ruleKey) => REQUEST_ACTION_RULES.includes(ruleKey)
      && actionCompleted(current, source, ruleKey));
}

export function completeTrialRequestFollowUps(current: OpsTask[], source: OpsTask, closedAt: string) {
  if (!REQUEST_ACTION_RULES.includes(source.ruleKey ?? "")) return current;
  return current.map((candidate) => belongsToAction(candidate, source)
    && candidate.status !== "done" && !isFrozenLegacyTask(candidate)
    && allRequiredActionsCompleted(current, source, candidate)
    ? {
        ...candidate,
        status: "done" as const,
        tone: "green" as const,
        closedAt,
        completionOutcome: "done" as const,
        result: REQUEST_FOLLOW_UP_COMPLETED_RESULT,
      }
    : candidate);
}

export function reopensTrialRequestFollowUp(source: OpsTask, candidate: OpsTask) {
  return REQUEST_ACTION_RULES.includes(source.ruleKey ?? "")
    && belongsToAction(candidate, source)
    && candidate.status === "done" && candidate.result === REQUEST_FOLLOW_UP_COMPLETED_RESULT
    && Boolean(candidate.dueAt) && !isFrozenLegacyTask(candidate);
}

export function pendingTrialRequestFollowUp(
  input: Readonly<{ lpItemId: string; studentId: string; requestFollowUpRules?: readonly string[] }>,
  current: readonly OpsTask[],
) {
  const source = { anchorBookingId: input.lpItemId, studentId: input.studentId };
  return input.requestFollowUpRules?.some((ruleKey) => !actionCompleted(current, source, ruleKey));
}

export function finalizedTrialLpTasks(tasks: OpsTask[], finalized: boolean | undefined, now: Date) {
  if (finalized !== true) return tasks;
  return tasks.map((candidate) => LP_FINALIZE_RULES.includes(candidate.ruleKey ?? "")
    ? {
        ...candidate,
        status: "done" as const,
        tone: "green" as const,
        result: LP_FINALIZED_RESULT,
        closedAt: now.toISOString(),
        completionOutcome: "done" as const,
      }
    : candidate);
}

export function reopensTrialLpFinalize(existing: OpsTask | undefined, candidate: OpsTask) {
  return existing?.status === "done" && !isFrozenLegacyTask(existing)
    && existing.result === LP_FINALIZED_RESULT
    && LP_FINALIZE_RULES.includes(candidate.ruleKey ?? "")
    && candidate.status !== "done";
}

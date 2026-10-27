import { dateTimeFormat } from "./date-time-format";
import type { OpsTask } from "./ops-tasks";
import { matchesOperationsOwnerFilter, operationsOwnerFilterOptions, resolveAssignableOperationsOwner } from "./demo-users";
import { LP_RESULT_STATUSES } from "./lp-workflows";
import { TRIAL_LEDGER_PLANNERS, TRIAL_LEDGER_WORKFLOW_TYPES } from "./trial-ledger";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ALL = "all" as const;

export const TRIAL_LEDGER_SORT_KEYS = [
  "scheduledAt",
  "requestedAt",
  "lessonMonth",
  "studentName",
] as const;

export type TrialLedgerSortKey = (typeof TRIAL_LEDGER_SORT_KEYS)[number];
export type TrialLedgerSortDirection = "asc" | "desc";
export type TrialLedgerPaidFilter = typeof ALL | "paid" | "unpaid";
export type TrialLedgerScheduleFilter = typeof ALL | "matched" | "unmatched";
export type TrialFollowUpStatus = "required" | "completed" | "not_required" | "unknown";
export type TrialFollowUpFilter = typeof ALL | Exclude<TrialFollowUpStatus, "unknown">;

export type TrialLedgerViewState = Readonly<{
  query: string;
  workflowType: string;
  lessonMonth: string;
  scheduledFrom: string;
  scheduledTo: string;
  requestedFrom: string;
  requestedTo: string;
  scheduleMatch: TrialLedgerScheduleFilter;
  parentFollowUp: TrialFollowUpFilter;
  preparationFollowUp: TrialFollowUpFilter;
  operationsOwner: string;
  planner: string;
  subject: string;
  teacher: string;
  resultStatus: string;
  paid: TrialLedgerPaidFilter;
  sortKey: TrialLedgerSortKey;
  sortDirection: TrialLedgerSortDirection;
}>;

export type TrialLedgerViewRow = Readonly<{
  id: string;
  studentName: string;
  guardianWechat: string;
  workflowType: string;
  lessonMonth: string;
  requestedAt: string;
  scheduledAt: string;
  scheduledDate: string;
  operationsOwner: string;
  planner: string;
  subject: string;
  teacher: string;
  resultStatus: string;
  paid: boolean;
  note: string;
  scheduleMatched?: boolean;
  parentFollowUp?: TrialFollowUpStatus;
  preparationFollowUp?: TrialFollowUpStatus;
  handoverText?: string;
}>;

export type TrialLedgerViewStats = Readonly<{
  total: number;
  resolved: number;
  successful: number;
  failed: number;
  successRate: number | null;
  byStatus: Readonly<Record<string, number>>;
}>;

const sortKeys = new Set<string>(TRIAL_LEDGER_SORT_KEYS);
const directions = new Set<string>(["asc", "desc"]);
const paidFilters = new Set<string>([ALL, "paid", "unpaid"]);
const statuses = new Set<string>(LP_RESULT_STATUSES);
const trialTypes = new Set<string>(TRIAL_LEDGER_WORKFLOW_TYPES);

export function defaultTrialLedgerViewState(): TrialLedgerViewState {
  return {
    query: "",
    workflowType: ALL,
    lessonMonth: ALL,
    scheduledFrom: "",
    scheduledTo: "",
    requestedFrom: "",
    requestedTo: "",
    scheduleMatch: ALL,
    parentFollowUp: ALL,
    preparationFollowUp: ALL,
    operationsOwner: ALL,
    planner: ALL,
    subject: ALL,
    teacher: ALL,
    resultStatus: ALL,
    paid: ALL,
    sortKey: "requestedAt",
    sortDirection: "desc",
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, fallback: string, max = 160) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return fallback;
  return value.trim();
}

function boundedQuery(value: unknown) {
  if (typeof value !== "string" || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  return value;
}

function exactDate(value: unknown, fallback = "") {
  const candidate = boundedText(value, fallback, 10);
  if (!DATE.test(candidate)) return fallback;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(candidate) ? candidate : fallback;
}

function requestedMillis(value: string) {
  const instant = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(instant)) return Number.NaN;
  const parts = Object.fromEntries(dateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === value ? instant : Number.NaN;
}

function requestedDateTime(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "";
  return Number.isFinite(requestedMillis(value)) ? value : "";
}

function followUpFilter(value: unknown): TrialFollowUpFilter {
  return value === "required" || value === "completed" || value === "not_required" ? value : ALL;
}

export function trialFollowUpStatus(input: Readonly<{
  lpItemId: string;
  required: boolean | undefined;
  ruleKeys: readonly string[];
  tasks: readonly OpsTask[];
}>): TrialFollowUpStatus {
  if (input.required === false) return "not_required";
  const relevant = input.tasks.filter((task) => (task.anchorBookingId === input.lpItemId
    || task.requestAnchorBookingId === input.lpItemId) && input.ruleKeys.includes(task.ruleKey ?? ""));
  if (input.required === undefined && relevant.length === 0) return "unknown";
  return input.ruleKeys.length > 0 && input.ruleKeys.every((ruleKey) => relevant.some((task) => task.ruleKey === ruleKey
    && task.status === "done" && task.completionOutcome !== "cannot_do"))
    && relevant.every((task) => task.status === "done" && task.completionOutcome !== "cannot_do")
    ? "completed" : "required";
}

function plannerName(value: string) {
  const name = value.trim();
  return name === "Tara" ? "Tara龙" : name;
}

export function parseTrialLedgerViewState(value: unknown): TrialLedgerViewState {
  const fallback = defaultTrialLedgerViewState();
  let candidate = value;
  if (typeof value === "string") {
    if (value.length > 4_096) return fallback;
    try {
      candidate = JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  if (!record(candidate)) return fallback;
  const lessonMonth = boundedText(candidate.lessonMonth, ALL, 7);
  const resultStatus = boundedText(candidate.resultStatus, ALL, 40);
  const operationsOwner = boundedText(candidate.operationsOwner, ALL, 120) || ALL;
  const sortKey = boundedText(candidate.sortKey, fallback.sortKey, 40);
  const sortDirection = boundedText(candidate.sortDirection, fallback.sortDirection, 8);
  const paid = boundedText(candidate.paid, fallback.paid, 8);
  return {
    query: boundedQuery(candidate.query),
    workflowType: boundedText(candidate.workflowType, ALL, 40) || ALL,
    lessonMonth: lessonMonth === ALL || MONTH.test(lessonMonth) ? lessonMonth : ALL,
    scheduledFrom: candidate.scheduledFrom === "" ? "" : exactDate(candidate.scheduledFrom),
    scheduledTo: candidate.scheduledTo === "" ? "" : exactDate(candidate.scheduledTo),
    requestedFrom: requestedDateTime(candidate.requestedFrom),
    requestedTo: requestedDateTime(candidate.requestedTo),
    scheduleMatch: candidate.scheduleMatch === "matched" || candidate.scheduleMatch === "unmatched" ? candidate.scheduleMatch : ALL,
    parentFollowUp: followUpFilter(candidate.parentFollowUp),
    preparationFollowUp: followUpFilter(candidate.preparationFollowUp),
    operationsOwner: resolveAssignableOperationsOwner(operationsOwner) ?? operationsOwner,
    planner: plannerName(boundedText(candidate.planner, ALL, 120)) || ALL,
    subject: boundedText(candidate.subject, ALL, 160) || ALL,
    teacher: boundedText(candidate.teacher, ALL, 160) || ALL,
    resultStatus: resultStatus === ALL || statuses.has(resultStatus) ? resultStatus : ALL,
    paid: paidFilters.has(paid) ? paid as TrialLedgerPaidFilter : fallback.paid,
    sortKey: sortKeys.has(sortKey) ? sortKey as TrialLedgerSortKey : fallback.sortKey,
    sortDirection: directions.has(sortDirection)
      ? sortDirection as TrialLedgerSortDirection
      : fallback.sortDirection,
  };
}

export function trialLedgerViewStorageKey(actor: string) {
  const key = actor.trim().normalize("NFKC").toLocaleLowerCase("en-AU") || "guest";
  return `yinling:trial-ledger-view:v1:${encodeURIComponent(key)}`;
}

export function trialLedgerRequestTime(item: Readonly<{
  trialIntake?: Readonly<{ requestSentAt: string }>;
  fields?: Readonly<{ requestSentAt?: unknown }>;
  requestedAt?: string;
}>) {
  const source = [item.trialIntake?.requestSentAt, item.fields?.requestSentAt, item.requestedAt]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()) && Number.isFinite(Date.parse(value)));
  return source ?? "";
}

export function trialLedgerViewHasFilters(state: TrialLedgerViewState) {
  const defaults = defaultTrialLedgerViewState();
  return (Object.keys(defaults) as Array<keyof TrialLedgerViewState>)
    .some((key) => {
      if (key === "sortKey" || key === "sortDirection") return false;
      if (key === "query") return state.query.trim() !== "";
      return state[key] !== defaults[key];
    });
}

function normalizeSearch(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/[\s\p{P}\p{S}_]+/gu, "");
}

export function trialLedgerViewFilterOptions(
  rows: readonly TrialLedgerViewRow[],
  state: TrialLedgerViewState,
  key: "lessonMonth" | "operationsOwner" | "planner" | "subject" | "teacher",
) {
  const values = [...(key === "planner" ? TRIAL_LEDGER_PLANNERS : []), ...rows.map((row) => row[key]), state[key] === ALL ? "" : state[key]];
  return key === "operationsOwner"
    ? operationsOwnerFilterOptions(values)
    : Array.from(new Set(values.map((value) => key === "planner" ? plannerName(value) : value).filter(Boolean))).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function matchesExact(filter: string, value: string) {
  return filter === ALL || filter === value;
}

function compareOptional(left: string, right: string, direction: TrialLedgerSortDirection) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const compared = left.localeCompare(right, "en-AU", { numeric: true, sensitivity: "base" });
  return direction === "asc" ? compared : -compared;
}

function matchesRequestRange(value: string, from: number | null, to: number | null) {
  const at = Date.parse(value);
  if (from !== null && (!Number.isFinite(at) || at < from)) return false;
  if (to !== null && (!Number.isFinite(at) || at > to)) return false;
  return true;
}

function matchesReviewFilters(row: TrialLedgerViewRow, state: TrialLedgerViewState) {
  if (state.scheduleMatch !== ALL && row.scheduleMatched !== (state.scheduleMatch === "matched")) return false;
  if (state.parentFollowUp !== ALL && row.parentFollowUp !== state.parentFollowUp) return false;
  if (state.preparationFollowUp !== ALL && row.preparationFollowUp !== state.preparationFollowUp) return false;
  return true;
}

function matchesLedgerDimensions(row: TrialLedgerViewRow, state: TrialLedgerViewState) {
  return [
    [state.workflowType, row.workflowType], [state.lessonMonth, row.lessonMonth],
    [state.planner, plannerName(row.planner)], [state.subject, row.subject],
    [state.teacher, row.teacher], [state.resultStatus, row.resultStatus],
  ].every(([filter, value]) => matchesExact(filter!, value!));
}

function matchesLedgerDates(row: TrialLedgerViewRow, state: TrialLedgerViewState) {
  if (state.scheduledFrom && (!row.scheduledDate || row.scheduledDate < state.scheduledFrom)) return false;
  if (state.scheduledTo && (!row.scheduledDate || row.scheduledDate > state.scheduledTo)) return false;
  return true;
}

function matchesPaidFilter(row: TrialLedgerViewRow, state: TrialLedgerViewState) {
  return state.paid === ALL || trialTypes.has(row.workflowType) && row.paid === (state.paid === "paid");
}

export function filterAndSortTrialLedgerRows(
  rows: readonly TrialLedgerViewRow[],
  unsafeState: TrialLedgerViewState,
) {
  const state = parseTrialLedgerViewState(unsafeState);
  const requestedFrom = state.requestedFrom ? requestedMillis(state.requestedFrom) : null;
  const requestedTo = state.requestedTo ? requestedMillis(state.requestedTo) + 59_999 : null;
  const queryTokens = state.query.split(/\s+/u).map(normalizeSearch).filter(Boolean);
  return rows.filter((row) => {
    const haystack = normalizeSearch([
      row.studentName,
      row.guardianWechat,
      row.subject,
      row.teacher,
      row.note,
      row.handoverText ?? "",
    ].join(" "));
    if (!queryTokens.every((token) => haystack.includes(token))) return false;
    if (!matchesReviewFilters(row, state)) return false;
    if (!matchesRequestRange(row.requestedAt, requestedFrom, requestedTo)) return false;
    if (!matchesLedgerDimensions(row, state)) return false;
    if (!matchesLedgerDates(row, state)) return false;
    if (!matchesOperationsOwnerFilter(state.operationsOwner, row.operationsOwner)) return false;
    if (!matchesPaidFilter(row, state)) return false;
    return true;
  }).sort((left, right) => {
    const compared = compareOptional(
      String(left[state.sortKey]),
      String(right[state.sortKey]),
      state.sortDirection,
    );
    return compared || left.id.localeCompare(right.id, "en-AU", { numeric: true });
  });
}

export function trialLedgerViewStats(rows: readonly TrialLedgerViewRow[]): TrialLedgerViewStats {
  const byStatus: Record<string, number> = Object.fromEntries(
    LP_RESULT_STATUSES.map((status) => [status, 0]),
  );
  let successful = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.resultStatus) byStatus[row.resultStatus] = (byStatus[row.resultStatus] ?? 0) + 1;
    if (!trialTypes.has(row.workflowType)) continue;
    if (["试听成功", "在读试听成功"].includes(row.resultStatus)) successful++;
    if (["试听失败", "在读试听失败"].includes(row.resultStatus)) failed++;
  }
  const resolved = successful + failed;
  return {
    total: rows.length,
    resolved,
    successful,
    failed,
    successRate: resolved ? Math.round(successful / resolved * 1_000) / 10 : null,
    byStatus,
  };
}

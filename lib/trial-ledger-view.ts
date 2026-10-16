import { matchesOperationsOwnerFilter, operationsOwnerFilterOptions, resolveAssignableOperationsOwner } from "./demo-users";
import { TRIAL_LEDGER_RESULT_STATUSES } from "./lp-workflows";
import { TRIAL_LEDGER_PLANNERS } from "./trial-ledger";

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

export type TrialLedgerViewState = Readonly<{
  query: string;
  workflowType: string;
  lessonMonth: string;
  scheduledFrom: string;
  scheduledTo: string;
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
const statuses = new Set<string>(TRIAL_LEDGER_RESULT_STATUSES);

export function defaultTrialLedgerViewState(): TrialLedgerViewState {
  return {
    query: "",
    workflowType: ALL,
    lessonMonth: ALL,
    scheduledFrom: "",
    scheduledTo: "",
    operationsOwner: ALL,
    planner: ALL,
    subject: ALL,
    teacher: ALL,
    resultStatus: ALL,
    paid: ALL,
    sortKey: "scheduledAt",
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

function plannerName(value: string) {
  const name = value.trim();
  return name === "Tara龙" ? "Tara" : name;
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

export function filterAndSortTrialLedgerRows(
  rows: readonly TrialLedgerViewRow[],
  unsafeState: TrialLedgerViewState,
) {
  const state = parseTrialLedgerViewState(unsafeState);
  const queryTokens = state.query.split(/\s+/u).map(normalizeSearch).filter(Boolean);
  return rows.filter((row) => {
    const haystack = normalizeSearch([
      row.studentName,
      row.guardianWechat,
      row.subject,
      row.teacher,
      row.note,
    ].join(" "));
    if (!queryTokens.every((token) => haystack.includes(token))) return false;
    if (!matchesExact(state.workflowType, row.workflowType)) return false;
    if (!matchesExact(state.lessonMonth, row.lessonMonth)) return false;
    if (!matchesOperationsOwnerFilter(state.operationsOwner, row.operationsOwner)) return false;
    if (!matchesExact(state.planner, plannerName(row.planner))) return false;
    if (!matchesExact(state.subject, row.subject)) return false;
    if (!matchesExact(state.teacher, row.teacher)) return false;
    if (!matchesExact(state.resultStatus, row.resultStatus)) return false;
    if (state.paid !== ALL && row.paid !== (state.paid === "paid")) return false;
    if (state.scheduledFrom && (!row.scheduledDate || row.scheduledDate < state.scheduledFrom)) return false;
    if (state.scheduledTo && (!row.scheduledDate || row.scheduledDate > state.scheduledTo)) return false;
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
    TRIAL_LEDGER_RESULT_STATUSES.map((status) => [status, 0]),
  );
  for (const row of rows) byStatus[row.resultStatus] = (byStatus[row.resultStatus] ?? 0) + 1;
  const successful = (byStatus["试听成功"] ?? 0) + (byStatus["在读试听成功"] ?? 0);
  const failed = (byStatus["试听失败"] ?? 0) + (byStatus["在读试听失败"] ?? 0);
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

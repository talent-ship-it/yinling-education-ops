import { DateTime } from "luxon";

import { normalizeStudentImportName } from "./student-import";
import {
  isTrialLedgerWorkflow,
  normalizeTrialLedgerFieldValue,
  trialLedgerStoredValue,
  type TrialLedgerField,
  type TrialLedgerFieldValue,
  type TrialLedgerRecord,
} from "./trial-ledger";

export const TENCENT_LP_SOURCE_FILE_ID = "IbvDeGpaoJEb";
export const TENCENT_LP_SOURCE_SHEET_ID = "f7mh7n";
export const TENCENT_LP_SOURCE_TIMEZONE = "Asia/Shanghai";
export const TENCENT_LP_SOURCE_HEADERS = [
  "名字", "家长微信名", "LP科目", "LP类型", "需求发出日期和时间", "上课月份", "上课日期",
  "上课时间（墨尔本）", "教务", "规划老师", "LP", "二要一发（拉群当天）", "老师", "备课（N-1）",
  "状态", "是否付费", "特殊备注",
] as const;

type RecordValue = Record<string, unknown>;
export type TencentLpSourceCell = Readonly<{
  row: number;
  col: number;
  value_type?: string;
  string_value?: string;
  bool_value?: boolean;
  number_value?: number;
}>;
type TencentLpSourceChange = Readonly<{
  sourceRow: number;
  lpItemId: string;
  field: TrialLedgerField;
  expectedValue: TrialLedgerFieldValue | null;
  value: TrialLedgerFieldValue;
}>;

function object(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function key(value: unknown) { return text(value).normalize("NFKC").replace(/\s+/gu, " "); }
function nameKey(value: unknown) {
  const valueText = text(value);
  return valueText ? normalizeStudentImportName(valueText) : "";
}
function cellValue(cell: TencentLpSourceCell) {
  if (cell.value_type === "BOOL") return cell.bool_value;
  if (cell.value_type === "NUMBER") return cell.number_value;
  if (["STRING", "TIME_STRING", "RICH_STRING"].includes(cell.value_type ?? "")) return text(cell.string_value);
  if (!cell.value_type && !text(cell.string_value)) return "";
  throw new Error("tencent_lp_source_cell_invalid");
}
function requestMinute(value: unknown, reference: string) {
  const source = text(value).normalize("NFKC");
  const referenceTime = DateTime.fromISO(reference, { setZone: true });
  if (!source || !referenceTime.isValid) return null;
  const localYear = referenceTime.setZone(TENCENT_LP_SOURCE_TIMEZONE).year;
  const partial = /^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/u.exec(source);
  if (partial) {
    const parsed = DateTime.fromObject({ year: localYear, month: Number(partial[1]), day: Number(partial[2]),
      hour: Number(partial[3]), minute: Number(partial[4]) }, { zone: TENCENT_LP_SOURCE_TIMEZONE });
    return parsed.isValid ? Math.floor(parsed.toMillis() / 60_000) : null;
  }
  const iso = DateTime.fromISO(source.replace(" ", "T"), { zone: TENCENT_LP_SOURCE_TIMEZONE, setZone: true });
  if (iso.isValid && /[T ]\d{1,2}:\d{2}/u.test(source)) return Math.floor(iso.toMillis() / 60_000);
  for (const format of ["yyyy/M/d H:mm", "yyyy-M-d H:mm", "yyyy年M月d日H:mm", "yyyy年M月d日 H:mm"]) {
    const parsed = DateTime.fromFormat(source, format, { zone: TENCENT_LP_SOURCE_TIMEZONE });
    if (parsed.isValid) return Math.floor(parsed.toMillis() / 60_000);
  }
  return null;
}
function planner(value: unknown) {
  return ({ Tara: "Tara", Tara龙: "Tara", Tara龙老师: "Tara", Eileen: "Eileen", Eileen校长号: "Eileen",
    Abby: "Abby", Abby校长号: "Abby" } as Record<string, string>)[key(value)] ?? key(value);
}
function workflow(value: unknown) {
  const normalized = key(value).replace(/\s/gu, "");
  if (["试听", "试听LP"].includes(normalized)) return "试听 LP";
  if (normalized === "换老师试听") return "换老师试听";
  return "";
}

type SourceCandidate = Readonly<{
  item: RecordValue;
  requestedAt: string;
  minute: number;
  name: string;
  guardian: string;
  workflowType: string;
}>;
type SourceMatch = Readonly<{ sourceRow: number; row: Map<number, unknown>; item: RecordValue }>;
type SourcePlan = {
  changes: TencentLpSourceChange[];
  matchedCount: number;
  unmatchedCount: number;
  ambiguousCount: number;
  invalidFieldCount: number;
};

function validCellIndex(value: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function sourceRows(cells: readonly TencentLpSourceCell[]) {
  const rows = new Map<number, Map<number, unknown>>();
  for (const cell of cells) {
    if (!validCellIndex(cell.row, 20_000) || !validCellIndex(cell.col, 28)) throw new Error("tencent_lp_source_cell_invalid");
    const row = rows.get(cell.row) ?? new Map<number, unknown>();
    if (row.has(cell.col)) throw new Error("tencent_lp_source_duplicate_cell");
    row.set(cell.col, cellValue(cell)); rows.set(cell.row, row);
  }
  const header = rows.get(0);
  if (!header || TENCENT_LP_SOURCE_HEADERS.some((title, column) => header.get(column) !== title)) {
    throw new Error("tencent_lp_source_headers_changed");
  }
  return rows;
}
function studentEntry(value: unknown): [string, RecordValue][] {
  const student = object(value);
  return student && text(student.id) ? [[text(student.id), student]] : [];
}
function candidateName(overrides: RecordValue, intake: RecordValue, student: RecordValue) {
  return nameKey(overrides.studentName || intake.studentName || student.name);
}
function candidateGuardian(overrides: RecordValue, student: RecordValue) {
  return key(overrides.guardianWechat || student.guardianWechat || student.guardian);
}
function candidateFromItem(item: RecordValue, students: ReadonlyMap<string, RecordValue>): SourceCandidate[] {
  const intake = object(item.trialIntake) ?? {};
  const student = students.get(text(item.studentId)) ?? {};
  const overrides = object(item.trialLedgerOverrides) ?? {};
  const requestedAt = text(intake.requestSentAt) || text(item.requestedAt);
  const instant = DateTime.fromISO(requestedAt, { setZone: true });
  if (!instant.isValid) return [];
  return [{ item, requestedAt, minute: Math.floor(instant.toMillis() / 60_000),
    name: candidateName(overrides, intake, student), guardian: candidateGuardian(overrides, student),
    workflowType: text(item.workflowType) }];
}
function sourceCandidate(value: unknown, students: ReadonlyMap<string, RecordValue>) {
  const item = object(value);
  if (!item || !text(item.id) || !isTrialLedgerWorkflow(item as TrialLedgerRecord)) return [];
  return candidateFromItem(item, students);
}
function matchesOptionalIdentity(required: string, actual: string) { return !required || required === actual; }
type SourceRowIdentity = Readonly<{ name: string; guardian: string; workflowType: string; requestedAt: unknown }>;
function matchesCandidate(candidate: SourceCandidate, identity: SourceRowIdentity) {
  return candidate.workflowType === identity.workflowType
    && candidate.minute === requestMinute(identity.requestedAt, candidate.requestedAt)
    && matchesOptionalIdentity(identity.name, candidate.name)
    && matchesOptionalIdentity(identity.guardian, candidate.guardian);
}
function sourceRowCandidates(row: Map<number, unknown>, candidates: readonly SourceCandidate[]) {
  const identity = { name: nameKey(row.get(0)), guardian: key(row.get(1)), workflowType: workflow(row.get(3)), requestedAt: row.get(4) };
  if (!identity.workflowType || !text(identity.requestedAt)) return [];
  if (!identity.name && !identity.guardian) return [];
  return candidates.filter((candidate) => matchesCandidate(candidate, identity));
}
function recordSourceMatch(sourceRow: number, row: Map<number, unknown>, found: readonly SourceCandidate[], matches: SourceMatch[], plan: SourcePlan) {
  if (found.length === 1) matches.push({ sourceRow, row, item: found[0]!.item });
  else if (found.length > 1) plan.ambiguousCount += 1;
  else plan.unmatchedCount += 1;
}
function sourceMatches(rows: ReadonlyMap<number, Map<number, unknown>>, candidates: readonly SourceCandidate[], plan: SourcePlan) {
  const matches: SourceMatch[] = [];
  for (const [sourceRow, row] of [...rows.entries()].sort(([left], [right]) => left - right)) {
    if (!sourceRow || ![...row.values()].some((value) => value !== "" && value !== undefined)) continue;
    recordSourceMatch(sourceRow, row, sourceRowCandidates(row, candidates), matches, plan);
  }
  return matches;
}
function sourceFields(row: ReadonlyMap<number, unknown>): [TrialLedgerField, unknown][] {
  return [
    ["planner", planner(row.get(9))], ["lpFinalized" as TrialLedgerField, row.get(10)],
    ["resultStatus", row.get(14) === "取消不安排" ? "被家长取消" : row.get(14)], ["trialPaid", row.get(15)], ["trialLedgerNote", row.get(16)],
  ];
}
function appendFieldChange(match: SourceMatch, field: TrialLedgerField, sourceValue: unknown, plan: SourcePlan) {
  try {
    const value = normalizeTrialLedgerFieldValue(field, sourceValue);
    const current = trialLedgerStoredValue(match.item as TrialLedgerRecord, field) ?? null;
    if (value !== undefined && value !== current) plan.changes.push({ sourceRow: match.sourceRow, lpItemId: text(match.item.id), field, expectedValue: current, value });
  } catch { plan.invalidFieldCount += 1; }
}
function appendMatchedChanges(match: SourceMatch, counts: ReadonlyMap<string, number>, plan: SourcePlan) {
  if (counts.get(text(match.item.id)) !== 1) { plan.ambiguousCount += 1; return; }
  plan.matchedCount += 1;
  for (const [field, sourceValue] of sourceFields(match.row)) {
    if (sourceValue === "" || sourceValue === undefined) continue;
    appendFieldChange(match, field, sourceValue, plan);
  }
}

type SourceInput = Readonly<{ cells: readonly TencentLpSourceCell[]; lpItems: readonly unknown[]; students: readonly unknown[] }>;
function matchedSourceInput(input: SourceInput) {
  const rows = sourceRows(input.cells);
  const students = new Map(input.students.flatMap(studentEntry));
  const candidates = input.lpItems.flatMap((value) => sourceCandidate(value, students));
  const plan: SourcePlan = { changes: [], matchedCount: 0, unmatchedCount: 0, ambiguousCount: 0, invalidFieldCount: 0 };
  const matches = sourceMatches(rows, candidates, plan);
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(text(match.item.id), (counts.get(text(match.item.id)) ?? 0) + 1);
  return { matches, counts, plan };
}
export function planTencentLpSourceChanges(input: SourceInput) {
  const { matches, counts, plan } = matchedSourceInput(input);
  for (const match of matches) appendMatchedChanges(match, counts, plan);
  return plan;
}
export type TencentLpSourceRecord = Readonly<{
  sourceRow: number;
  lpItemId: string;
  identityKey: string;
  fields: readonly Readonly<{ field: TrialLedgerField; column: number; source: TrialLedgerFieldValue | null; system: TrialLedgerFieldValue | null; valid: boolean }>[];
  proof: string;
}>;
function normalizedSourceField(field: TrialLedgerField, value: unknown) {
  try { return { value: normalizeTrialLedgerFieldValue(field, value) ?? null, valid: true }; }
  catch { return { value: null, valid: false }; }
}
function sourceIdentity(match: SourceMatch) {
  const intake = object(match.item.trialIntake) ?? {};
  const requestedAt = text(intake.requestSentAt) || text(match.item.requestedAt);
  return JSON.stringify([TENCENT_LP_SOURCE_FILE_ID, TENCENT_LP_SOURCE_SHEET_ID, text(match.item.id),
    nameKey(match.row.get(0)), key(match.row.get(1)), workflow(match.row.get(3)), requestMinute(match.row.get(4), requestedAt)]);
}
function matchedSourceRecord(match: SourceMatch): TencentLpSourceRecord {
  const columns = [9, 10, 14, 15, 16];
  const entries = sourceFields(match.row);
  return { sourceRow: match.sourceRow, lpItemId: text(match.item.id), identityKey: sourceIdentity(match),
    proof: JSON.stringify(entries), fields: entries.map(([field, value], index) => {
      const normalized = normalizedSourceField(field, value);
      return { field, column: columns[index]!, source: normalized.value, valid: normalized.valid,
        system: trialLedgerStoredValue(match.item as TrialLedgerRecord, field) ?? null };
    }) };
}
export function matchTencentLpSourceRecords(input: SourceInput) {
  const { matches, counts, plan } = matchedSourceInput(input);
  const records: TencentLpSourceRecord[] = [];
  for (const match of matches) {
    if (counts.get(text(match.item.id)) !== 1) { plan.ambiguousCount += 1; continue; }
    records.push(matchedSourceRecord(match));
  }
  return { records, unmatchedCount: plan.unmatchedCount, ambiguousCount: plan.ambiguousCount };
}

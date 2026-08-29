import {
  TENCENT_TRIAL_LEDGER_FIELD_KINDS,
  TENCENT_TRIAL_LEDGER_FIELDS,
  type TencentTrialLedgerField,
} from "./tencent-trial-ledger-mirror";

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/u;
const LP_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const RECORD_ID = /^[A-Za-z0-9_-]{1,160}$/u;

export type TencentTrialLedgerFieldWrite = Readonly<{
  field: TencentTrialLedgerField;
  text_value?: Readonly<{ items: readonly Readonly<{ text: string; type: "text" }>[] }>;
  option_value?: Readonly<{ items: readonly Readonly<{ text: string }>[] }>;
  string_value?: string;
}>;

export type TencentTrialLedgerTargetRecord = Readonly<{
  record_id: string;
  field_values: readonly unknown[];
}>;

export type TencentTrialLedgerSyncRow = Readonly<{
  lpItemId: string;
  payloadSha256: string;
  values: Readonly<Record<TencentTrialLedgerField, string>>;
}>;

export type TencentTrialLedgerRecordMapping = Readonly<{
  lpItemId: string;
  recordId: string;
  payloadSha256: string;
}>;

export class TencentTrialLedgerSyncPlanError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalDateTime(value: string, code: string) {
  if (!value) return "";
  const milliseconds = /^\d{10,16}$/u.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TencentTrialLedgerSyncPlanError(code);
  return String(milliseconds);
}

function sourceValues(row: TencentTrialLedgerSyncRow) {
  const values = {} as Record<TencentTrialLedgerField, string>;
  if (!record(row.values) || Object.keys(row.values).length !== TENCENT_TRIAL_LEDGER_FIELDS.length) {
    throw new TencentTrialLedgerSyncPlanError("source_row_invalid");
  }
  for (const field of TENCENT_TRIAL_LEDGER_FIELDS) {
    const value = row.values[field];
    if (typeof value !== "string") throw new TencentTrialLedgerSyncPlanError("source_row_invalid");
    values[field] = TENCENT_TRIAL_LEDGER_FIELD_KINDS[field] === "datetime"
      ? canonicalDateTime(value, "source_datetime_invalid")
      : value;
  }
  return values;
}

function items(value: unknown, kind: "text" | "option") {
  if (!record(value) || !Array.isArray(value.items)) throw new TencentTrialLedgerSyncPlanError("target_value_invalid");
  const result = value.items.map((item) => {
    if (!record(item) || typeof item.text !== "string") throw new TencentTrialLedgerSyncPlanError("target_value_invalid");
    if (kind === "text" && item.type !== "text") throw new TencentTrialLedgerSyncPlanError("target_value_invalid");
    return item.text;
  });
  return kind === "text" ? result.join("") : result.join("\u001f");
}

export function targetRecordValues(candidate: TencentTrialLedgerTargetRecord) {
  if (!RECORD_ID.test(candidate.record_id) || !Array.isArray(candidate.field_values)) {
    throw new TencentTrialLedgerSyncPlanError("target_record_invalid");
  }
  const byField = new Map<string, JsonRecord>();
  for (const value of candidate.field_values) {
    if (!record(value) || typeof value.field !== "string" || byField.has(value.field)) {
      throw new TencentTrialLedgerSyncPlanError("target_value_invalid");
    }
    byField.set(value.field, value);
  }
  const values = {} as Record<TencentTrialLedgerField, string>;
  for (const field of TENCENT_TRIAL_LEDGER_FIELDS) {
    const value = byField.get(field);
    if (!value) {
      values[field] = "";
      continue;
    }
    const kind = TENCENT_TRIAL_LEDGER_FIELD_KINDS[field];
    if (kind === "text") values[field] = items(value.text_value, "text");
    else if (kind === "option") values[field] = items(value.option_value, "option");
    else if (typeof value.string_value === "string") {
      values[field] = canonicalDateTime(value.string_value, "target_value_invalid");
    } else throw new TencentTrialLedgerSyncPlanError("target_value_invalid");
  }
  return values;
}

function sameValues(row: TencentTrialLedgerSyncRow, candidate: TencentTrialLedgerTargetRecord) {
  const expected = sourceValues(row);
  const actual = targetRecordValues(candidate);
  return TENCENT_TRIAL_LEDGER_FIELDS.every((field) => expected[field] === actual[field]);
}

export function tencentTrialLedgerFieldWrites(row: TencentTrialLedgerSyncRow, omitEmpty = false) {
  const values = sourceValues(row);
  return TENCENT_TRIAL_LEDGER_FIELDS.flatMap((field): TencentTrialLedgerFieldWrite[] => {
    const value = values[field];
    if (omitEmpty && !value) return [];
    const kind = TENCENT_TRIAL_LEDGER_FIELD_KINDS[field];
    if (kind === "text") {
      return [{ field, text_value: { items: value ? [{ text: value, type: "text" }] : [] } }];
    }
    if (kind === "option") {
      return [{ field, option_value: { items: value ? [{ text: value }] : [] } }];
    }
    return [{ field, string_value: value }];
  });
}

function validateRows(rows: readonly TencentTrialLedgerSyncRow[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!LP_ITEM_ID.test(row.lpItemId) || !SHA256.test(row.payloadSha256) || seen.has(row.lpItemId)) {
      throw new TencentTrialLedgerSyncPlanError("source_row_invalid");
    }
    sourceValues(row);
    seen.add(row.lpItemId);
  }
}

function validateMappings(mappings: readonly TencentTrialLedgerRecordMapping[]) {
  const lpItemIds = new Set<string>();
  const recordIds = new Set<string>();
  for (const mapping of mappings) {
    if (!LP_ITEM_ID.test(mapping.lpItemId) || !RECORD_ID.test(mapping.recordId)
      || !SHA256.test(mapping.payloadSha256) || lpItemIds.has(mapping.lpItemId)
      || recordIds.has(mapping.recordId)) {
      throw new TencentTrialLedgerSyncPlanError("mapping_invalid");
    }
    lpItemIds.add(mapping.lpItemId);
    recordIds.add(mapping.recordId);
  }
}

export function planTencentTrialLedgerWrites(input: Readonly<{
  rows: readonly TencentTrialLedgerSyncRow[];
  mappings: readonly TencentTrialLedgerRecordMapping[];
  records: readonly TencentTrialLedgerTargetRecord[];
}>) {
  validateRows(input.rows);
  validateMappings(input.mappings);
  const records = new Map<string, TencentTrialLedgerTargetRecord>();
  for (const candidate of input.records) {
    targetRecordValues(candidate);
    if (records.has(candidate.record_id)) throw new TencentTrialLedgerSyncPlanError("target_record_invalid");
    records.set(candidate.record_id, candidate);
  }
  const mappings = new Map(input.mappings.map((mapping) => [mapping.lpItemId, mapping]));
  const reserved = new Set(input.mappings.map((mapping) => mapping.recordId));
  const available = [...records.values()].sort((left, right) => left.record_id.localeCompare(right.record_id));
  const assignments: Readonly<{
    row: TencentTrialLedgerSyncRow;
    recordId: string;
    source: "mapped" | "adopted";
  }>[] = [];
  const updates: Readonly<{
    row: TencentTrialLedgerSyncRow;
    recordId: string;
    fieldValues: readonly TencentTrialLedgerFieldWrite[];
  }>[] = [];
  const creates: Readonly<{
    row: TencentTrialLedgerSyncRow;
    fieldValues: readonly TencentTrialLedgerFieldWrite[];
  }>[] = [];

  for (const row of input.rows) {
    const mapping = mappings.get(row.lpItemId);
    if (mapping) {
      const candidate = records.get(mapping.recordId);
      if (!candidate) throw new TencentTrialLedgerSyncPlanError("mapped_record_missing");
      assignments.push({ row, recordId: mapping.recordId, source: "mapped" });
      if (!sameValues(row, candidate)) {
        updates.push({ row, recordId: mapping.recordId, fieldValues: tencentTrialLedgerFieldWrites(row) });
      }
      continue;
    }
    const candidate = available.find((record) => !reserved.has(record.record_id) && sameValues(row, record));
    if (candidate) {
      reserved.add(candidate.record_id);
      assignments.push({ row, recordId: candidate.record_id, source: "adopted" });
      continue;
    }
    creates.push({ row, fieldValues: tencentTrialLedgerFieldWrites(row, true) });
  }

  return { assignments, updates, creates } as const;
}

export function assertTencentTrialLedgerReadback(input: Readonly<{
  assignments: readonly Readonly<{ row: TencentTrialLedgerSyncRow; recordId: string }>[];
  records: readonly TencentTrialLedgerTargetRecord[];
}>) {
  const records = new Map(input.records.map((candidate) => [candidate.record_id, candidate]));
  if (records.size !== input.records.length || input.assignments.length !== records.size) {
    throw new TencentTrialLedgerSyncPlanError("readback_incomplete");
  }
  for (const assignment of input.assignments) {
    const candidate = records.get(assignment.recordId);
    if (!candidate || !sameValues(assignment.row, candidate)) {
      throw new TencentTrialLedgerSyncPlanError("readback_mismatch");
    }
  }
}

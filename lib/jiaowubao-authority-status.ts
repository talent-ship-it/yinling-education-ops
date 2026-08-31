export const JIAOWUBAO_AUTHORITY_SOURCE_ID = "jiaowubao-open-api-schedule";

type JsonRecord = Record<string, unknown>;

export type JiaowubaoAuthorityMatchStats = Readonly<{
  total: number;
  matched: number;
  unmatched: number;
  conflict: number;
  sourceOnly: number;
  matchRate: number;
}>;

export type JiaowubaoAuthorityStatus = Readonly<{
  sourceId: typeof JIAOWUBAO_AUTHORITY_SOURCE_ID;
  sourceStatus: "synced";
  sourceSyncedAt: string;
  snapshotRows: number;
  snapshotRevision: string;
  snapshotPublishedAt: string;
  snapshotChangedAt: string;
  checkedAt: string;
  projectedAt: string;
  projectionRunId: string;
  sourceWindow: Readonly<{ start: string; end: string }>;
  cadenceMinutes: 30;
  authorityMode: "one_of_multiple";
  tool: "query_schedule_list";
  matches: Readonly<Record<"schedule" | "student" | "teacher" | "course" | "class" | "room", JiaowubaoAuthorityMatchStats>>;
  anomalies: Readonly<{
    duplicateScheduleIds: number;
    missingScheduleIds: number;
    invalidTimeRecords: number;
    missingStudentIds: number;
    missingTeacherIds: number;
    missingCourseIds: number;
    identityConflicts: number;
    identityVariantConflicts: number;
  }>;
  prices: Readonly<{
    present: boolean;
    schedulePriceRecords: number;
    studentPriceRecords: number;
    persistedPrivately: true;
    browserExposed: false;
  }>;
  fields: Readonly<{
    topLevelFields: readonly string[];
    studentFields: readonly string[];
  }>;
  coverage: Readonly<{
    normalizedEntityRows: number;
    matchedEntityRows: number;
    sourceOnlyEntityRows: number;
    sourceSnapshotPersisted: true;
    normalizedProjectionPersisted: true;
    nativeRecordsOverwritten: false;
    connectedTools: readonly ["query_schedule_list"];
  }>;
}>;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ENTITY_TYPES = ["schedule", "student", "teacher", "course", "class", "room"] as const;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function integer(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function percentage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function instant(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function stringList(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000
      || value.some((item) => typeof item !== "string" || !item || item.length > 240)) return null;
  const fields = value as string[];
  if (new Set(fields).size !== fields.length) return null;
  return Object.freeze([...fields]);
}

function matchStats(value: unknown): JiaowubaoAuthorityMatchStats | null {
  const raw = record(value);
  if (!raw) return null;
  const total = integer(raw.total);
  const matched = integer(raw.matched);
  const unmatched = integer(raw.unmatched);
  const conflict = integer(raw.conflict);
  const sourceOnly = integer(raw.sourceOnly);
  const matchRate = percentage(raw.matchRate);
  if ([total, matched, unmatched, conflict, sourceOnly, matchRate].some((item) => item === null)
      || matched! + unmatched! + conflict! + sourceOnly! !== total!) return null;
  const expectedRate = total === 0 ? 0 : Math.round((matched! * 10_000) / total!) / 100;
  if (Math.abs(matchRate! - expectedRate) > 0.01) return null;
  return Object.freeze({ total: total!, matched: matched!, unmatched: unmatched!, conflict: conflict!, sourceOnly: sourceOnly!, matchRate: matchRate! });
}

/** Parses only the aggregate source receipt; raw names, IDs and prices are never accepted here. */
export function parseJiaowubaoAuthorityStatus(source: unknown): JiaowubaoAuthorityStatus | null {
  const row = record(source);
  if (!row || row.source_id !== JIAOWUBAO_AUTHORITY_SOURCE_ID || row.status !== "synced") return null;
  const sourceSyncedAt = instant(row.synced_at);
  const sourceRowCount = integer(row.row_count);
  const payload = record(row.payload);
  if (!sourceSyncedAt || sourceRowCount === null || !payload
      || payload.schemaVersion !== 1
      || payload.authorityMode !== "one_of_multiple"
      || payload.tool !== "query_schedule_list"
      || payload.cadenceMinutes !== 30
      || typeof payload.snapshotRevision !== "string" || !SHA256.test(payload.snapshotRevision)
      || typeof payload.projectionRunId !== "string" || !UUID.test(payload.projectionRunId)) return null;

  const snapshotPublishedAt = instant(payload.snapshotPublishedAt);
  const snapshotChangedAt = instant(payload.snapshotChangedAt);
  const checkedAt = instant(payload.checkedAt);
  const projectedAt = instant(payload.projectedAt);
  const sourceWindow = record(payload.sourceWindow);
  if (!snapshotPublishedAt || !snapshotChangedAt || !checkedAt || !projectedAt || !sourceWindow
      || typeof sourceWindow.start !== "string" || !ISO_DATE.test(sourceWindow.start)
      || typeof sourceWindow.end !== "string" || !ISO_DATE.test(sourceWindow.end)
      || sourceWindow.end < sourceWindow.start) return null;

  const rawMatches = record(payload.matches);
  if (!rawMatches) return null;
  const matches = Object.fromEntries(ENTITY_TYPES.map((entityType) => [entityType, matchStats(rawMatches[entityType])])) as Record<(typeof ENTITY_TYPES)[number], JiaowubaoAuthorityMatchStats | null>;
  if (ENTITY_TYPES.some((entityType) => matches[entityType] === null)) return null;

  const rawAnomalies = record(payload.anomalies);
  const rawPrices = record(payload.prices);
  const rawFields = record(payload.fields);
  const rawCoverage = record(payload.coverage);
  if (!rawAnomalies || !rawPrices || !rawFields || !rawCoverage) return null;
  const anomalies = {
    duplicateScheduleIds: integer(rawAnomalies.duplicateScheduleIds),
    missingScheduleIds: integer(rawAnomalies.missingScheduleIds),
    invalidTimeRecords: integer(rawAnomalies.invalidTimeRecords),
    missingStudentIds: integer(rawAnomalies.missingStudentIds),
    missingTeacherIds: integer(rawAnomalies.missingTeacherIds),
    missingCourseIds: integer(rawAnomalies.missingCourseIds),
    identityConflicts: integer(rawAnomalies.identityConflicts),
    identityVariantConflicts: integer(rawAnomalies.identityVariantConflicts),
  };
  if (Object.values(anomalies).some((value) => value === null)) return null;
  const topLevelFields = stringList(rawFields.topLevelFields);
  const studentFields = stringList(rawFields.studentFields);
  const normalizedEntityRows = integer(rawCoverage.normalizedEntityRows);
  const matchedEntityRows = integer(rawCoverage.matchedEntityRows);
  const sourceOnlyEntityRows = integer(rawCoverage.sourceOnlyEntityRows);
  if (!topLevelFields || !studentFields
      || rawPrices.persistedPrivately !== true || rawPrices.browserExposed !== false
      || typeof rawPrices.present !== "boolean"
      || integer(rawPrices.schedulePriceRecords) === null || integer(rawPrices.studentPriceRecords) === null
      || rawCoverage.sourceSnapshotPersisted !== true
      || rawCoverage.normalizedProjectionPersisted !== true
      || rawCoverage.nativeRecordsOverwritten !== false
      || !Array.isArray(rawCoverage.connectedTools)
      || rawCoverage.connectedTools.length !== 1 || rawCoverage.connectedTools[0] !== "query_schedule_list"
      || integer(rawCoverage.snapshotRows) !== sourceRowCount
      || normalizedEntityRows === null || matchedEntityRows === null || sourceOnlyEntityRows === null
      || matchedEntityRows + sourceOnlyEntityRows !== normalizedEntityRows) return null;

  return Object.freeze({
    sourceId: JIAOWUBAO_AUTHORITY_SOURCE_ID,
    sourceStatus: "synced",
    sourceSyncedAt,
    snapshotRows: sourceRowCount,
    snapshotRevision: payload.snapshotRevision,
    snapshotPublishedAt,
    snapshotChangedAt,
    checkedAt,
    projectedAt,
    projectionRunId: payload.projectionRunId,
    sourceWindow: Object.freeze({ start: sourceWindow.start, end: sourceWindow.end }),
    cadenceMinutes: 30,
    authorityMode: "one_of_multiple",
    tool: "query_schedule_list",
    matches: Object.freeze(matches as Record<(typeof ENTITY_TYPES)[number], JiaowubaoAuthorityMatchStats>),
    anomalies: Object.freeze(Object.fromEntries(Object.entries(anomalies).map(([key, value]) => [key, value!])) as JiaowubaoAuthorityStatus["anomalies"]),
    prices: Object.freeze({
      present: rawPrices.present,
      schedulePriceRecords: integer(rawPrices.schedulePriceRecords)!,
      studentPriceRecords: integer(rawPrices.studentPriceRecords)!,
      persistedPrivately: true,
      browserExposed: false,
    }),
    fields: Object.freeze({ topLevelFields, studentFields }),
    coverage: Object.freeze({
      normalizedEntityRows,
      matchedEntityRows,
      sourceOnlyEntityRows,
      sourceSnapshotPersisted: true,
      normalizedProjectionPersisted: true,
      nativeRecordsOverwritten: false,
      connectedTools: Object.freeze(["query_schedule_list"] as const),
    }),
  });
}

export function findJiaowubaoAuthorityStatus(sources: unknown): JiaowubaoAuthorityStatus | null {
  if (!Array.isArray(sources)) return null;
  return parseJiaowubaoAuthorityStatus(sources.find((source) => record(source)?.source_id === JIAOWUBAO_AUTHORITY_SOURCE_ID));
}

/** Rebuilds the browser source row from the allow-listed aggregate DTO. */
export function sanitizeJiaowubaoAuthoritySourceForBrowser(source: unknown) {
  const status = parseJiaowubaoAuthorityStatus(source);
  if (!status) return null;
  return Object.freeze({
    source_id: status.sourceId,
    title: "教务宝 Open API",
    source_type: "authoritative_api",
    url: null,
    modified_at: status.snapshotChangedAt,
    synced_at: status.sourceSyncedAt,
    row_count: status.snapshotRows,
    status: status.sourceStatus,
    payload: {
      schemaVersion: 1,
      authorityMode: status.authorityMode,
      tool: status.tool,
      cadenceMinutes: status.cadenceMinutes,
      snapshotRevision: status.snapshotRevision,
      projectionRunId: status.projectionRunId,
      snapshotPublishedAt: status.snapshotPublishedAt,
      snapshotChangedAt: status.snapshotChangedAt,
      checkedAt: status.checkedAt,
      projectedAt: status.projectedAt,
      sourceWindow: status.sourceWindow,
      matches: status.matches,
      anomalies: status.anomalies,
      prices: status.prices,
      fields: status.fields,
      coverage: { snapshotRows: status.snapshotRows, ...status.coverage },
    },
  });
}

/** Two missed 30-minute ticks plus a small delivery margin is unhealthy. */
export function jiaowubaoAuthorityCadenceHealthy(
  status: JiaowubaoAuthorityStatus,
  now = Date.now(),
) {
  const age = now - new Date(status.sourceSyncedAt).getTime();
  return age >= -5 * 60 * 1_000 && age <= 75 * 60 * 1_000;
}

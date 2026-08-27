import { createHash } from "node:crypto";

import {
  isStudentImportJwbLatinParentheticalAnnotationMatch,
  normalizeStudentImportName,
  studentImportJwbLatinParentheticalAnnotationKey,
  type MasterStudentImportRow,
  type StudentImportSourceKey,
} from "@/lib/student-import";

/**
 * The supplied Jiaowubao exports are an offline, point-in-time supplement to
 * the Tencent roster.  This module deliberately does not decide who is a
 * student: callers must first match a row to a non-excluded Tencent master
 * row.  It also keeps raw contracts/schedule facts separate from billable
 * lesson packages because these exports do not provide durable contract IDs.
 */

export const JIAOWUBAO_STATIC_SOURCE_FORMAT = "jiaowubao-static-excel-v1" as const;
export const JIAOWUBAO_STATIC_SOURCE_TIMEZONE = "Australia/Melbourne" as const;

export type JiaowubaoStaticCellRow = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type JiaowubaoStaticWorkbook = Readonly<{
  workbookName: string;
  workbookSha256: string;
  rows: readonly JiaowubaoStaticCellRow[];
}>;

export type JiaowubaoStaticExportInput = Readonly<{
  quickList: JiaowubaoStaticWorkbook;
  students: JiaowubaoStaticWorkbook;
  hours: JiaowubaoStaticWorkbook;
  contracts: JiaowubaoStaticWorkbook;
  classMemberships?: JiaowubaoStaticWorkbook;
  leaveMakeups?: JiaowubaoStaticWorkbook;
}>;

export type JiaowubaoStaticIdentity = Readonly<{
  identityKey: string;
  sourceRow: string;
  name: string;
  normalizedName: string;
  phone: string;
  externalStudentNumber?: string;
}>;

export type JiaowubaoStaticHours = Readonly<{
  course: string;
  totalHours?: number;
  usedHours?: number;
  remainingHours?: number;
  deadline?: string;
  sourceWorkbook: string;
  sourceRow: number;
}>;

export type JiaowubaoStaticContract = Readonly<{
  course: string;
  contractType?: string;
  cardType?: string;
  totalHours?: number;
  usedHours?: number;
  remainingHours?: number;
  effectiveDate?: string;
  signedDate?: string;
  deadline?: string;
  sourceWorkbook: string;
  sourceRow: number;
}>;

export type JiaowubaoStaticStudentFact = Readonly<{
  identity: JiaowubaoStaticIdentity;
  grade?: string;
  studentType?: string;
  gender?: string;
  birthday?: string;
  age?: string;
  alternatePhone?: string;
  manager?: string;
  classes: readonly string[];
  notes: readonly string[];
  hours: readonly JiaowubaoStaticHours[];
  contracts: readonly JiaowubaoStaticContract[];
  aggregate: Readonly<{
    totalHours?: number;
    usedHours?: number;
    remainingHours?: number;
    consistency: "verified" | "needs_review" | "missing";
  }>;
}>;

export type JiaowubaoStaticUnlinkedFact = Readonly<{
  identityKey: string;
  reason:
    | "empty_name"
    | "missing_phone"
    | "conflicting_external_student_number"
    | "not_in_active_student_snapshot";
  sourceWorkbook: string;
  sourceRow: number;
}>;

type JiaowubaoStaticIdentityResult =
  | Readonly<{ kind: "identity"; identity: JiaowubaoStaticIdentity }>
  | Readonly<{ kind: "issue"; issue: JiaowubaoStaticUnlinkedFact }>;

export type JiaowubaoStaticExportPlan = Readonly<{
  format: typeof JIAOWUBAO_STATIC_SOURCE_FORMAT;
  sourceTimezone: typeof JIAOWUBAO_STATIC_SOURCE_TIMEZONE;
  students: readonly JiaowubaoStaticStudentFact[];
  unlinked: readonly JiaowubaoStaticUnlinkedFact[];
  summary: Readonly<{
    activeStudentRows: number;
    studentFacts: number;
    verifiedAggregates: number;
    reviewAggregates: number;
    unlinkedRows: number;
  }>;
}>;

export type JiaowubaoStaticMasterMatch = Readonly<{
  masterSourceRow: StudentImportSourceKey;
  jwbSourceRow: string;
  mode: "exact_name" | "reviewed_latin_parenthetical_annotation_v1";
}>;

export type JiaowubaoStaticMatchPlan = Readonly<{
  /** Exact unique names are the only automatically attachable facts. */
  matches: readonly JiaowubaoStaticMasterMatch[];
  /** A review queue; it is deliberately not part of `matches`. */
  reviewCandidates: readonly JiaowubaoStaticMasterMatch[];
  unmatchedMasterSourceRows: readonly StudentImportSourceKey[];
  unmatchedJwbSourceRows: readonly string[];
  ambiguousMasterSourceRows: readonly StudentImportSourceKey[];
  ambiguousJwbSourceRows: readonly string[];
}>;

export class JiaowubaoStaticImportError extends Error {
  constructor(
    readonly code:
      | "invalid_workbook"
      | "missing_required_column"
      | "invalid_number"
      | "invalid_date"
      | "invalid_timezone"
      | "invalid_wall_clock"
      | "ambiguous_wall_clock",
    message: string,
  ) {
    super(message);
    this.name = "JiaowubaoStaticImportError";
  }
}

const ACTIVE_STUDENT_TYPE = "在读";
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/gu;
const PHONE_PUNCTUATION = /[\s()\-]/gu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const timezoneFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timezoneMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();
const staticWallClockCache = new Map<string, string | Readonly<{ code: "invalid_timezone" | "invalid_wall_clock" | "ambiguous_wall_clock"; message: string }>>();
const STATIC_WALL_CLOCK_CACHE_LIMIT = 100_000;

const STUDENT_REQUIRED_COLUMNS = ["姓名", "手机号", "学员类型"] as const;
const HOURS_REQUIRED_COLUMNS = ["姓名", "手机号", "课程", "课时数", "已消课时", "剩余课时"] as const;
const CONTRACT_REQUIRED_COLUMNS = ["姓名", "手机号", "课程"] as const;
const QUICK_REQUIRED_COLUMNS = ["姓名", "手机号", "学员类型"] as const;

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim()
    : "";
}

function nullableText(value: unknown) {
  const result = text(value);
  return result || undefined;
}

function canonicalPhone(value: unknown) {
  const raw = text(value).replace(PHONE_PUNCTUATION, "");
  if (!raw) return "";
  return raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
}

function requiredColumns(workbook: JiaowubaoStaticWorkbook, columns: readonly string[]) {
  if (!workbook.workbookName.trim()
    || !/^[a-f0-9]{64}$/i.test(workbook.workbookSha256)
    || !Array.isArray(workbook.rows)) {
    throw new JiaowubaoStaticImportError("invalid_workbook", "Static Jiaowubao workbook metadata is invalid.");
  }
  const available = new Set<string>();
  for (const row of workbook.rows) for (const key of Object.keys(row)) available.add(text(key));
  for (const column of columns) {
    if (!available.has(column)) {
      throw new JiaowubaoStaticImportError(
        "missing_required_column",
        `${workbook.workbookName} is missing required column ${column}.`,
      );
    }
  }
}

function optionalNumber(value: unknown, field: string, source: string, row: number) {
  const raw = text(value).replace(/,/gu, "");
  if (!raw) return undefined;
  const parsed = Number(raw);
  const canonical = Math.round(parsed * 1_000_000) / 1_000_000;
  // Excel serialises some visually exact decimal cells through binary floating
  // point (for example `15` as `14.999999999999996`).  Accept only that tiny
  // representation noise, then store the same micro-hour precision used by
  // the rest of the import contracts.  A real value beyond six decimals is
  // still rejected rather than silently rounded.
  if (!Number.isFinite(parsed) || Math.abs(parsed - canonical) > 1e-9) {
    throw new JiaowubaoStaticImportError("invalid_number", `${source} row ${row} has invalid ${field}.`);
  }
  return Object.is(canonical, -0) ? 0 : canonical;
}

function optionalDate(value: unknown, field: string, source: string, row: number) {
  const raw = text(value);
  if (!raw) return undefined;
  if (!ISO_DATE.test(raw)) {
    throw new JiaowubaoStaticImportError("invalid_date", `${source} row ${row} has invalid ${field}.`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new JiaowubaoStaticImportError("invalid_date", `${source} row ${row} has invalid ${field}.`);
  }
  return raw;
}

function sourceRowKey(identityKey: string) {
  return `JWB-STATIC-${createHash("sha256").update(identityKey).digest("hex").slice(0, 32)}`;
}

function identityFor(
  row: JiaowubaoStaticCellRow,
  sourceWorkbook: string,
  sourceRow: number,
): JiaowubaoStaticIdentityResult {
  const name = text(row.姓名);
  const normalizedName = normalizeStudentImportName(name);
  const phone = canonicalPhone(row.手机号);
  if (!normalizedName) {
    return { kind: "issue", issue: { identityKey: "", reason: "empty_name", sourceWorkbook, sourceRow } };
  }
  if (!phone) {
    return { kind: "issue", issue: { identityKey: normalizedName, reason: "missing_phone", sourceWorkbook, sourceRow } };
  }
  const identityKey = `v1:${normalizedName}\u0000${phone}`;
  return {
    kind: "identity",
    identity: {
      identityKey,
      sourceRow: sourceRowKey(identityKey),
      name,
      normalizedName,
      phone,
      ...(nullableText(row.学员编号) ? { externalStudentNumber: nullableText(row.学员编号) } : {}),
    },
  };
}

/**
 * Returns the conservative name-and-phone key used throughout this static
 * import.  It is exported for the record serializer so every workbook uses
 * exactly the same identity boundary as the fact planner; it never matches a
 * Tencent student by itself.
 */
export function jiaowubaoStaticIdentityKeyFor(row: JiaowubaoStaticCellRow) {
  const result = identityFor(row, "static identity", 0);
  return result.kind === "identity" ? result.identity.identityKey : undefined;
}

function valuesEqual(values: readonly (number | undefined)[]) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 && present.every((value) => value === present[0]);
}

function aggregateFor(rows: readonly JiaowubaoStaticHours[], studentRows: readonly JiaowubaoStaticCellRow[]) {
  const studentTotals = studentRows.map((row) => text(row.总课时数)).filter(Boolean)
    .map((value) => Number(value.replace(/,/gu, ""))).filter(Number.isFinite);
  const studentUsed = studentRows.map((row) => text(row.已消课时)).filter(Boolean)
    .map((value) => Number(value.replace(/,/gu, ""))).filter(Number.isFinite);
  const studentRemaining = studentRows.map((row) => text(row.剩余课时)).filter(Boolean)
    .map((value) => Number(value.replace(/,/gu, ""))).filter(Number.isFinite);
  const totals = rows.map((row) => row.totalHours);
  const used = rows.map((row) => row.usedHours);
  const remaining = rows.map((row) => row.remainingHours);
  const choose = (fromStudents: readonly number[], fromHours: readonly (number | undefined)[]) => {
    if (fromStudents.length && fromStudents.every((value) => value === fromStudents[0])) return fromStudents[0];
    if (valuesEqual(fromHours)) return fromHours.find((value) => value !== undefined);
    return undefined;
  };
  const totalHours = choose(studentTotals, totals);
  const usedHours = choose(studentUsed, used);
  const remainingHours = choose(studentRemaining, remaining);
  const crossSheetConsistent = !rows.length
    || !studentTotals.length
    || (totalHours === rows.reduce((sum, row) => sum + (row.totalHours ?? 0), 0)
      && usedHours === rows.reduce((sum, row) => sum + (row.usedHours ?? 0), 0)
      && remainingHours === rows.reduce((sum, row) => sum + (row.remainingHours ?? 0), 0));
  return {
    ...(totalHours !== undefined ? { totalHours } : {}),
    ...(usedHours !== undefined ? { usedHours } : {}),
    ...(remainingHours !== undefined ? { remainingHours } : {}),
    consistency: totalHours === undefined && usedHours === undefined && remainingHours === undefined
      ? "missing" as const
      : crossSheetConsistent ? "verified" as const : "needs_review" as const,
  };
}

/**
 * Builds only raw, non-billable JWB supplement facts.  A later atomic writer
 * can attach a fact to a Tencent student only after a separate match plan has
 * passed.  No JWB-only row is ever converted into a student here.
 */
export function buildJiaowubaoStaticExportPlan(input: JiaowubaoStaticExportInput): JiaowubaoStaticExportPlan {
  requiredColumns(input.quickList, QUICK_REQUIRED_COLUMNS);
  requiredColumns(input.students, STUDENT_REQUIRED_COLUMNS);
  requiredColumns(input.hours, HOURS_REQUIRED_COLUMNS);
  requiredColumns(input.contracts, CONTRACT_REQUIRED_COLUMNS);

  const issues: JiaowubaoStaticUnlinkedFact[] = [];
  const identities = new Map<string, JiaowubaoStaticIdentity>();
  const studentRowsByIdentity = new Map<string, JiaowubaoStaticCellRow[]>();
  const facts = new Map<string, {
    identity: JiaowubaoStaticIdentity;
    studentRows: JiaowubaoStaticCellRow[];
    hours: JiaowubaoStaticHours[];
    contracts: JiaowubaoStaticContract[];
    grade?: string;
    studentType?: string;
    gender?: string;
    birthday?: string;
    age?: string;
    alternatePhone?: string;
    manager?: string;
    classes: Set<string>;
    notes: Set<string>;
  }>();

  const addIdentity = (row: JiaowubaoStaticCellRow, workbook: JiaowubaoStaticWorkbook, sourceRow: number) => {
    const found = identityFor(row, workbook.workbookName, sourceRow);
    if (found.kind === "issue") {
      issues.push(found.issue);
      return undefined;
    }
    const previous = identities.get(found.identity.identityKey);
    if (previous?.externalStudentNumber
      && found.identity.externalStudentNumber
      && previous.externalStudentNumber !== found.identity.externalStudentNumber) {
      issues.push({
        identityKey: found.identity.identityKey,
        reason: "conflicting_external_student_number",
        sourceWorkbook: workbook.workbookName,
        sourceRow,
      });
      return undefined;
    }
    identities.set(found.identity.identityKey, previous ?? found.identity);
    return found.identity;
  };

  let activeStudentRows = 0;
  for (const [index, row] of input.students.rows.entries()) {
    if (text(row.学员类型) !== ACTIVE_STUDENT_TYPE) continue;
    activeStudentRows += 1;
    const identity = addIdentity(row, input.students, index + 2);
    if (!identity) continue;
    const current = facts.get(identity.identityKey) ?? {
      identity,
      studentRows: [],
      hours: [],
      contracts: [],
      classes: new Set<string>(),
      notes: new Set<string>(),
    };
    current.studentRows.push(row);
    current.grade ??= nullableText(row.年级);
    current.studentType ??= nullableText(row.学员类型);
    current.gender ??= nullableText(row.性别);
    current.birthday ??= nullableText(row.出生日期);
    current.age ??= nullableText(row.年龄);
    current.alternatePhone ??= canonicalPhone(row.备用手机号) || undefined;
    current.manager ??= nullableText(row.学管老师);
    const className = nullableText(row.学员所在班级);
    if (className) current.classes.add(className);
    const note = nullableText(row.学员备注);
    if (note) current.notes.add(note);
    facts.set(identity.identityKey, current);
    studentRowsByIdentity.set(identity.identityKey, current.studentRows);
  }

  const mergeProfile = (
    current: {
      grade?: string;
      studentType?: string;
      gender?: string;
      birthday?: string;
      age?: string;
      alternatePhone?: string;
      manager?: string;
      classes: Set<string>;
      notes: Set<string>;
    },
    row: JiaowubaoStaticCellRow,
  ) => {
    current.grade ??= nullableText(row.年级);
    current.studentType ??= nullableText(row.学员类型);
    current.gender ??= nullableText(row.性别);
    current.birthday ??= nullableText(row.出生日期);
    current.age ??= nullableText(row.年龄);
    current.alternatePhone ??= canonicalPhone(row.备用手机号) || undefined;
    current.manager ??= nullableText(row.学管老师);
    const className = nullableText(row.学员所在班级) ?? nullableText(row.所在班级);
    if (className) current.classes.add(className);
    const note = nullableText(row.学员备注);
    if (note) current.notes.add(note);
  };

  for (const [index, row] of input.quickList.rows.entries()) {
    if (text(row.学员类型) !== ACTIVE_STUDENT_TYPE) continue;
    const identity = addIdentity(row, input.quickList, index + 2);
    if (!identity) continue;
    const current = facts.get(identity.identityKey);
    if (!current) {
      issues.push({
        identityKey: identity.identityKey,
        reason: "not_in_active_student_snapshot",
        sourceWorkbook: input.quickList.workbookName,
        sourceRow: index + 2,
      });
      continue;
    }
    mergeProfile(current, row);
  }

  for (const [index, row] of input.hours.rows.entries()) {
    const identity = addIdentity(row, input.hours, index + 2);
    if (!identity || !facts.has(identity.identityKey)) continue;
    const current = facts.get(identity.identityKey)!;
    const course = text(row.课程);
    if (!course) continue;
    current.hours.push({
      course,
      totalHours: optionalNumber(row.课时数, "课时数", input.hours.workbookName, index + 2),
      usedHours: optionalNumber(row.已消课时, "已消课时", input.hours.workbookName, index + 2),
      remainingHours: optionalNumber(row.剩余课时, "剩余课时", input.hours.workbookName, index + 2),
      deadline: optionalDate(row.截止日期, "截止日期", input.hours.workbookName, index + 2),
      sourceWorkbook: input.hours.workbookName,
      sourceRow: index + 2,
    });
    mergeProfile(current, row);
  }

  for (const [index, row] of input.contracts.rows.entries()) {
    const identity = addIdentity(row, input.contracts, index + 2);
    if (!identity || !facts.has(identity.identityKey)) continue;
    const current = facts.get(identity.identityKey)!;
    const course = text(row.课程);
    if (!course) continue;
    current.contracts.push({
      course,
      contractType: nullableText(row.合约类型),
      cardType: nullableText(row.合约卡种),
      totalHours: optionalNumber(row.总课时数, "总课时数", input.contracts.workbookName, index + 2),
      usedHours: optionalNumber(row.已消课时, "已消课时", input.contracts.workbookName, index + 2),
      remainingHours: optionalNumber(row.剩余课时, "剩余课时", input.contracts.workbookName, index + 2),
      effectiveDate: optionalDate(row.合约生效日期, "合约生效日期", input.contracts.workbookName, index + 2),
      signedDate: optionalDate(row.合约签约日期, "合约签约日期", input.contracts.workbookName, index + 2),
      deadline: optionalDate(row.合约截止日期, "合约截止日期", input.contracts.workbookName, index + 2),
      sourceWorkbook: input.contracts.workbookName,
      sourceRow: index + 2,
    });
  }

  const students = [...facts.values()].map((fact) => ({
    identity: fact.identity,
    ...(fact.grade ? { grade: fact.grade } : {}),
    ...(fact.studentType ? { studentType: fact.studentType } : {}),
    ...(fact.gender ? { gender: fact.gender } : {}),
    ...(fact.birthday ? { birthday: fact.birthday } : {}),
    ...(fact.age ? { age: fact.age } : {}),
    ...(fact.alternatePhone ? { alternatePhone: fact.alternatePhone } : {}),
    ...(fact.manager ? { manager: fact.manager } : {}),
    classes: [...fact.classes].sort(),
    notes: [...fact.notes].sort(),
    hours: [...fact.hours],
    contracts: [...fact.contracts],
    aggregate: aggregateFor(fact.hours, studentRowsByIdentity.get(fact.identity.identityKey) ?? []),
  })).sort((left, right) => left.identity.sourceRow.localeCompare(right.identity.sourceRow));

  return {
    format: JIAOWUBAO_STATIC_SOURCE_FORMAT,
    sourceTimezone: JIAOWUBAO_STATIC_SOURCE_TIMEZONE,
    students,
    unlinked: issues,
    summary: {
      activeStudentRows,
      studentFacts: students.length,
      verifiedAggregates: students.filter((fact) => fact.aggregate.consistency === "verified").length,
      reviewAggregates: students.filter((fact) => fact.aggregate.consistency === "needs_review").length,
      unlinkedRows: issues.length,
    },
  };
}

/**
 * Produces exact-match attachments and narrowly scoped annotation review
 * candidates for a new JWB Excel snapshot.  Callers decide whether a review
 * candidate remains quarantined; this helper never creates a master row.
 */
export function matchJiaowubaoStaticFactsToMaster(
  masterRows: readonly MasterStudentImportRow[],
  facts: readonly JiaowubaoStaticStudentFact[],
): JiaowubaoStaticMatchPlan {
  const eligibleMasters = masterRows.filter((row) =>
    text(row.name) && text(row.status) !== "不活跃 + 无课时");
  const masterByName = new Map<string, MasterStudentImportRow[]>();
  for (const row of eligibleMasters) {
    const key = normalizeStudentImportName(row.name);
    if (key) masterByName.set(key, [...(masterByName.get(key) ?? []), row]);
  }
  const factsByName = new Map<string, JiaowubaoStaticStudentFact[]>();
  for (const fact of facts) {
    factsByName.set(fact.identity.normalizedName, [...(factsByName.get(fact.identity.normalizedName) ?? []), fact]);
  }

  const matches: JiaowubaoStaticMasterMatch[] = [];
  const reviewCandidates: JiaowubaoStaticMasterMatch[] = [];
  const usedMasters = new Set<string>();
  const usedFacts = new Set<string>();
  const ambiguousMaster = new Set<StudentImportSourceKey>();
  const ambiguousFact = new Set<string>();

  for (const [name, masters] of masterByName) {
    const candidates = factsByName.get(name) ?? [];
    if (masters.length === 1 && candidates.length === 1) {
      matches.push({ masterSourceRow: masters[0].sourceRow, jwbSourceRow: candidates[0].identity.sourceRow, mode: "exact_name" });
      usedMasters.add(String(masters[0].sourceRow));
      usedFacts.add(candidates[0].identity.sourceRow);
    } else if (candidates.length && masters.length > 1) {
      for (const row of masters) ambiguousMaster.add(row.sourceRow);
      for (const fact of candidates) ambiguousFact.add(fact.identity.sourceRow);
    } else if (masters.length && candidates.length > 1) {
      ambiguousMaster.add(masters[0].sourceRow);
      for (const fact of candidates) ambiguousFact.add(fact.identity.sourceRow);
    }
  }

  const remainingMasters = eligibleMasters.filter((row) => !usedMasters.has(String(row.sourceRow)) && !ambiguousMaster.has(row.sourceRow));
  const remainingFacts = facts.filter((fact) => !usedFacts.has(fact.identity.sourceRow) && !ambiguousFact.has(fact.identity.sourceRow));
  const candidatesByRelaxed = new Map<string, JiaowubaoStaticStudentFact[]>();
  for (const fact of remainingFacts) {
    const base = studentImportJwbLatinParentheticalAnnotationKey(fact.identity.name);
    if (base) candidatesByRelaxed.set(base, [...(candidatesByRelaxed.get(base) ?? []), fact]);
  }
  const mastersByRelaxed = new Map<string, MasterStudentImportRow[]>();
  for (const row of remainingMasters) {
    const displayName = text(row.name);
    const base = /[()]/u.test(displayName) ? "" : normalizeStudentImportName(displayName);
    if (base) mastersByRelaxed.set(base, [...(mastersByRelaxed.get(base) ?? []), row]);
  }
  for (const [base, masters] of mastersByRelaxed) {
    const candidates = candidatesByRelaxed.get(base) ?? [];
    if (masters.length === 1 && candidates.length === 1
      && isStudentImportJwbLatinParentheticalAnnotationMatch(masters[0].name, candidates[0].identity.name)) {
      reviewCandidates.push({
        masterSourceRow: masters[0].sourceRow,
        jwbSourceRow: candidates[0].identity.sourceRow,
        mode: "reviewed_latin_parenthetical_annotation_v1",
      });
      usedMasters.add(String(masters[0].sourceRow));
      usedFacts.add(candidates[0].identity.sourceRow);
    } else if (masters.length > 1 || candidates.length > 1) {
      for (const row of masters) ambiguousMaster.add(row.sourceRow);
      for (const fact of candidates) ambiguousFact.add(fact.identity.sourceRow);
    }
  }

  return {
    matches: matches.sort((left, right) => String(left.masterSourceRow).localeCompare(String(right.masterSourceRow))),
    reviewCandidates: reviewCandidates.sort((left, right) => String(left.masterSourceRow).localeCompare(String(right.masterSourceRow))),
    unmatchedMasterSourceRows: eligibleMasters
      .filter((row) => !usedMasters.has(String(row.sourceRow)) && !ambiguousMaster.has(row.sourceRow))
      .map((row) => row.sourceRow),
    unmatchedJwbSourceRows: facts
      .filter((fact) => !usedFacts.has(fact.identity.sourceRow) && !ambiguousFact.has(fact.identity.sourceRow))
      .map((fact) => fact.identity.sourceRow),
    ambiguousMasterSourceRows: [...ambiguousMaster].sort((left, right) => String(left).localeCompare(String(right))),
    ambiguousJwbSourceRows: [...ambiguousFact].sort(),
  };
}

function timezoneFormatter(timezone: string, seconds: boolean) {
  const cache = seconds ? timezoneFormatterCache : timezoneMinuteFormatterCache;
  const current = cache.get(timezone);
  if (current) return current;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
  cache.set(timezone, formatter);
  return formatter;
}

function zoneOffsetMs(date: Date, timezone: string) {
  const parts = timezoneFormatter(timezone, true).formatToParts(date);
  const part = Object.fromEntries(parts.filter((entry) => entry.type !== "literal").map((entry) => [entry.type, entry.value]));
  return Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute), Number(part.second)) - date.valueOf();
}

function wallClockLabel(date: Date, timezone: string) {
  const parts = timezoneFormatter(timezone, false).formatToParts(date);
  const part = Object.fromEntries(parts.filter((entry) => entry.type !== "literal").map((entry) => [entry.type, entry.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
}

/**
 * Strict wall-clock conversion for static imports.  Unlike cleanTimezone(),
 * this never silently falls back to Melbourne: unknown zones, skipped DST
 * wall times and repeated DST wall times are all rejected for review.
 */
export function staticWallClockToInstant(date: string, start: string, timezone: string) {
  if (!ISO_DATE.test(date) || !TIME.test(start)) {
    throw new JiaowubaoStaticImportError("invalid_wall_clock", "Schedule wall-clock date/time is invalid.");
  }
  const cacheKey = `${timezone}\u0000${date}\u0000${start}`;
  const cached = staticWallClockCache.get(cacheKey);
  if (cached) {
    if (typeof cached === "string") return cached;
    throw new JiaowubaoStaticImportError(cached.code, cached.message);
  }
  try {
    timezoneFormatter(timezone, false).format(0);
  } catch {
    const message = "Schedule source timezone must be a valid IANA timezone.";
    staticWallClockCache.set(cacheKey, Object.freeze({ code: "invalid_timezone", message }));
    throw new JiaowubaoStaticImportError("invalid_timezone", message);
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = start.split(":").map(Number);
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  // A local wall time can only resolve through the offsets on either side of
  // a nearby timezone transition.  Sampling two days around the nominal UTC
  // wall clock catches ordinary DST changes and rare large date-line changes
  // without the former 61-formatter-call scan for every schedule cell.
  const offsets = new Set([-48, -24, 0, 24, 48].map((hours) =>
    zoneOffsetMs(new Date(wallMs + hours * 3_600_000), timezone)));
  const target = `${date} ${start}`;
  const candidates = [...offsets]
    .map((offset) => new Date(wallMs - offset))
    .filter((candidate) => wallClockLabel(candidate, timezone) === target)
    .sort((left, right) => left.valueOf() - right.valueOf());
  if (candidates.length === 0) {
    const message = "Schedule wall-clock time does not exist in the source timezone.";
    staticWallClockCache.set(cacheKey, Object.freeze({ code: "invalid_wall_clock", message }));
    throw new JiaowubaoStaticImportError("invalid_wall_clock", message);
  }
  if (candidates.length > 1) {
    const message = "Schedule wall-clock time is ambiguous in the source timezone.";
    staticWallClockCache.set(cacheKey, Object.freeze({ code: "ambiguous_wall_clock", message }));
    throw new JiaowubaoStaticImportError("ambiguous_wall_clock", message);
  }
  const result = candidates[0].toISOString();
  staticWallClockCache.set(cacheKey, result);
  if (staticWallClockCache.size > STATIC_WALL_CLOCK_CACHE_LIMIT) {
    staticWallClockCache.delete(staticWallClockCache.keys().next().value!);
  }
  return result;
}

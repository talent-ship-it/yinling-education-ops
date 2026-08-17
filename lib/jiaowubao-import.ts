import type {
  JwbLessonPackageImportRow,
  JwbStudentImportRow,
  StudentImportSourceKey,
} from "./student-import";

const HOUR_PRECISION = 1_000_000;

export const JIAOWUBAO_ADDITION_NATURES = ["新签", "续费", "赠送", "转入"] as const;
export const JIAOWUBAO_NEGATIVE_NATURES = ["退费", "转出"] as const;

export type JiaowubaoAdditionNature = (typeof JIAOWUBAO_ADDITION_NATURES)[number];
export type JiaowubaoNegativeNature = (typeof JIAOWUBAO_NEGATIVE_NATURES)[number];
export type JiaowubaoNegativeAdjustmentPolicy = "reject" | "aggregate-only";

export type RawJiaowubaoStudent = Readonly<Record<string, unknown> & {
  mem_id: StudentImportSourceKey;
  /** Jiaowubao installations use either name or mem_name for this display value. */
  name?: string | null;
  mem_name?: string | null;
  ks_total: number | string;
  ks_used: number | string;
  ks_rest: number | string;
}>;

export type RawJiaowubaoContractDetail = Readonly<Record<string, unknown> & {
  detail_id: StudentImportSourceKey;
  course_id: StudentImportSourceKey;
  course_title?: string | null;
  ks: number | string;
  ks_left: number | string;
  end?: string | null;
}>;

export type RawJiaowubaoContract = Readonly<Record<string, unknown> & {
  contract_id: StudentImportSourceKey;
  contract_code?: string | null;
  mem_id: StudentImportSourceKey;
  course_id: StudentImportSourceKey;
  course_title: string;
  nature: StudentImportSourceKey;
  nature_title: string;
  ks: number | string;
  ks_use: number | string;
  ks_left: number | string;
  dated?: string | null;
  contract_dated?: string | null;
  start?: string | null;
  end?: string | null;
  detail_lists: readonly RawJiaowubaoContractDetail[];
}>;

export type RawJiaowubaoCourse = Readonly<Record<string, unknown> & {
  course_id: StudentImportSourceKey;
  title: string;
}>;

export type RawJiaowubaoCourseBalanceCourse = Readonly<Record<string, unknown> & {
  course_id: StudentImportSourceKey;
  title: string;
  ks: number | string;
  ks_use: number | string;
  ks_left: number | string;
}>;

export type RawJiaowubaoCourseBalance = Readonly<Record<string, unknown> & {
  mem_id: StudentImportSourceKey;
  ks_total: number | string;
  ks_used: number | string;
  ks_rest: number | string;
  courses: readonly RawJiaowubaoCourseBalanceCourse[];
}>;

export type JiaowubaoImportInput = Readonly<{
  students: readonly RawJiaowubaoStudent[];
  contracts: readonly RawJiaowubaoContract[];
  /** Authoritative current per-course balances from /api/mem/detail/. */
  courseBalances: readonly RawJiaowubaoCourseBalance[];
  /** When supplied, it is authoritative: every imported contract must occur in it. */
  courses?: readonly RawJiaowubaoCourse[];
  /** Defaults to reject. aggregate-only must be an explicit caller decision. */
  negativeAdjustmentPolicy?: JiaowubaoNegativeAdjustmentPolicy;
}>;

export type JiaowubaoImportErrorCode =
  | "invalid_input"
  | "invalid_student"
  | "duplicate_student"
  | "invalid_contract"
  | "duplicate_contract"
  | "duplicate_detail"
  | "invalid_course"
  | "duplicate_course"
  | "invalid_course_balance"
  | "duplicate_course_balance"
  | "missing_course_balance"
  | "unknown_contract_nature"
  | "negative_adjustment_requires_review"
  | "negative_balance_requires_review"
  | "package_history_requires_review"
  | "purchase_history_shortfall"
  | "missing_purchase_date"
  | "balance_mismatch"
  | "course_detail_mismatch";

export class JiaowubaoImportError extends Error {
  constructor(
    readonly code: JiaowubaoImportErrorCode,
    message: string,
    readonly sourceId?: StudentImportSourceKey,
  ) {
    super(message);
    this.name = "JiaowubaoImportError";
  }
}

type Hours = Readonly<{ total: number; used: number; remaining: number }>;

type NormalizedStudent = Readonly<{
  memId: string;
  name: string;
  hours: Hours;
}>;

type NormalizedCourseBalanceCourse = Readonly<{
  courseId: string;
  title: string;
  hours: Hours;
}>;

type NormalizedCourseBalance = Readonly<{
  memId: string;
  hours: Hours;
  courses: readonly NormalizedCourseBalanceCourse[];
}>;

type NormalizedDetail = Readonly<{
  detailId: string;
  courseId: string;
  courseTitle?: string;
  total: number;
  remaining: number;
}>;

type NormalizedContract = Readonly<{
  contractId: string;
  contractCode?: string;
  memId: string;
  courseId: string;
  courseTitle: string;
  nature: string;
  natureTitle: JiaowubaoAdditionNature | JiaowubaoNegativeNature;
  direction: "addition" | "negative";
  hours: Hours;
  purchasedAt?: string;
  effectiveDate?: string;
  detail: NormalizedDetail;
}>;

function roundHours(value: number) {
  return Math.round(value * HOUR_PRECISION) / HOUR_PRECISION;
}

function equalHours(left: number, right: number) {
  const leftMicrohours = Math.round(roundHours(left) * HOUR_PRECISION);
  const rightMicrohours = Math.round(roundHours(right) * HOUR_PRECISION);
  return Number.isSafeInteger(leftMicrohours)
    && Number.isSafeInteger(rightMicrohours)
    && leftMicrohours === rightMicrohours;
}

function microhours(
  value: number,
  field: string,
  code: JiaowubaoImportErrorCode,
  sourceId?: StudentImportSourceKey,
) {
  const rounded = roundHours(value);
  const result = Math.round(value * HOUR_PRECISION);
  if (rounded !== value || !Number.isSafeInteger(result)) {
    throw new JiaowubaoImportError(
      code,
      `${field} must be an exact micro-hour within the safe aggregate range`,
      sourceId,
    );
  }
  return result;
}

function sumHours(
  values: readonly number[],
  field: string,
  code: JiaowubaoImportErrorCode,
  sourceId?: StudentImportSourceKey,
) {
  let total = 0;
  for (const value of values) {
    const next = total + microhours(value, field, code, sourceId);
    if (!Number.isSafeInteger(next)) {
      throw new JiaowubaoImportError(code, `${field} total exceeds the safe micro-hour range`, sourceId);
    }
    total = next;
  }
  return total / HOUR_PRECISION;
}

function subtractHours(
  left: number,
  right: number,
  field: string,
  code: JiaowubaoImportErrorCode,
  sourceId?: StudentImportSourceKey,
) {
  const result = microhours(left, field, code, sourceId) - microhours(right, field, code, sourceId);
  if (!Number.isSafeInteger(result)) {
    throw new JiaowubaoImportError(code, `${field} difference exceeds the safe micro-hour range`, sourceId);
  }
  return result / HOUR_PRECISION;
}

function sourceKey(value: unknown, field: string, code: JiaowubaoImportErrorCode, sourceId?: StudentImportSourceKey) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new JiaowubaoImportError(code, `${field} must be a stable string or integer`, sourceId);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new JiaowubaoImportError(code, `${field} must be a stable string or integer`, sourceId);
  }
  const clean = String(value).trim();
  if (!clean || clean.length > 240) {
    throw new JiaowubaoImportError(code, `${field} must contain 1 to 240 characters`, sourceId);
  }
  return clean;
}

function cleanText(value: unknown, field: string, code: JiaowubaoImportErrorCode, sourceId?: StudentImportSourceKey) {
  if (typeof value !== "string") throw new JiaowubaoImportError(code, `${field} must be text`, sourceId);
  const clean = value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[\s\u3000]+/g, " ").trim();
  if (!clean || clean.length > 240) {
    throw new JiaowubaoImportError(code, `${field} must contain 1 to 240 characters`, sourceId);
  }
  return clean;
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const clean = value.normalize("NFKC").trim();
  return clean || undefined;
}

function hours(value: unknown, field: string, code: JiaowubaoImportErrorCode, sourceId?: StudentImportSourceKey) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new JiaowubaoImportError(code, `${field} must be a non-negative number`, sourceId);
  }
  return microhours(parsed, field, code, sourceId) / HOUR_PRECISION;
}

function signedHours(value: unknown, field: string, code: JiaowubaoImportErrorCode, sourceId?: StudentImportSourceKey) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new JiaowubaoImportError(code, `${field} must be a finite number`, sourceId);
  }
  return microhours(parsed, field, code, sourceId) / HOUR_PRECISION;
}

function balancedHours(
  totalValue: unknown,
  usedValue: unknown,
  remainingValue: unknown,
  field: string,
  code: JiaowubaoImportErrorCode,
  sourceId?: StudentImportSourceKey,
): Hours {
  const total = hours(totalValue, `${field}.total`, code, sourceId);
  const used = hours(usedValue, `${field}.used`, code, sourceId);
  const remaining = hours(remainingValue, `${field}.remaining`, code, sourceId);
  if (!equalHours(total, sumHours([used, remaining], field, code, sourceId))) {
    throw new JiaowubaoImportError(
      "balance_mismatch",
      `${field} total must equal used plus remaining`,
      sourceId,
    );
  }
  return { total, used, remaining };
}

function currentBalancedHours(
  totalValue: unknown,
  usedValue: unknown,
  remainingValue: unknown,
  field: string,
  code: JiaowubaoImportErrorCode,
  sourceId?: StudentImportSourceKey,
): Hours {
  const total = hours(totalValue, `${field}.total`, code, sourceId);
  const used = hours(usedValue, `${field}.used`, code, sourceId);
  const remaining = signedHours(remainingValue, `${field}.remaining`, code, sourceId);
  if (!equalHours(total, sumHours([used, remaining], field, code, sourceId))) {
    throw new JiaowubaoImportError(
      "balance_mismatch",
      `${field} total must equal used plus remaining`,
      sourceId,
    );
  }
  return { total, used, remaining };
}

function negativeContractHours(
  totalValue: unknown,
  usedValue: unknown,
  remainingValue: unknown,
  field: string,
  sourceId: StudentImportSourceKey,
): Hours {
  const total = signedHours(totalValue, `${field}.total`, "invalid_contract", sourceId);
  const used = signedHours(usedValue, `${field}.used`, "invalid_contract", sourceId);
  const remaining = signedHours(remainingValue, `${field}.remaining`, "invalid_contract", sourceId);
  if (total > 0 || used > 0 || remaining > 0
    || !equalHours(total, sumHours([used, remaining], field, "invalid_contract", sourceId))) {
    throw new JiaowubaoImportError(
      "balance_mismatch",
      `${field} for refund/transfer-out must be signed non-positive values whose total equals used plus remaining`,
      sourceId,
    );
  }
  return { total, used, remaining };
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

function addDeduplicated<Value>(
  target: Map<string, Value>,
  key: string,
  value: Value,
  conflictCode: JiaowubaoImportErrorCode,
  label: string,
  sourceId?: StudentImportSourceKey,
) {
  const existing = target.get(key);
  if (existing === undefined) {
    target.set(key, value);
    return;
  }
  if (stableValue(existing) !== stableValue(value)) {
    throw new JiaowubaoImportError(conflictCode, `Conflicting duplicate ${label}: ${key}`, sourceId);
  }
}

function validDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateOnly(value: unknown, field: string, sourceId: StudentImportSourceKey) {
  const clean = optionalText(value);
  if (!clean) return undefined;
  const candidate = clean.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  // JWB uses this sentinel for an unset date. It is absence, not malformed
  // calendar data; valid purchase dates are still required for additions.
  if (candidate === "0000-00-00") return undefined;
  if (!candidate || !validDateOnly(candidate)) {
    throw new JiaowubaoImportError("invalid_contract", `${field} must start with a valid YYYY-MM-DD date`, sourceId);
  }
  return candidate;
}

function studentName(student: RawJiaowubaoStudent, memId: string) {
  const name = optionalText(student.name);
  const memName = optionalText(student.mem_name);
  if (name && memName && cleanText(name, "name", "invalid_student", memId) !== cleanText(memName, "mem_name", "invalid_student", memId)) {
    throw new JiaowubaoImportError("invalid_student", "name and mem_name disagree", memId);
  }
  return cleanText(name ?? memName, "name or mem_name", "invalid_student", memId);
}

function normalizeStudents(value: readonly RawJiaowubaoStudent[]) {
  const result = new Map<string, NormalizedStudent>();
  for (const student of value) {
    if (!student || typeof student !== "object" || Array.isArray(student)) {
      throw new JiaowubaoImportError("invalid_student", "Each student must be an object");
    }
    const memId = sourceKey(student.mem_id, "mem_id", "invalid_student", student.mem_id);
    const normalized: NormalizedStudent = {
      memId,
      name: studentName(student, memId),
      hours: currentBalancedHours(
        student.ks_total,
        student.ks_used,
        student.ks_rest,
        "student hours",
        "invalid_student",
        memId,
      ),
    };
    addDeduplicated(result, memId, normalized, "duplicate_student", "student", memId);
  }
  return result;
}

function normalizeCourses(value: readonly RawJiaowubaoCourse[] | undefined) {
  if (value === undefined) return undefined;
  const result = new Map<string, string>();
  for (const course of value) {
    if (!course || typeof course !== "object" || Array.isArray(course)) {
      throw new JiaowubaoImportError("invalid_course", "Each course must be an object");
    }
    const courseId = sourceKey(course.course_id, "course_id", "invalid_course", course.course_id);
    const title = cleanText(course.title, "course title", "invalid_course", courseId);
    addDeduplicated(result, courseId, title, "duplicate_course", "course", courseId);
  }
  return result;
}

function normalizeCourseBalances(
  value: readonly RawJiaowubaoCourseBalance[],
  students: ReadonlyMap<string, NormalizedStudent>,
  courseCatalogue: ReadonlyMap<string, string> | undefined,
) {
  const result = new Map<string, NormalizedCourseBalance>();
  for (const rawBalance of value) {
    if (!rawBalance || typeof rawBalance !== "object" || Array.isArray(rawBalance)) {
      throw new JiaowubaoImportError("invalid_course_balance", "Each course balance must be an object");
    }
    const memId = sourceKey(
      rawBalance.mem_id,
      "course balance mem_id",
      "invalid_course_balance",
      rawBalance.mem_id,
    );
    if (!students.has(memId)) {
      throw new JiaowubaoImportError(
        "invalid_course_balance",
        "Course balance belongs to a student absent from the supplied student list",
        memId,
      );
    }
    if (result.has(memId)) {
      throw new JiaowubaoImportError(
        "duplicate_course_balance",
        `Every student must have exactly one course balance row: ${memId}`,
        memId,
      );
    }
    if (!Array.isArray(rawBalance.courses)) {
      throw new JiaowubaoImportError(
        "invalid_course_balance",
        "Course balance courses must be an array",
        memId,
      );
    }
    const aggregate = currentBalancedHours(
      rawBalance.ks_total,
      rawBalance.ks_used,
      rawBalance.ks_rest,
      "course balance aggregate",
      "invalid_course_balance",
      memId,
    );
    const courseIds = new Set<string>();
    const courses = rawBalance.courses.map((rawCourse) => {
      if (!rawCourse || typeof rawCourse !== "object" || Array.isArray(rawCourse)) {
        throw new JiaowubaoImportError(
          "invalid_course_balance",
          "Each current course balance must be an object",
          memId,
        );
      }
      const courseId = sourceKey(
        rawCourse.course_id,
        "course balance course_id",
        "invalid_course_balance",
        memId,
      );
      if (courseIds.has(courseId)) {
        throw new JiaowubaoImportError(
          "duplicate_course_balance",
          `Course ${courseId} occurs more than once for one student`,
          memId,
        );
      }
      courseIds.add(courseId);
      const title = cleanText(rawCourse.title, "course balance title", "invalid_course_balance", memId);
      if (courseCatalogue) {
        const catalogueTitle = courseCatalogue.get(courseId);
        if (catalogueTitle === undefined || catalogueTitle !== title) {
          throw new JiaowubaoImportError(
            "invalid_course",
            "Current balance course is missing from or disagrees with the supplied course catalogue",
            courseId,
          );
        }
      }
      return {
        courseId,
        title,
        hours: currentBalancedHours(
          rawCourse.ks,
          rawCourse.ks_use,
          rawCourse.ks_left,
          `course balance ${courseId}`,
          "invalid_course_balance",
          memId,
        ),
      } satisfies NormalizedCourseBalanceCourse;
    });
    const courseSum = {
      total: sumHours(courses.map((course) => course.hours.total), "course total hours", "invalid_course_balance", memId),
      used: sumHours(courses.map((course) => course.hours.used), "course used hours", "invalid_course_balance", memId),
      remaining: sumHours(
        courses.map((course) => course.hours.remaining),
        "course remaining hours",
        "invalid_course_balance",
        memId,
      ),
    } satisfies Hours;
    if (!equalHours(courseSum.total, aggregate.total)
      || !equalHours(courseSum.used, aggregate.used)
      || !equalHours(courseSum.remaining, aggregate.remaining)) {
      throw new JiaowubaoImportError(
        "balance_mismatch",
        "Current per-course balances must sum to the course-balance aggregate",
        memId,
      );
    }
    result.set(memId, { memId, hours: aggregate, courses });
  }
  for (const student of students.values()) {
    const balance = result.get(student.memId);
    if (!balance) {
      throw new JiaowubaoImportError(
        "missing_course_balance",
        "Every supplied student needs exactly one authoritative course balance",
        student.memId,
      );
    }
    if (!equalHours(balance.hours.total, student.hours.total)
      || !equalHours(balance.hours.used, student.hours.used)
      || !equalHours(balance.hours.remaining, student.hours.remaining)) {
      throw new JiaowubaoImportError(
        "balance_mismatch",
        "Course-balance aggregate must equal the student-list aggregate",
        student.memId,
      );
    }
  }
  return result;
}

function contractNature(value: unknown, sourceId: StudentImportSourceKey) {
  const title = cleanText(value, "nature_title", "invalid_contract", sourceId);
  if ((JIAOWUBAO_ADDITION_NATURES as readonly string[]).includes(title)) {
    return { natureTitle: title as JiaowubaoAdditionNature, direction: "addition" as const };
  }
  if ((JIAOWUBAO_NEGATIVE_NATURES as readonly string[]).includes(title)) {
    return { natureTitle: title as JiaowubaoNegativeNature, direction: "negative" as const };
  }
  throw new JiaowubaoImportError(
    "unknown_contract_nature",
    `Unsupported Jiaowubao contract nature: ${title}`,
    sourceId,
  );
}

function normalizeContract(contract: RawJiaowubaoContract): NormalizedContract {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new JiaowubaoImportError("invalid_contract", "Each contract must be an object");
  }
  const contractId = sourceKey(contract.contract_id, "contract_id", "invalid_contract", contract.contract_id);
  const memId = sourceKey(contract.mem_id, "mem_id", "invalid_contract", contractId);
  const courseId = sourceKey(contract.course_id, "course_id", "invalid_contract", contractId);
  const courseTitle = cleanText(contract.course_title, "course_title", "invalid_contract", contractId);
  const nature = sourceKey(contract.nature, "nature", "invalid_contract", contractId);
  const classified = contractNature(contract.nature_title, contractId);
  const contractHours = classified.direction === "negative"
    ? negativeContractHours(contract.ks, contract.ks_use, contract.ks_left, "contract hours", contractId)
    : balancedHours(
      contract.ks,
      contract.ks_use,
      contract.ks_left,
      "contract hours",
      "invalid_contract",
      contractId,
    );
  if (!Array.isArray(contract.detail_lists) || contract.detail_lists.length !== 1) {
    throw new JiaowubaoImportError(
      "invalid_contract",
      "detail_lists must contain exactly one course detail",
      contractId,
    );
  }
  const rawDetail = contract.detail_lists[0];
  if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail)) {
    throw new JiaowubaoImportError("invalid_contract", "Contract detail must be an object", contractId);
  }
  const detailId = sourceKey(rawDetail.detail_id, "detail_id", "invalid_contract", contractId);
  const detailCourseId = sourceKey(rawDetail.course_id, "detail course_id", "invalid_contract", contractId);
  const detailTitle = optionalText(rawDetail.course_title);
  const detailTotal = classified.direction === "negative"
    ? signedHours(rawDetail.ks, "detail.ks", "invalid_contract", contractId)
    : hours(rawDetail.ks, "detail.ks", "invalid_contract", contractId);
  const detailRemaining = classified.direction === "negative"
    ? signedHours(rawDetail.ks_left, "detail.ks_left", "invalid_contract", contractId)
    : hours(rawDetail.ks_left, "detail.ks_left", "invalid_contract", contractId);
  if (classified.direction === "negative" && (detailTotal > 0 || detailRemaining > 0)) {
    throw new JiaowubaoImportError(
      "course_detail_mismatch",
      "Refund/transfer-out course details must preserve their non-positive signed hours",
      contractId,
    );
  }
  if (detailCourseId !== courseId
    || (detailTitle !== undefined && cleanText(detailTitle, "detail course_title", "invalid_contract", contractId) !== courseTitle)
    || !equalHours(detailTotal, contractHours.total)
    ) {
    throw new JiaowubaoImportError(
      "course_detail_mismatch",
      "Contract and its course detail must identify the same course and purchased hours",
      contractId,
    );
  }
  const contractDated = dateOnly(contract.contract_dated, "contract_dated", contractId);
  const dated = dateOnly(contract.dated, "dated", contractId);
  const start = dateOnly(contract.start, "start", contractId);
  const purchasedAt = contractDated ?? dated ?? start;
  if (classified.direction === "addition" && !purchasedAt) {
    throw new JiaowubaoImportError(
      "missing_purchase_date",
      "An addition contract needs contract_dated, dated, or start",
      contractId,
    );
  }
  return {
    contractId,
    ...(optionalText(contract.contract_code) ? { contractCode: optionalText(contract.contract_code) } : {}),
    memId,
    courseId,
    courseTitle,
    nature,
    ...classified,
    hours: contractHours,
    ...(purchasedAt ? { purchasedAt } : {}),
    ...(start ? { effectiveDate: start } : {}),
    detail: {
      detailId,
      courseId: detailCourseId,
      ...(detailTitle ? { courseTitle: cleanText(detailTitle, "detail course_title", "invalid_contract", contractId) } : {}),
      total: detailTotal,
      remaining: detailRemaining,
    },
  };
}

function normalizeVisibleContracts(
  value: readonly RawJiaowubaoContract[],
  visibleMemIds: ReadonlySet<string>,
  courseCatalogue: ReadonlyMap<string, string> | undefined,
) {
  const contracts = new Map<string, NormalizedContract>();
  const detailOwners = new Map<string, string>();
  for (const rawContract of value) {
    if (!rawContract || typeof rawContract !== "object" || Array.isArray(rawContract)) {
      throw new JiaowubaoImportError("invalid_contract", "Each contract must be an object");
    }
    const memId = sourceKey(rawContract.mem_id, "mem_id", "invalid_contract", rawContract.contract_id);
    if (!visibleMemIds.has(memId)) continue;
    const contract = normalizeContract(rawContract);
    if (courseCatalogue) {
      const catalogueTitle = courseCatalogue.get(contract.courseId);
      if (catalogueTitle === undefined || catalogueTitle !== contract.courseTitle) {
        throw new JiaowubaoImportError(
          "invalid_course",
          "Contract course is missing from or disagrees with the supplied course catalogue",
          contract.contractId,
        );
      }
    }
    addDeduplicated(
      contracts,
      contract.contractId,
      contract,
      "duplicate_contract",
      "contract",
      contract.contractId,
    );
    const detailOwner = detailOwners.get(contract.detail.detailId);
    if (detailOwner !== undefined && detailOwner !== contract.contractId) {
      throw new JiaowubaoImportError(
        "duplicate_detail",
        `Course detail ${contract.detail.detailId} belongs to more than one contract`,
        contract.contractId,
      );
    }
    detailOwners.set(contract.detail.detailId, contract.contractId);
  }
  return [...contracts.values()];
}

function packagesForStudent(
  student: NormalizedStudent,
  currentBalance: NormalizedCourseBalance,
  contracts: readonly NormalizedContract[],
): Readonly<{
  packages: readonly JwbLessonPackageImportRow[];
  unresolvedCourses: readonly NormalizedCourseBalanceCourse[];
}> {
  const byCourse = new Map<string, NormalizedContract[]>();
  for (const contract of contracts) {
    if (contract.direction !== "addition") continue;
    byCourse.set(contract.courseId, [...(byCourse.get(contract.courseId) ?? []), contract]);
  }
  const packages: JwbLessonPackageImportRow[] = [];
  const unresolvedCourses: NormalizedCourseBalanceCourse[] = [];
  for (const course of [...currentBalance.courses]
    .sort((left, right) => left.courseId.localeCompare(right.courseId))) {
      const courseContracts = byCourse.get(course.courseId) ?? [];
      if (courseContracts.length === 0) {
        unresolvedCourses.push(course);
        continue;
      }
      // Zero-hour administrative contracts are retained in the source audit but
      // cannot be represented as a purchase record (the domain requires a
      // positive purchase). They do not contribute to the ledger total.
      const purchaseContracts = courseContracts.filter((contract) => contract.hours.total > 0);
      if (purchaseContracts.length === 0) {
        unresolvedCourses.push(course);
        continue;
      }
      const purchasedHours = sumHours(
        purchaseContracts.map((contract) => contract.hours.total),
        `course ${course.courseId} purchase hours`,
        "purchase_history_shortfall",
        student.memId,
      );
      if (purchasedHours < course.hours.total && !equalHours(purchasedHours, course.hours.total)) {
        throw new JiaowubaoImportError(
          "purchase_history_shortfall",
          `Positive purchase history for course ${course.courseId} is smaller than its current total`,
          student.memId,
        );
      }
      const consumedHours = subtractHours(
        purchasedHours,
        course.hours.remaining,
        `course ${course.courseId} consumed hours`,
        "purchase_history_shortfall",
        student.memId,
      );
      if (consumedHours < 0) {
        throw new JiaowubaoImportError(
          "purchase_history_shortfall",
          `Purchase history for course ${course.courseId} cannot represent its current remaining balance`,
          student.memId,
        );
      }
      packages.push({
        sourcePackageId: course.courseId,
        name: course.title,
        // JWB exposes a course rather than a separate subject entity. Retain the
        // human-readable authoritative course title; do not guess a taxonomy.
        subjectIds: [course.title],
        purchaseRecords: [...purchaseContracts]
          .sort((left, right) => left.purchasedAt!.localeCompare(right.purchasedAt!)
            || left.contractId.localeCompare(right.contractId))
          .map((contract) => ({
            sourcePurchaseId: contract.contractId,
            purchasedAt: contract.purchasedAt!,
            hours: contract.hours.total,
            note: contract.natureTitle,
          })),
        // Historical contract usage is not a current balance. Derive consumption
        // solely so this ledger's remaining hours equal the authoritative detail.
        consumedHours,
      } satisfies JwbLessonPackageImportRow);
    }
  return { packages, unresolvedCourses };
}

/**
 * Converts already-fetched Jiaowubao arrays into the system's strict import
 * contract. This module performs no network calls and intentionally ignores
 * payment amounts and every unrelated API field.
 */
export function adaptJiaowubaoImportRows(input: JiaowubaoImportInput): readonly JwbStudentImportRow[] {
  if (!input || typeof input !== "object"
    || !Array.isArray(input.students)
    || !Array.isArray(input.contracts)
    || !Array.isArray(input.courseBalances)
    || (input.courses !== undefined && !Array.isArray(input.courses))) {
    throw new JiaowubaoImportError(
      "invalid_input",
      "students, contracts, courseBalances, and optional courses must be arrays",
    );
  }
  const negativePolicy = input.negativeAdjustmentPolicy ?? "reject";
  if (negativePolicy !== "reject" && negativePolicy !== "aggregate-only") {
    throw new JiaowubaoImportError("invalid_input", "Unsupported negative adjustment policy");
  }

  const students = normalizeStudents(input.students);
  const courses = normalizeCourses(input.courses);
  const currentBalances = normalizeCourseBalances(input.courseBalances, students, courses);
  const contracts = normalizeVisibleContracts(input.contracts, new Set(students.keys()), courses);
  const contractsByStudent = new Map<string, NormalizedContract[]>();
  for (const contract of contracts) {
    contractsByStudent.set(contract.memId, [...(contractsByStudent.get(contract.memId) ?? []), contract]);
  }

  return [...students.values()]
    .sort((left, right) => left.memId.localeCompare(right.memId))
    .map((student) => {
      const studentContracts = contractsByStudent.get(student.memId) ?? [];
      const currentBalance = currentBalances.get(student.memId)!;
      const negativeContracts = studentContracts.filter((contract) => contract.direction === "negative");
      const hasNegativeBalance = student.hours.remaining < 0
        || currentBalance.courses.some((course) => course.hours.remaining < 0);
      if (hasNegativeBalance && negativePolicy === "reject") {
        throw new JiaowubaoImportError(
          "negative_balance_requires_review",
          "Negative aggregate or per-course balances require explicit aggregate-only handling",
          student.memId,
        );
      }
      if (negativeContracts.length && negativePolicy === "reject") {
        throw new JiaowubaoImportError(
          "negative_adjustment_requires_review",
          "Refund and transfer-out contracts require explicit reviewed handling",
          student.memId,
        );
      }
      const forceAggregateOnly = negativePolicy === "aggregate-only"
        && (hasNegativeBalance || negativeContracts.length > 0);
      const packageResult = forceAggregateOnly
        ? { packages: [], unresolvedCourses: [...currentBalance.courses] }
        : packagesForStudent(student, currentBalance, studentContracts);
      const lessonPackages = packageResult.packages;
      const unresolvedCourses = packageResult.unresolvedCourses;
      if (!forceAggregateOnly && unresolvedCourses.length && negativePolicy === "reject") {
        throw new JiaowubaoImportError(
          "package_history_requires_review",
          "Current course balances without positive purchase history require explicit partial-package review",
          student.memId,
        );
      }
      const packageCoverage = forceAggregateOnly || currentBalance.courses.length === 0
        ? "none" as const
        : unresolvedCourses.length === 0
        ? "complete" as const
        : lessonPackages.length
          ? "partial" as const
          : "none" as const;
      // Keep the existing contract-effective date separate from the date used
      // for the human-facing student number. A course may start later than
      // the moment its positive hours were first recorded in JWB.
      const effectiveDates = studentContracts
        .filter((contract) => contract.direction === "addition")
        .map((contract) => contract.effectiveDate)
        .filter((value): value is string => Boolean(value))
        .sort();
      // `purchasedAt` is contract_dated, then dated, then start. This is the
      // earliest positive JWB contract date, rather than a later start date;
      // it is not asserted to be the database record's created_at timestamp.
      const firstHourEntryDates = studentContracts
        .filter((contract) => contract.direction === "addition" && contract.hours.total > 0)
        .map((contract) => contract.purchasedAt)
        .filter((value): value is string => Boolean(value))
        .sort();
      const packagePurchaseHours = sumHours(
        lessonPackages.flatMap((lessonPackage) =>
          lessonPackage.purchaseRecords.map((purchase) => Number(purchase.hours))),
        "student package purchase hours",
        "purchase_history_shortfall",
        student.memId,
      );
      return {
        sourceRow: student.memId,
        name: student.name,
        remainingHours: student.hours.remaining,
        // With a package ledger this field follows the domain schema and is
        // the historical purchase total. The current JWB total remains in the
        // audit metadata below. Aggregate-only rows retain the current total.
        contractHours: packageCoverage === "complete" ? packagePurchaseHours : student.hours.total,
        packageCoverage,
        ...(effectiveDates[0] ? { contractEffectiveDate: effectiveDates[0] } : {}),
        ...(firstHourEntryDates[0] ? { firstJwbHourEntryDate: firstHourEntryDates[0] } : {}),
        ...(lessonPackages.length ? { lessonPackages } : {}),
        ...(packageCoverage !== "complete" ? {
          attributes: {
            jiaowubaoPackageImport: {
              status: forceAggregateOnly
                ? hasNegativeBalance && negativeContracts.length
                  ? "aggregate_only_negative_balance_and_adjustment"
                  : hasNegativeBalance
                    ? "aggregate_only_negative_balance"
                    : "aggregate_only_negative_adjustment"
                : currentBalance.courses.length === 0
                ? "aggregate_only_no_current_courses"
                : packageCoverage === "partial"
                ? "partial_packages_unresolved_course_balances"
                : "aggregate_only_missing_purchase_history",
              currentTotalHours: student.hours.total,
              currentUsedHours: student.hours.used,
              currentRemainingHours: student.hours.remaining,
              unresolvedCourseBalances: unresolvedCourses.map((course) => ({
                courseId: course.courseId,
                title: course.title,
                totalHours: course.hours.total,
                usedHours: course.hours.used,
                remainingHours: course.hours.remaining,
              })),
              adjustmentContracts: negativeContracts
                .sort((left, right) => left.contractId.localeCompare(right.contractId))
                .map((contract) => ({
                  contractId: contract.contractId,
                  nature: contract.natureTitle,
                  courseId: contract.courseId,
                  hoursDelta: contract.hours.total,
                })),
            },
          },
        } : (lessonPackages.length || negativeContracts.length) ? {
          attributes: {
            jiaowubaoPackageImport: {
              status: negativeContracts.length
                ? "packages_from_current_balances_with_negative_adjustment_audit"
                : "packages_from_current_course_balances",
              currentTotalHours: student.hours.total,
              currentUsedHours: student.hours.used,
              currentRemainingHours: student.hours.remaining,
              adjustmentContracts: negativeContracts
                .sort((left, right) => left.contractId.localeCompare(right.contractId))
                .map((contract) => ({
                  contractId: contract.contractId,
                  nature: contract.natureTitle,
                  courseId: contract.courseId,
                  hoursDelta: contract.hours.total,
                })),
            },
          },
        } : {}),
      } satisfies JwbStudentImportRow;
    });
}

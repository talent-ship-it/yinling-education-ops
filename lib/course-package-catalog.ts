import {
  getLessonPackageBalance,
  type LessonPackageBalance,
  type StudentLessonPackage,
} from "@/lib/student-records";

export type CourseCatalogRecord = Readonly<{
  id: string;
  name: string;
  status: "在用" | "已完结";
  source: string;
}>;

export type CoursePackageCatalogStudent = Readonly<{
  id: string;
  name: string;
  course?: string | null;
  /**
   * Canonical active ledger only. JWB rows reach this field only after the
   * student-import projection validates their identity, package and purchase
   * shape; manual/direct-enrolment packages use the same domain shape.
   */
  lessonPackages?: readonly StudentLessonPackage[];
  packageCoverage?: "complete" | "partial" | "none";
  /** Archived students are a type error and are also rejected at runtime. */
  importArchived?: false;
  /** Historical JWB evidence is deliberately accepted only to be ignored. */
  historicalJwbSnapshot?: unknown;
}>;

export type CoursePackageCatalogBooking = Readonly<{
  id: string;
  studentId: string;
  course?: string | null;
}>;

export type CoursePackageCatalogTeacher = Readonly<{
  id: string;
  name: string;
  subjects?: readonly string[];
}>;

export type CourseCatalogEvidence = "catalog" | "lesson_package" | "student_profile" | "booking";

export type CoursePackageCatalogPurchase = Readonly<{
  /** Safe React identity derived only from canonical input ordinals. */
  viewKey: string;
  id: string;
  studentId: string;
  studentName: string;
  packageId: string;
  packageName: string;
  purchasedAt: string;
  hours: number;
  purchasedHours?: number;
  bonusHours?: number;
}>;

export type CoursePackageCatalogPackage = Readonly<{
  /** Safe React identity derived only from canonical input ordinals. */
  viewKey: string;
  studentId: string;
  studentName: string;
  packageId: string;
  packageName: string;
  subjectIds: readonly string[];
  balance: LessonPackageBalance | null;
  sharedAcrossSubjects: boolean;
}>;

export type CoursePackageCoverage = Readonly<{
  complete: number;
  partial: number;
  none: number;
}>;

export type CoursePackageCatalogEntry = Readonly<{
  /** Stable UI identity. Derived entries are never persisted as a second catalogue. */
  id: string;
  name: string;
  status: CourseCatalogRecord["status"];
  source: string;
  catalogRecordIds: readonly string[];
  evidence: readonly CourseCatalogEvidence[];
  isCatalogued: boolean;
  bookingCount: number;
  linkedStudentCount: number;
  /** Null means teacher eligibility was not authorized for this projection. */
  eligibleTeacherCount: number | null;
  eligibleTeachers: readonly Readonly<{ id: string; name: string }>[] | null;
  packageCount: number;
  invalidPackageCount: number;
  packages: readonly CoursePackageCatalogPackage[];
  purchases: readonly CoursePackageCatalogPurchase[];
  purchaseRecordCount: number;
  structuredPurchaseRecordCount: number;
  totalHours: number;
  purchasedHours: number;
  bonusHours: number;
  unclassifiedHours: number;
  consumedHours: number;
  remainingHours: number;
  coverage: CoursePackageCoverage;
  studentsWithoutPackage: readonly Readonly<{ id: string; name: string }>[];
}>;

export type BuildCoursePackageCatalogInput = Readonly<{
  courses: readonly CourseCatalogRecord[];
  students: readonly CoursePackageCatalogStudent[];
  bookings: readonly CoursePackageCatalogBooking[];
  teachers?: readonly CoursePackageCatalogTeacher[];
  /** Must be set only by an admin-authorized host projection. */
  includeTeacherEligibility?: boolean;
}>;

/** Narrows the host's Student union before it reaches the active-only builder. */
export function isActiveCoursePackageCatalogStudent<T extends { importArchived?: boolean }>(
  student: T,
): student is T & { importArchived?: false } {
  return student.importArchived !== true;
}

type CourseSeed = {
  id: string;
  name: string;
  status: CourseCatalogRecord["status"];
  sources: string[];
  catalogRecordIds: string[];
  evidence: CourseCatalogEvidence[];
  firstSeen: number;
};

const HOURS_PRECISION = 1_000_000;

function cleanCourseName(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function courseKey(value: string | null | undefined) {
  // Scheduling and package validation use exact subject labels. Only trim the
  // transport whitespace here; case-folding or taxonomy aliases would merge
  // distinct authoritative subjects.
  return cleanCourseName(value);
}

function uniquePush<T>(values: T[], value: T) {
  if (!values.includes(value)) values.push(value);
}

function fnv1a(value: string, seed: number) {
  let hash = seed >>> 0;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function derivedCourseId(name: string) {
  return `COURSE-VIEW-${fnv1a(name, 0x811c9dc5)}${fnv1a([...name].reverse().join(""), 0x9e3779b9)}`;
}

function ordinalViewKey(kind: "PACKAGE" | "PURCHASE", ordinals: readonly number[]) {
  return `${kind}-VIEW-${ordinals.map((ordinal) => ordinal + 1).join("-")}`;
}

function roundHours(value: number) {
  return Math.round(value * HOURS_PRECISION) / HOURS_PRECISION;
}

function sumHours(values: readonly number[]) {
  return roundHours(values.reduce((sum, value) => sum + value, 0));
}

function purchaseTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function sourceLabel(seed: CourseSeed) {
  if (seed.sources.length) return seed.sources.join(" / ");
  const labels: Partial<Record<CourseCatalogEvidence, string>> = {
    lesson_package: "学生课包",
    student_profile: "学生档案",
    booking: "排课记录",
  };
  return seed.evidence.map((item) => labels[item]).filter(Boolean).join(" / ") || "现有运营资料";
}

type InspectedLessonPackage = Readonly<{
  packageId: string;
  packageName: string;
  subjectIds: readonly string[];
  balance: LessonPackageBalance | null;
  purchaseRecords: readonly StudentLessonPackage["purchaseRecords"][number][];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Contains one malformed package without allowing it to poison the page. */
function inspectLessonPackage(value: unknown, fallbackId: string): InspectedLessonPackage {
  if (!record(value)) {
    return {
      packageId: fallbackId,
      packageName: "课包数据异常",
      subjectIds: [],
      balance: null,
      purchaseRecords: [],
    };
  }
  const rawSubjects = value.subjectIds;
  const subjectIds = Array.isArray(rawSubjects)
    ? [...new Set(rawSubjects
        .filter((subject): subject is string => typeof subject === "string")
        .map((subject) => subject.trim())
        .filter(Boolean))]
    : [];
  const subjectsValid = Array.isArray(rawSubjects)
    && rawSubjects.length === subjectIds.length
    && rawSubjects.every((subject) => typeof subject === "string" && subject === subject.trim() && Boolean(subject));
  const packageId = typeof value.id === "string" && value.id.trim() ? value.id.trim() : fallbackId;
  const packageName = typeof value.name === "string" && value.name.trim() ? value.name.trim() : "课包数据异常";
  if (!subjectsValid) {
    return { packageId, packageName, subjectIds, balance: null, purchaseRecords: [] };
  }
  try {
    const lessonPackage = value as StudentLessonPackage;
    const balance = getLessonPackageBalance(lessonPackage);
    // An overdrawn ledger is useful debt evidence in a student record, but it
    // is not a valid course-catalog balance and must never render as negative.
    if (balance.remainingHours < 0 || balance.consumedHours > balance.totalHours) {
      return { packageId, packageName, subjectIds, balance: null, purchaseRecords: [] };
    }
    return {
      packageId,
      packageName,
      subjectIds,
      balance,
      purchaseRecords: lessonPackage.purchaseRecords,
    };
  } catch {
    return { packageId, packageName, subjectIds, balance: null, purchaseRecords: [] };
  }
}

/**
 * Builds a read-only view over the existing course and scoped student facts.
 * It does not persist inferred courses and never treats teacher taxonomy as a
 * course catalogue. Callers must pass only students/bookings already filtered
 * by the server-owned access scope.
 */
export function buildCoursePackageCatalog(input: BuildCoursePackageCatalogInput): CoursePackageCatalogEntry[] {
  if (input.includeTeacherEligibility === true && input.teachers === undefined) {
    throw new TypeError("teachers are required when teacher eligibility is included");
  }
  for (const student of input.students) {
    const archived = (student as { importArchived?: unknown }).importArchived;
    if (archived !== undefined && archived !== false) {
      throw new TypeError("course package catalog accepts active scoped students only");
    }
  }

  const seeds = new Map<string, CourseSeed>();
  const studentById = new Map<string, CoursePackageCatalogStudent>();
  const linkedStudentIdsByCourse = new Map<string, Set<string>>();
  const packagesByCourse = new Map<string, CoursePackageCatalogPackage[]>();
  const purchasesByCourse = new Map<string, CoursePackageCatalogPurchase[]>();
  const bookingCountByCourse = new Map<string, number>();
  const eligibleTeachersByCourse = new Map<string, Array<{ id: string; name: string }>>();
  let firstSeen = 0;

  const observe = (
    rawName: string | null | undefined,
    evidence: CourseCatalogEvidence,
    catalog?: CourseCatalogRecord,
  ) => {
    const name = cleanCourseName(rawName);
    const key = courseKey(name);
    if (!key) return;
    let seed = seeds.get(key);
    if (!seed) {
      seed = {
        id: catalog?.id.trim() || derivedCourseId(name),
        name,
        status: catalog?.status ?? "在用",
        sources: [],
        catalogRecordIds: [],
        evidence: [],
        firstSeen: firstSeen++,
      };
      seeds.set(key, seed);
    }
    uniquePush(seed.evidence, evidence);
    if (catalog) {
      const catalogId = catalog.id.trim();
      const source = catalog.source.trim();
      if (catalogId) uniquePush(seed.catalogRecordIds, catalogId);
      if (source) uniquePush(seed.sources, source);
      if (seed.catalogRecordIds.length === 1 && catalogId) seed.id = catalogId;
      if (catalog.status === "在用") seed.status = "在用";
    }
  };

  const linkStudent = (key: string, studentId: string) => {
    const linked = linkedStudentIdsByCourse.get(key) ?? new Set<string>();
    linked.add(studentId);
    linkedStudentIdsByCourse.set(key, linked);
  };

  for (const student of input.students) {
    if (studentById.has(student.id)) throw new TypeError(`duplicate scoped student id: ${student.id}`);
    studentById.set(student.id, student);
  }

  // Preserve the established catalogue ordering and identity when it exists.
  input.courses.forEach((course) => observe(course.name, "catalog", course));
  // Packages are the authoritative subject-to-hours binding. They may reveal
  // a course before a legacy catalogue row has been imported. Historical JWB
  // snapshots are intentionally never traversed here.
  for (const [studentIndex, student] of input.students.entries()) {
    const rawPackages = (student as { lessonPackages?: unknown }).lessonPackages;
    if (rawPackages !== undefined && !Array.isArray(rawPackages)) continue;
    for (const [packageIndex, lessonPackage] of (rawPackages ?? []).entries()) {
      const inspected = inspectLessonPackage(
        lessonPackage,
        `INVALID-PACKAGE-${studentIndex + 1}-${packageIndex + 1}`,
      );
      const { packageId, packageName, subjectIds, balance, purchaseRecords } = inspected;
      const courseSubjects = [...new Set(subjectIds.map((value) => courseKey(value)).filter(Boolean))];
      for (const [subjectIndex, subject] of courseSubjects.entries()) {
        observe(subject, "lesson_package");
        const key = courseKey(subject);
        linkStudent(key, student.id);
        const packages = packagesByCourse.get(key) ?? [];
        packages.push({
          viewKey: ordinalViewKey("PACKAGE", [studentIndex, packageIndex, subjectIndex]),
          studentId: student.id,
          studentName: student.name,
          packageId,
          packageName,
          subjectIds,
          balance,
          sharedAcrossSubjects: subjectIds.length > 1,
        });
        packagesByCourse.set(key, packages);
        if (balance !== null) {
          const purchases = purchasesByCourse.get(key) ?? [];
          purchaseRecords.forEach((purchase, purchaseIndex) => purchases.push({
            viewKey: ordinalViewKey("PURCHASE", [studentIndex, packageIndex, subjectIndex, purchaseIndex]),
            id: purchase.id,
            studentId: student.id,
            studentName: student.name,
            packageId,
            packageName,
            purchasedAt: purchase.purchasedAt,
            hours: purchase.hours,
            ...(purchase.purchasedHours !== undefined ? { purchasedHours: purchase.purchasedHours } : {}),
            ...(purchase.bonusHours !== undefined ? { bonusHours: purchase.bonusHours } : {}),
          }));
          purchasesByCourse.set(key, purchases);
        }
      }
    }
  }
  for (const student of input.students) {
    const key = courseKey(student.course);
    if (!key) continue;
    observe(key, "student_profile");
    linkStudent(key, student.id);
  }
  for (const booking of input.bookings) {
    // Defence in depth for the host mount: a booking outside the supplied
    // active student scope must not create a course, count or navigation path.
    if (!studentById.has(booking.studentId)) continue;
    const key = courseKey(booking.course);
    if (!key) continue;
    observe(key, "booking");
    bookingCountByCourse.set(key, (bookingCountByCourse.get(key) ?? 0) + 1);
    linkStudent(key, booking.studentId);
  }
  if (input.includeTeacherEligibility === true) {
    for (const teacher of input.teachers!) {
      for (const key of new Set((teacher.subjects ?? []).map((subject) => courseKey(subject)).filter(Boolean))) {
        const teachers = eligibleTeachersByCourse.get(key) ?? [];
        teachers.push({ id: teacher.id, name: teacher.name });
        eligibleTeachersByCourse.set(key, teachers);
      }
    }
  }

  const entries: CoursePackageCatalogEntry[] = [...seeds.entries()].map(([key, seed]) => {
    const packageRows = packagesByCourse.get(key) ?? [];
    const linkedStudents = [...(linkedStudentIdsByCourse.get(key) ?? [])]
      .map((studentId) => studentById.get(studentId))
      .filter((student): student is CoursePackageCatalogStudent => student !== undefined);

    const packageStudentIds = new Set(packageRows.map((row) => row.studentId));
    const validPackageStudentIds = new Set(packageRows
      .filter((row) => row.balance !== null)
      .map((row) => row.studentId));
    const invalidPackageStudentIds = new Set(packageRows
      .filter((row) => row.balance === null)
      .map((row) => row.studentId));
    const studentsWithoutPackage = linkedStudents
      .filter((student) => !packageStudentIds.has(student.id))
      .map((student) => ({ id: student.id, name: student.name }));
    const coverage = linkedStudents.reduce<CoursePackageCoverage>((result, student) => {
      if (!packageStudentIds.has(student.id)) return { ...result, none: result.none + 1 };
      if (!validPackageStudentIds.has(student.id)
        || invalidPackageStudentIds.has(student.id)
        || student.packageCoverage === "partial"
        || student.packageCoverage === "none") {
        return { ...result, partial: result.partial + 1 };
      }
      return { ...result, complete: result.complete + 1 };
    }, { complete: 0, partial: 0, none: 0 });

    const purchases = [...(purchasesByCourse.get(key) ?? [])]
      .sort((left, right) => purchaseTimestamp(right.purchasedAt) - purchaseTimestamp(left.purchasedAt)
        || right.id.localeCompare(left.id));
    const structuredPurchases = purchases.filter((purchase) =>
      purchase.purchasedHours !== undefined && purchase.bonusHours !== undefined);
    const unclassifiedPurchases = purchases.filter((purchase) =>
      purchase.purchasedHours === undefined || purchase.bonusHours === undefined);
    const validBalances = packageRows
      .map((row) => row.balance)
      .filter((balance): balance is LessonPackageBalance => balance !== null);
    const eligibleTeachers = input.includeTeacherEligibility === true
      ? [...(eligibleTeachersByCourse.get(key) ?? [])]
      : null;

    return {
      id: seed.id,
      name: seed.name,
      status: seed.status,
      source: sourceLabel(seed),
      catalogRecordIds: [...seed.catalogRecordIds],
      evidence: [...seed.evidence],
      isCatalogued: seed.catalogRecordIds.length > 0,
      bookingCount: bookingCountByCourse.get(key) ?? 0,
      linkedStudentCount: linkedStudents.length,
      eligibleTeacherCount: eligibleTeachers?.length ?? null,
      eligibleTeachers,
      packageCount: packageRows.length,
      invalidPackageCount: packageRows.length - validBalances.length,
      packages: packageRows,
      purchases,
      purchaseRecordCount: purchases.length,
      structuredPurchaseRecordCount: structuredPurchases.length,
      totalHours: sumHours(validBalances.map((balance) => balance.totalHours)),
      purchasedHours: sumHours(structuredPurchases.map((purchase) => purchase.purchasedHours!)),
      bonusHours: sumHours(structuredPurchases.map((purchase) => purchase.bonusHours!)),
      unclassifiedHours: sumHours(unclassifiedPurchases.map((purchase) => purchase.hours)),
      consumedHours: sumHours(validBalances.map((balance) => balance.consumedHours)),
      remainingHours: sumHours(validBalances.map((balance) => balance.remainingHours)),
      coverage,
      studentsWithoutPackage,
    };
  });

  return entries
    .sort((left, right) =>
      (seeds.get(courseKey(left.name))?.firstSeen ?? Number.MAX_SAFE_INTEGER)
      - (seeds.get(courseKey(right.name))?.firstSeen ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name));
}

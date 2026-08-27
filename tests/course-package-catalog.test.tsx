import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoursePackageSummary } from "../app/course-package-summary.tsx";
import {
  buildCoursePackageCatalog,
  isActiveCoursePackageCatalogStudent,
  type BuildCoursePackageCatalogInput,
} from "../lib/course-package-catalog.ts";
import { importLessonPackagesForStudent } from "../lib/student-import.ts";

const input: BuildCoursePackageCatalogInput = {
  courses: [{ id: "COURSE-MATH", name: "Mathematics", status: "在用", source: "教务宝课程目录" }],
  students: [
    {
      id: "STUDENT-1",
      name: "Student One",
      course: "Mathematics",
      packageCoverage: "complete",
      lessonPackages: [{
        id: "PACKAGE-SHARED",
        name: "Math and Physics package",
        subjectIds: ["Mathematics", "Physics"],
        purchaseRecords: [
          {
            id: "PURCHASE-STRUCTURED",
            purchasedAt: "2026-08-02T00:00:00.000Z",
            hours: 10,
            purchasedHours: 8,
            bonusHours: 2,
          },
          {
            id: "PURCHASE-LEGACY",
            purchasedAt: "2026-07-01T00:00:00.000Z",
            hours: 5,
            note: "教务宝历史合同",
          },
        ],
        consumedHours: 3,
      }],
    },
    {
      id: "STUDENT-2",
      name: "Student Two",
      course: "Mathematics",
      packageCoverage: "none",
    },
    {
      id: "STUDENT-3",
      name: "Student Three",
      course: "English",
      lessonPackages: [{
        id: "PACKAGE-ENGLISH",
        name: "English package",
        subjectIds: ["English"],
        purchaseRecords: [{ id: "PURCHASE-ENGLISH", purchasedAt: "2026-08-03", hours: 4 }],
        consumedHours: 1,
      }],
    },
  ],
  bookings: [
    { id: "BOOKING-1", studentId: "STUDENT-1", course: "Mathematics" },
    { id: "BOOKING-2", studentId: "STUDENT-2", course: "Mathematics" },
    { id: "BOOKING-3", studentId: "STUDENT-3", course: "Writing" },
  ],
  teachers: [
    { id: "TEACHER-1", name: "Exact Teacher", subjects: ["Mathematics"] },
    { id: "TEACHER-2", name: "Case Mismatch", subjects: ["mathematics"] },
    { id: "TEACHER-3", name: "Teacher-only Taxonomy", subjects: ["Biology"] },
  ],
  includeTeacherEligibility: true,
};

test("derives a view from the established catalogue and scoped operational facts without creating teacher-only courses", () => {
  const catalog = buildCoursePackageCatalog(input);

  assert.deepEqual(catalog.map((course) => course.name), ["Mathematics", "Physics", "English", "Writing"]);
  assert.equal(catalog.some((course) => course.name === "Biology"), false);
  assert.equal(catalog[0].id, "COURSE-MATH");
  assert.equal(catalog[0].source, "教务宝课程目录");
  assert.deepEqual(catalog[0].evidence, ["catalog", "lesson_package", "student_profile", "booking"]);
  assert.equal(catalog.find((course) => course.name === "Physics")?.isCatalogued, false);
});

test("aggregates package balances and preserves purchased, bonus and unclassified hour truth", () => {
  const course = buildCoursePackageCatalog(input).find((entry) => entry.name === "Mathematics")!;

  assert.equal(course.packageCount, 1);
  assert.equal(course.linkedStudentCount, 2);
  assert.equal(course.bookingCount, 2);
  assert.equal(course.totalHours, 15);
  assert.equal(course.purchasedHours, 8);
  assert.equal(course.bonusHours, 2);
  assert.equal(course.unclassifiedHours, 5);
  assert.equal(course.consumedHours, 3);
  assert.equal(course.remainingHours, 12);
  assert.equal(course.purchaseRecordCount, 2);
  assert.equal(course.structuredPurchaseRecordCount, 1);
  assert.deepEqual(course.coverage, { complete: 1, partial: 0, none: 1 });
  assert.deepEqual(course.studentsWithoutPackage, [{ id: "STUDENT-2", name: "Student Two" }]);
  assert.deepEqual(course.eligibleTeachers, [{ id: "TEACHER-1", name: "Exact Teacher" }]);
});

test("does not allocate an unrelated package to a student's primary course", () => {
  const catalog = buildCoursePackageCatalog({
    courses: [],
    students: [{
      id: "STUDENT-1",
      name: "Student One",
      course: "Mathematics",
      lessonPackages: [{
        id: "PACKAGE-1",
        name: "English only",
        subjectIds: ["English"],
        purchaseRecords: [{ id: "PURCHASE-1", purchasedAt: "2026-08-01", hours: 10 }],
        consumedHours: 2,
      }],
    }],
    bookings: [],
  });

  const mathematics = catalog.find((course) => course.name === "Mathematics")!;
  assert.equal(mathematics.packageCount, 0);
  assert.equal(mathematics.totalHours, 0);
  assert.deepEqual(mathematics.studentsWithoutPackage, [{ id: "STUDENT-1", name: "Student One" }]);
  assert.equal(catalog.find((course) => course.name === "English")?.packageCount, 1);
});

test("keeps exact taxonomy labels distinct apart from transport whitespace", () => {
  const catalog = buildCoursePackageCatalog({
    courses: [{ id: "UPPER", name: "Mathematics", status: "在用", source: "目录" }],
    students: [{ id: "S", name: "S", course: " Mathematics " }],
    bookings: [{ id: "B", studentId: "S", course: "mathematics" }],
  });

  assert.deepEqual(catalog.map((course) => course.name), ["Mathematics", "mathematics"]);
  assert.equal(catalog[0].linkedStudentCount, 1);
  assert.equal(catalog[1].bookingCount, 1);
});

test("renders truthful structured balances, purchase history and the existing package navigation hook", () => {
  const course = buildCoursePackageCatalog(input).find((entry) => entry.name === "Mathematics")!;
  const html = renderToStaticMarkup(<CoursePackageSummary
    course={course}
    onOpenStudentPackage={() => undefined}
  />);

  assert.match(html, /aria-label="课包汇总"/);
  assert.match(html, /排课/);
  assert.match(html, /购买 8 · 赠送 2/);
  assert.match(html, /未拆分 5 课时/);
  assert.doesNotMatch(html, /收费金额|推算价格|待结构化导入/);
  assert.match(html, /Student One · Math and Physics package/);
  assert.match(html, /多科目共享课包/);
  assert.match(html, /查看学生课包/);
  assert.match(html, /Student Two/);
  assert.match(html, /购买 8 \+ 赠送 2/);
  assert.doesNotMatch(html, /教务宝历史合同/);
});

test("hides teacher eligibility unless the host explicitly opts into its authorized projection", () => {
  const course = buildCoursePackageCatalog({
    courses: input.courses,
    students: input.students,
    bookings: input.bookings,
    teachers: input.teachers,
  }).find((entry) => entry.name === "Mathematics")!;
  const html = renderToStaticMarkup(<CoursePackageSummary course={course} />);

  assert.equal(course.eligibleTeacherCount, null);
  assert.equal(course.eligibleTeachers, null);
  assert.doesNotMatch(html, /精确科目匹配老师|腾讯表科目完全一致/);
  assert.throws(() => buildCoursePackageCatalog({
    courses: input.courses,
    students: input.students,
    bookings: input.bookings,
    includeTeacherEligibility: true,
  }), /teachers are required/);
});

test("rejects archived students and never promotes historical JWB packages into the active catalogue", () => {
  assert.deepEqual([
    { id: "ACTIVE", importArchived: false as const },
    { id: "ARCHIVED", importArchived: true as const },
  ].filter(isActiveCoursePackageCatalogStudent).map((student) => student.id), ["ACTIVE"]);
  assert.throws(() => buildCoursePackageCatalog({
    courses: [],
    students: [{
      id: "ARCHIVED",
      name: "Archived",
      importArchived: true,
    }] as unknown as BuildCoursePackageCatalogInput["students"],
    bookings: [],
  }), /active scoped students only/);

  const activePackages = importLessonPackagesForStudent("ACTIVE-JWB", [{
    sourcePackageId: "CURRENT-COURSE",
    name: "Verified active JWB package",
    subjectIds: ["Current Course"],
    purchaseRecords: [{
      sourcePurchaseId: "CURRENT-PURCHASE",
      purchasedAt: "2026-08-01",
      hours: 6,
    }],
    consumedHours: 2,
  }], "JWB-ROW");
  const historicalOnlyPackage = {
    id: "opaque-historical-package",
    name: "Historical only",
    subjectIds: ["Historical Course"],
    purchaseRecords: [{ id: "opaque-historical-purchase", purchasedAt: "2025-01-01", hours: 10 }],
    consumedHours: 4,
  };
  const catalog = buildCoursePackageCatalog({
    courses: [],
    students: [
      {
        id: "ACTIVE-JWB",
        name: "Active JWB",
        lessonPackages: activePackages,
        historicalJwbSnapshot: { retained: { lessonPackages: [historicalOnlyPackage] } },
      },
      {
        id: "HISTORY-ONLY",
        name: "History only",
        historicalJwbSnapshot: { retained: { lessonPackages: [historicalOnlyPackage] } },
      },
    ],
    bookings: [],
  });

  assert.deepEqual(catalog.map((course) => course.name), ["Current Course"]);
  assert.equal(catalog[0].packageCount, 1);
  assert.equal(catalog[0].totalHours, 6);
});

test("hard-caps package rows at 20 and purchase rows at 8", () => {
  const students = Array.from({ length: 25 }, (_, index) => ({
    id: `STUDENT-${index}`,
    name: `Student ${index}`,
    lessonPackages: [{
      id: `PACKAGE-${index}`,
      name: `Package ${index}`,
      subjectIds: ["Scale Course"],
      purchaseRecords: [{
        id: `PURCHASE-${index}`,
        purchasedAt: `2026-08-${String((index % 25) + 1).padStart(2, "0")}`,
        hours: 1,
        note: `PRIVATE-NOTE-${index}`,
      }],
      consumedHours: 0,
    }],
  }));
  const course = buildCoursePackageCatalog({ courses: [], students, bookings: [] })[0];
  const html = renderToStaticMarkup(<CoursePackageSummary
    course={course}
    packagePreviewLimit={999}
    purchasePreviewLimit={999}
  />);

  assert.equal((html.match(/data-course-package-row="true"/g) ?? []).length, 20);
  assert.equal((html.match(/data-course-purchase-row="true"/g) ?? []).length, 8);
  assert.match(html, /另有 5 个课包/);
  assert.match(html, /另有 17 条记录/);
  assert.doesNotMatch(html, /PRIVATE-NOTE-/);
  assert.doesNotMatch(html, /收费金额|推算价格|待结构化导入/);
});

test("contains malformed packages instead of crashing or reporting false balances", () => {
  const catalog = buildCoursePackageCatalog({
    courses: [],
    students: [{
      id: "STUDENT-INVALID",
      name: "Invalid package student",
      packageCoverage: "complete",
      lessonPackages: [{
        id: "PACKAGE-INVALID",
        name: "Invalid package",
        subjectIds: ["Physics"],
        purchaseRecords: [{ id: "PURCHASE-INVALID", purchasedAt: "2026-08-01", hours: 2 }],
        consumedHours: 3,
      }],
    }],
    bookings: [],
  });
  const physics = catalog[0];

  assert.equal(physics.invalidPackageCount, 1);
  assert.equal(physics.totalHours, 0);
  assert.equal(physics.consumedHours, 0);
  assert.equal(physics.remainingHours, 0);
  assert.equal(physics.purchaseRecordCount, 0);
  assert.deepEqual(physics.coverage, { complete: 0, partial: 1, none: 0 });
  const html = renderToStaticMarkup(<CoursePackageSummary course={physics} />);
  assert.match(html, /课包数据异常，未计入汇总/);
  assert.doesNotMatch(html, /剩余 -/);
});

test("contains corrupt subject arrays per package and still projects valid sibling packages", () => {
  const students = [{
    id: "STUDENT-CORRUPT",
    name: "Corrupt package student",
    course: "Primary Course",
    packageCoverage: "complete",
    lessonPackages: [
      null,
      {
        id: "NULL-SUBJECTS",
        name: "Null subjects",
        subjectIds: null,
        purchaseRecords: [{ id: "NULL-PURCHASE", purchasedAt: "2026-08-01", hours: 3 }],
        consumedHours: 0,
      },
      {
        id: "MIXED-SUBJECTS",
        name: "Mixed subjects",
        subjectIds: ["Mathematics", null],
        purchaseRecords: [{ id: "MIXED-PURCHASE", purchasedAt: "2026-08-01", hours: 4 }],
        consumedHours: 0,
      },
      {
        id: "VALID-SIBLING",
        name: "Valid sibling",
        subjectIds: ["Physics"],
        purchaseRecords: [{ id: "VALID-PURCHASE", purchasedAt: "2026-08-01", hours: 5 }],
        consumedHours: 1,
      },
    ],
  }] as unknown as BuildCoursePackageCatalogInput["students"];

  const catalog = buildCoursePackageCatalog({ courses: [], students, bookings: [] });
  const mathematics = catalog.find((course) => course.name === "Mathematics")!;
  const physics = catalog.find((course) => course.name === "Physics")!;
  const primary = catalog.find((course) => course.name === "Primary Course")!;

  assert.deepEqual(catalog.map((course) => course.name), ["Mathematics", "Physics", "Primary Course"]);
  assert.equal(mathematics.packageCount, 1);
  assert.equal(mathematics.invalidPackageCount, 1);
  assert.equal(mathematics.totalHours, 0);
  assert.deepEqual(mathematics.coverage, { complete: 0, partial: 1, none: 0 });
  assert.equal(physics.packageCount, 1);
  assert.equal(physics.invalidPackageCount, 0);
  assert.equal(physics.totalHours, 5);
  assert.equal(physics.remainingHours, 4);
  assert.deepEqual(physics.coverage, { complete: 1, partial: 0, none: 0 });
  assert.equal(primary.packageCount, 0);
});

test("uses ordinal view keys so duplicate and colon-containing record ids remain distinct", () => {
  const duplicateIdInput: BuildCoursePackageCatalogInput = {
    courses: [],
    students: [{
      id: "STUDENT:COLON",
      name: "Duplicate ID student",
      packageCoverage: "complete",
      lessonPackages: [1, 2].map((packageOrdinal) => ({
        id: "PACKAGE:DUPLICATE",
        name: `Package ${packageOrdinal}`,
        subjectIds: ["Course:Colon"],
        purchaseRecords: [1, 2].map((purchaseOrdinal) => ({
          id: "PURCHASE:DUPLICATE",
          purchasedAt: `2026-08-0${packageOrdinal + purchaseOrdinal}`,
          hours: packageOrdinal + purchaseOrdinal,
        })),
        consumedHours: 0,
      })),
    }],
    bookings: [],
  };

  const first = buildCoursePackageCatalog(duplicateIdInput)[0];
  const second = buildCoursePackageCatalog(duplicateIdInput)[0];
  const packageKeys = first.packages.map((row) => row.viewKey);
  const purchaseKeys = first.purchases.map((row) => row.viewKey);

  assert.equal(first.name, "Course:Colon");
  assert.equal(first.packageCount, 2);
  assert.equal(first.purchaseRecordCount, 4);
  assert.equal(first.totalHours, 12);
  assert.equal(new Set(packageKeys).size, 2);
  assert.equal(new Set(purchaseKeys).size, 4);
  assert.ok(packageKeys.every((key) => /^PACKAGE-VIEW-\d+-\d+-\d+$/.test(key)));
  assert.ok(purchaseKeys.every((key) => /^PURCHASE-VIEW-\d+-\d+-\d+-\d+$/.test(key)));
  assert.ok([...packageKeys, ...purchaseKeys].every((key) => !key.includes(":")));
  assert.deepEqual(packageKeys, second.packages.map((row) => row.viewKey));
  assert.deepEqual(purchaseKeys, second.purchases.map((row) => row.viewKey));

  const html = renderToStaticMarkup(<CoursePackageSummary course={first} />);
  assert.equal((html.match(/data-course-package-row="true"/g) ?? []).length, 2);
  assert.equal((html.match(/data-course-purchase-row="true"/g) ?? []).length, 4);
});

test("ignores bookings whose student is outside the supplied active scope", () => {
  const catalog = buildCoursePackageCatalog({
    courses: [],
    students: [{ id: "ACTIVE", name: "Active" }],
    bookings: [
      { id: "ACTIVE-BOOKING", studentId: "ACTIVE", course: "Visible Course" },
      { id: "OUT-OF-SCOPE", studentId: "ARCHIVED", course: "Hidden Course" },
    ],
  });

  assert.deepEqual(catalog.map((course) => course.name), ["Visible Course"]);
  assert.equal(catalog[0].bookingCount, 1);
  assert.equal(catalog[0].linkedStudentCount, 1);
});

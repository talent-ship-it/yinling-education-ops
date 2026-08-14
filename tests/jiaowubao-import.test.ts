import assert from "node:assert/strict";
import test from "node:test";

import {
  JiaowubaoImportError,
  adaptJiaowubaoImportRows,
  type RawJiaowubaoContract,
  type RawJiaowubaoCourseBalance,
  type RawJiaowubaoStudent,
} from "../lib/jiaowubao-import.ts";

const student = (
  memId = "MEM-1",
  name = "Example Learner",
  total = 20,
  used = 6,
  remaining = 14,
): RawJiaowubaoStudent => ({
  mem_id: memId,
  mem_name: name,
  ks_total: total,
  ks_used: used,
  ks_rest: remaining,
});

const balance = (
  overrides: Partial<RawJiaowubaoCourseBalance> = {},
): RawJiaowubaoCourseBalance => ({
  mem_id: "MEM-1",
  ks_total: 20,
  ks_used: 6,
  ks_rest: 14,
  courses: [{
    course_id: "COURSE-ENGLISH",
    title: "English",
    ks: 20,
    ks_use: 6,
    ks_left: 14,
  }],
  ...overrides,
});

const contract = (overrides: Partial<RawJiaowubaoContract> = {}): RawJiaowubaoContract => ({
  contract_id: "CONTRACT-1",
  contract_code: "CODE-1",
  mem_id: "MEM-1",
  course_id: "COURSE-ENGLISH",
  course_title: "English",
  nature: 1,
  nature_title: "新签",
  ks: 20,
  ks_use: 1,
  ks_left: 19,
  contract_dated: "2026-07-01",
  dated: "2026-07-02 09:10:11",
  start: "0000-00-00",
  end: null,
  detail_lists: [{
    detail_id: "DETAIL-1",
    course_id: "COURSE-ENGLISH",
    course_title: "English",
    ks: 20,
    // Real JWB contract-detail remaining can differ from its header and is
    // historical only; neither value determines the current package balance.
    ks_left: 3,
    end: null,
  }],
  ...overrides,
});

const input = (overrides: Record<string, unknown> = {}) => ({
  students: [student()],
  contracts: [contract()],
  courseBalances: [balance()],
  ...overrides,
});

const errorCode = (code: JiaowubaoImportError["code"]) =>
  (error: unknown) => error instanceof JiaowubaoImportError && error.code === code;

test("uses current course balances and positive contracts for separate authoritative purposes", () => {
  const [row] = adaptJiaowubaoImportRows(input());
  assert.equal(row.remainingHours, 14);
  assert.equal(row.contractHours, 20);
  assert.equal(row.contractEffectiveDate, undefined);
  assert.equal(row.packageCoverage, "complete");
  assert.deepEqual(row.lessonPackages, [{
    sourcePackageId: "COURSE-ENGLISH",
    name: "English",
    subjectIds: ["English"],
    purchaseRecords: [{
      sourcePurchaseId: "CONTRACT-1",
      purchasedAt: "2026-07-01",
      hours: 20,
      note: "新签",
    }],
    consumedHours: 6,
  }]);
  assert.deepEqual(row.attributes, {
    jiaowubaoPackageImport: {
      status: "packages_from_current_course_balances",
      currentTotalHours: 20,
      currentUsedHours: 6,
      currentRemainingHours: 14,
      adjustmentContracts: [],
    },
  });
});

test("does not use historical contract usage to calculate current consumption", () => {
  const [row] = adaptJiaowubaoImportRows(input({
    contracts: [contract({ ks_use: 19, ks_left: 1 })],
  }));
  assert.equal(row.lessonPackages?.[0].consumedHours, 6);
});

test("sums large purchase histories as safe integer micro-hours", () => {
  const purchaseHours = 90_000.000001;
  const contractHours = 90_000_000.001;
  const remainingHours = 1;
  const usedHours = 89_999_999.001;
  const contracts = Array.from({ length: 1_000 }, (_, index) => contract({
    contract_id: `CONTRACT-${index}`,
    contract_code: `CODE-${index}`,
    ks: purchaseHours,
    ks_use: 0,
    ks_left: purchaseHours,
    detail_lists: [{
      detail_id: `DETAIL-${index}`,
      course_id: "COURSE-ENGLISH",
      course_title: "English",
      ks: purchaseHours,
      ks_left: purchaseHours,
    }],
  }));
  const [row] = adaptJiaowubaoImportRows({
    students: [student("MEM-1", "Example Learner", contractHours, usedHours, remainingHours)],
    contracts,
    courseBalances: [balance({
      ks_total: contractHours,
      ks_used: usedHours,
      ks_rest: remainingHours,
      courses: [{
        course_id: "COURSE-ENGLISH",
        title: "English",
        ks: contractHours,
        ks_use: usedHours,
        ks_left: remainingHours,
      }],
    })],
  });

  assert.equal(row.contractHours, contractHours);
  assert.equal(row.remainingHours, remainingHours);
  assert.equal(row.lessonPackages?.[0].consumedHours, usedHours);
});

test("negative balances require review and aggregate-only never creates packages", () => {
  const negativeInput = input({
    students: [student("MEM-1", "Example Learner", 20, 24, -4)],
    courseBalances: [balance({
      ks_total: 20,
      ks_used: 24,
      ks_rest: -4,
      courses: [{
        course_id: "COURSE-ENGLISH",
        title: "English",
        ks: 20,
        ks_use: 24,
        ks_left: -4,
      }],
    })],
  });
  assert.throws(() => adaptJiaowubaoImportRows(negativeInput), errorCode("negative_balance_requires_review"));
  const [row] = adaptJiaowubaoImportRows({
    ...negativeInput,
    negativeAdjustmentPolicy: "aggregate-only",
  });
  assert.equal(row.remainingHours, -4);
  assert.equal(row.contractHours, 20);
  assert.equal(row.lessonPackages, undefined);
  assert.equal(row.packageCoverage, "none");
  assert.equal((row.attributes?.jiaowubaoPackageImport as { status: string }).status,
    "aggregate_only_negative_balance");
  assert.deepEqual(
    (row.attributes?.jiaowubaoPackageImport as { unresolvedCourseBalances: unknown[] }).unresolvedCourseBalances,
    [{ courseId: "COURSE-ENGLISH", title: "English", totalHours: 20, usedHours: 24, remainingHours: -4 }],
  );
});

test("requires exactly one matching course-balance snapshot per student", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({ courseBalances: [] })), errorCode("missing_course_balance"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    courseBalances: [balance(), balance()],
  })), errorCode("duplicate_course_balance"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    courseBalances: [balance({ ks_used: 7, ks_rest: 13 })],
  })), errorCode("balance_mismatch"));
});

test("requires each current course to balance and all courses to sum to the aggregate", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({
    courseBalances: [balance({ courses: [{
      course_id: "COURSE-ENGLISH", title: "English", ks: 20, ks_use: 6, ks_left: 13,
    }] })],
  })), errorCode("balance_mismatch"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    courseBalances: [balance({ courses: [{
      course_id: "COURSE-ENGLISH", title: "English", ks: 10, ks_use: 3, ks_left: 7,
    }] })],
  })), errorCode("balance_mismatch"));
});

test("rejects raw JWB values finer than one micro-hour instead of rounding them", () => {
  assert.throws(() => adaptJiaowubaoImportRows({
    students: [student("MEM-PRECISION", "Precision Learner", 0.0000004, 0, 0.0000004)],
    contracts: [],
    courseBalances: [balance({
      mem_id: "MEM-PRECISION",
      ks_total: 0.0000004,
      ks_used: 0,
      ks_rest: 0.0000004,
      courses: [],
    })],
  }), errorCode("invalid_student"));

  assert.throws(() => adaptJiaowubaoImportRows(input({
    contracts: [contract({
      nature: 5,
      nature_title: "退费",
      ks: -0.0000004,
      ks_use: 0,
      ks_left: -0.0000004,
    })],
  })), errorCode("invalid_contract"));
});

test("historical purchases may exceed current total while current remaining stays exact", () => {
  const [row] = adaptJiaowubaoImportRows(input({
    students: [student("MEM-1", "Example Learner", 12, 2, 10)],
    courseBalances: [balance({
      ks_total: 12,
      ks_used: 2,
      ks_rest: 10,
      courses: [{ course_id: "COURSE-ENGLISH", title: "English", ks: 12, ks_use: 2, ks_left: 10 }],
    })],
  }));
  assert.equal(row.contractHours, 20);
  assert.equal(row.lessonPackages?.[0].consumedHours, 10);
  assert.equal(row.remainingHours, 10);
  assert.deepEqual(row.attributes?.jiaowubaoPackageImport, {
    status: "packages_from_current_course_balances",
    currentTotalHours: 12,
    currentUsedHours: 2,
    currentRemainingHours: 10,
    adjustmentContracts: [],
  });
});

test("fails closed when positive history is smaller than current course total", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({
    students: [student("MEM-1", "Example Learner", 25, 5, 20)],
    courseBalances: [balance({
      ks_total: 25,
      ks_used: 5,
      ks_rest: 20,
      courses: [{ course_id: "COURSE-ENGLISH", title: "English", ks: 25, ks_use: 5, ks_left: 20 }],
    })],
  })), errorCode("purchase_history_shortfall"));
});

test("missing purchase history needs explicit aggregate-only review", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({ contracts: [] })), errorCode("package_history_requires_review"));
  const [row] = adaptJiaowubaoImportRows(input({
    contracts: [],
    negativeAdjustmentPolicy: "aggregate-only",
  }));
  assert.equal(row.lessonPackages, undefined);
  assert.equal(row.packageCoverage, "none");
  assert.equal(row.contractHours, 20);
  assert.equal((row.attributes?.jiaowubaoPackageImport as { status: string }).status,
    "aggregate_only_missing_purchase_history");
});

test("keeps verified packages when other current courses have no purchase history", () => {
  const [row] = adaptJiaowubaoImportRows(input({
    students: [student("MEM-1", "Example Learner", 25, 8, 17)],
    courseBalances: [balance({
      ks_total: 25,
      ks_used: 8,
      ks_rest: 17,
      courses: [
        { course_id: "COURSE-ENGLISH", title: "English", ks: 20, ks_use: 6, ks_left: 14 },
        { course_id: "COURSE-MATH", title: "Math", ks: 5, ks_use: 2, ks_left: 3 },
      ],
    })],
    negativeAdjustmentPolicy: "aggregate-only",
  }));
  assert.equal(row.packageCoverage, "partial");
  assert.deepEqual(row.lessonPackages?.map((item) => item.sourcePackageId), ["COURSE-ENGLISH"]);
  assert.equal(row.remainingHours, 17);
  assert.equal(row.contractHours, 25);
  assert.deepEqual(
    (row.attributes?.jiaowubaoPackageImport as { unresolvedCourseBalances: unknown[] }).unresolvedCourseBalances,
    [{ courseId: "COURSE-MATH", title: "Math", totalHours: 5, usedHours: 2, remainingHours: 3 }],
  );
});

test("zero-balance students with no courses or contracts remain aggregate-only", () => {
  const [row] = adaptJiaowubaoImportRows({
    students: [student("MEM-ZERO", "Zero Learner", 0, 0, 0)],
    contracts: [],
    courseBalances: [balance({
      mem_id: "MEM-ZERO", ks_total: 0, ks_used: 0, ks_rest: 0, courses: [],
    })],
  });
  assert.equal(row.lessonPackages, undefined);
  assert.equal(row.remainingHours, 0);
  assert.equal(row.packageCoverage, "none");
  assert.equal(
    (row.attributes?.jiaowubaoPackageImport as { status: string }).status,
    "aggregate_only_no_current_courses",
  );
});

test("refunds and transfer-outs preserve signed audit data and force aggregate-only", () => {
  const refund = contract({
    contract_id: "REFUND-1",
    nature: 5,
    nature_title: "退费",
    ks: -2,
    ks_use: 0,
    ks_left: -2,
    detail_lists: [{
      detail_id: "REFUND-DETAIL-1",
      course_id: "COURSE-ENGLISH",
      course_title: "English",
      ks: -2,
      ks_left: -2,
    }],
  });
  assert.throws(() => adaptJiaowubaoImportRows(input({ contracts: [contract(), refund] })),
    errorCode("negative_adjustment_requires_review"));
  const [row] = adaptJiaowubaoImportRows(input({
    contracts: [contract(), refund],
    negativeAdjustmentPolicy: "aggregate-only",
  }));
  assert.equal(row.lessonPackages, undefined);
  assert.equal(row.packageCoverage, "none");
  assert.equal((row.attributes?.jiaowubaoPackageImport as { status: string }).status,
    "aggregate_only_negative_adjustment");
  assert.equal(
    (row.attributes?.jiaowubaoPackageImport as { adjustmentContracts: { hoursDelta: number }[] })
      .adjustmentContracts[0].hoursDelta,
    -2,
  );
  assert.deepEqual(
    (row.attributes?.jiaowubaoPackageImport as { unresolvedCourseBalances: unknown[] }).unresolvedCourseBalances,
    [{ courseId: "COURSE-ENGLISH", title: "English", totalHours: 20, usedHours: 6, remainingHours: 14 }],
  );
});

test("rejects a positive-valued negative contract instead of double-signing it", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({
    contracts: [contract({ nature_title: "转出", ks: 2, ks_use: 0, ks_left: 2 })],
  })), errorCode("balance_mismatch"));
});

test("unknown natures, duplicate identities, and missing addition dates fail closed", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({
    contracts: [contract({ nature_title: "其他" })],
  })), errorCode("unknown_contract_nature"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    students: [student(), { ...student(), ks_used: 7, ks_rest: 13 }],
  })), errorCode("duplicate_student"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    contracts: [contract(), { ...contract(), contract_code: "changed" }],
  })), errorCode("duplicate_contract"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    contracts: [contract({ contract_dated: "", dated: null, start: "0000-00-00" })],
  })), errorCode("missing_purchase_date"));
});

test("course catalogue and contract detail identity remain strict", () => {
  assert.throws(() => adaptJiaowubaoImportRows(input({
    courses: [{ course_id: "COURSE-ENGLISH", title: "Math" }],
  })), errorCode("invalid_course"));
  assert.throws(() => adaptJiaowubaoImportRows(input({
    contracts: [contract({ detail_lists: [{
      detail_id: "DETAIL-X", course_id: "OTHER", course_title: "English", ks: 20, ks_left: 14,
    }] })],
  })), errorCode("course_detail_mismatch"));
});

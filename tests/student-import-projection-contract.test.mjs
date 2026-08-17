import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildStudentImportPlan, normalizeStudentImportName } from "../lib/student-import.ts";
import { parseStudentImportSourceSnapshot } from "../lib/student-import-service.ts";

const migrationUrl = new URL(
  "../supabase/migrations/20260813013935_operational_atomic_contracts.sql",
  import.meta.url,
);
const sql = await readFile(migrationUrl, "utf8");

// This is the exact output of buildStudentImportPlan for the migration's
// complex SQL fixture. Keeping the complete value here catches an SQL helper
// that merely contains the expected branches but composes them differently.
const GOLDEN_PROJECTION = [
  {
    initials: "X", owner: "master-owner", planner: "master-planner", course: "old-course",
    timezone: "Pacific/Auckland", teacher: "old-teacher", next: "old-next", nextTone: "green",
    files: 7, segment: "VIP", followUp: "old-follow", location: "NSW", grade: "old-grade",
    custom: "existing",
    jiaowubaoPackageImport: {
      status: "packages_from_current_course_balances",
      currentTotalHours: 10,
      currentUsedHours: 4,
      currentRemainingHours: 6,
      adjustmentContracts: [],
    },
    year: "Year 8", id: "STU-M-05TOX2H0IZZ4GT",
    name: "Alice 😀", status: "活跃 + 有课时", sourceRow: "10",
    masterSourceKey: "MSK-N-0QNHCRF1EUF40P", importSource: "master", jwbMatchStatus: "matched",
    jwbSourceRow: "J-A", packageCoverage: "complete", remainingHours: 6, contractHours: 10,
    contractEffectiveDate: "2026-02-01",
    lessonPackages: [
      {
        id: "PKG-MANUAL-Z", name: "Manual", subjectIds: ["MAN"],
        purchaseRecords: [{ id: "BUY-MANUAL-Z", purchasedAt: "2025-01-01T00:00:00.000Z", hours: 2 }],
        consumedHours: 0,
      },
      {
        id: "PKG-JWB-0N2052J1KRWI9R", name: "英语", subjectIds: ["ENG", "MATH"],
        purchaseRecords: [{
          id: "BUY-JWB-1R07RJW1S1PPEY", purchasedAt: "2026-01-02T00:00:00.000Z", hours: 10, note: "first",
        }],
        consumedHours: 4,
      },
    ],
  },
  {
    initials: "X", owner: "old-owner", planner: "old-planner", course: "old-course",
    timezone: "Pacific/Auckland", teacher: "old-teacher", next: "old-next", nextTone: "green",
    files: 7, segment: "VIP", followUp: "old-follow", location: "Perth", id: "STU-M-19XT7ZV1HRLNSV",
    name: "Carol", status: "活跃 + 有课时", sourceRow: "20", masterSourceKey: "MSK-N-049X92G1N8CFQQ",
    importSource: "master", jwbMatchStatus: "matched", jwbSourceRow: "J-C", packageCoverage: "partial",
    remainingHours: 5, contractHours: 8,
    jiaowubaoPackageImport: {
      status: "partial_packages_unresolved_course_balances",
      currentTotalHours: 8,
      currentUsedHours: 3,
      currentRemainingHours: 5,
      unresolvedCourseBalances: [{
        courseId: "C-unresolved", title: "Unresolved", totalHours: 2, usedHours: 1, remainingHours: 1,
      }],
      adjustmentContracts: [],
    },
    lessonPackages: [
      {
        id: "PKG-MANUAL-A", name: "Manual A", subjectIds: ["MAN-A"],
        purchaseRecords: [{ id: "BUY-MANUAL-A", purchasedAt: "2025-02-01T00:00:00.000Z", hours: 3 }],
        consumedHours: 1,
      },
      {
        id: "PKG-JWB-1XYDS9Q08QBEVA", name: "Science", subjectIds: ["SCI"],
        purchaseRecords: [{ id: "BUY-JWB-174K8UK01Z2R4U", purchasedAt: "2026-02-02T00:00:00.000Z", hours: 6 }],
        consumedHours: 2,
      },
    ],
  },
  {
    initials: "BO", owner: "待分配", planner: "待分配", course: "待确认",
    timezone: "Australia/Melbourne", teacher: "待匹配", next: "核对课程、课包与老师", nextTone: "amber",
    files: 0, segment: "已报名", followUp: "未记录", location: "Melbourne", id: "STU-M-0K9QYP01BIQ2QY",
    name: "Bob", status: "在读", sourceRow: "30", masterSourceKey: "MSK-N-1W3RRZ90TCGWIV",
    importSource: "master", jwbMatchStatus: "ambiguous",
  },
  {
    initials: "DA", owner: "待分配", planner: "待分配", course: "待确认",
    timezone: "Australia/Brisbane", teacher: "待匹配", next: "核对课程、课包与老师", nextTone: "amber",
    files: 0, segment: "已报名", followUp: "未记录", location: "Brisbane", id: "STU-M-0HUB6NB0OW7P1N",
    name: "Dave", status: "活跃 + 无课时", sourceRow: "50", masterSourceKey: "MSK-N-1QE0DTR0UMDLLP",
    importSource: "master", jwbMatchStatus: "matched", jwbSourceRow: "J-D", packageCoverage: "none",
    remainingHours: -2, contractHours: 0,
    jiaowubaoPackageImport: {
      status: "aggregate_only_negative_balance",
      currentTotalHours: 0,
      currentUsedHours: 2,
      currentRemainingHours: -2,
      adjustmentContracts: [],
    },
  },
  {
    initials: "X", owner: "old-owner", planner: "old-planner", course: "old-course",
    timezone: "Pacific/Auckland", teacher: "old-teacher", next: "old-next", nextTone: "green",
    files: 7, segment: "试听", followUp: "old-follow", id: "TRIAL-Z", name: "  Trial　Kid ",
    status: "在读 + 加课待排", importSource: "manual_trial",
  },
  {
    initials: "X", owner: "old-owner", planner: "old-planner", course: "old-course",
    timezone: "Pacific/Auckland", teacher: "old-teacher", next: "历史引用归档，只读", nextTone: "neutral",
    files: 7, segment: "VIP", followUp: "old-follow", id: "LEGACY-FU", name: "Legacy FU",
    status: "不活跃 + 无课时", importArchived: true, importArchivedReason: "referenced_history",
  },
  {
    initials: "X", owner: "old-owner", planner: "old-planner", course: "old-course",
    timezone: "Pacific/Auckland", teacher: "old-teacher", next: "历史引用归档，只读", nextTone: "neutral",
    files: 7, segment: "VIP", followUp: "old-follow", id: "LEGACY-OVERRIDE", name: " Legacy Override ",
    status: "不活跃 + 无课时", importArchived: true, importArchivedReason: "referenced_history",
  },
];

const GOLDEN_PROJECTION_JSON = JSON.stringify(GOLDEN_PROJECTION);

const EXISTING_DEFAULTS = {
  initials: "X",
  owner: "old-owner",
  planner: "old-planner",
  course: "old-course",
  timezone: "Pacific/Auckland",
  teacher: "old-teacher",
  next: "old-next",
  nextTone: "green",
  files: 7,
  segment: "VIP",
  followUp: "old-follow",
};

const GOLDEN_CURRENT_STUDENTS = [
  {
    ...EXISTING_DEFAULTS,
    id: "STU-M-05TOX2H0IZZ4GT",
    name: "Old A",
    status: "在读",
    sourceRow: "10",
    masterSourceKey: "MSK-N-0QNHCRF1EUF40P",
    importSource: "master",
    location: "old-location",
    grade: "old-grade",
    custom: "existing",
    lessonPackages: [
      {
        id: "PKG-MANUAL-Z", name: "Manual", subjectIds: ["MAN"],
        purchaseRecords: [{ id: "BUY-MANUAL-Z", purchasedAt: "2025-01-01T00:00:00.000Z", hours: 2 }],
        consumedHours: 0,
      },
      {
        id: "PKG-JWB-OLD", name: "Old managed", subjectIds: ["OLD"],
        purchaseRecords: [{ id: "BUY-JWB-OLD", purchasedAt: "2025-01-01T00:00:00.000Z", hours: 9 }],
        consumedHours: 1,
      },
    ],
  },
  {
    ...EXISTING_DEFAULTS,
    id: "STU-M-19XT7ZV1HRLNSV",
    name: "Old C",
    status: "在读",
    sourceRow: "20",
    masterSourceKey: "MSK-N-049X92G1N8CFQQ",
    importSource: "master",
    lessonPackages: [
      {
        id: "PKG-MANUAL-A", name: "Manual A", subjectIds: ["MAN-A"],
        purchaseRecords: [{ id: "BUY-MANUAL-A", purchasedAt: "2025-02-01T00:00:00.000Z", hours: 3 }],
        consumedHours: 1,
      },
      {
        id: "PKG-JWB-PRESERVE", name: "Preserved managed", subjectIds: ["SCI"],
        purchaseRecords: [{ id: "BUY-JWB-PRESERVE", purchasedAt: "2025-02-02T00:00:00.000Z", hours: 6 }],
        consumedHours: 2,
      },
    ],
    packageCoverage: "partial",
    remainingHours: 4,
    contractHours: 6,
  },
  { ...EXISTING_DEFAULTS, id: "TRIAL-Z", name: "  Trial　Kid ", segment: "试听", status: "" },
  { ...EXISTING_DEFAULTS, id: "LEGACY-OVERRIDE", name: " Legacy Override ", status: "在读" },
  { ...EXISTING_DEFAULTS, id: "LEGACY-FU", name: "Legacy FU", status: "在读" },
  { ...EXISTING_DEFAULTS, id: "DROP-ME", name: "Drop Me", status: "在读" },
];

const GOLDEN_MASTER_ROWS = [
  {
    sourceRow: "10", name: "Ａlice　😀", status: "活跃 + 有课时",
    attributes: {
      location: "NSW", year: "Year 8", owner: "master-owner", planner: "master-planner",
    },
  },
  {
    sourceRow: "20", name: "Carol", status: "活跃 + 有课时",
    attributes: { location: "Perth" },
  },
  { sourceRow: "30", name: "Bob", status: "在读", attributes: { location: "Melbourne" } },
  { sourceRow: "50", name: "Dave", status: "活跃 + 无课时", attributes: { location: "Brisbane" } },
];

const GOLDEN_JWB_ROWS = [
  {
    sourceRow: "J-A",
    name: "Alice 😀",
    remainingHours: 6,
    contractHours: 10,
    contractEffectiveDate: "2026-02-01",
    packageCoverage: "complete",
    attributes: {
      jiaowubaoPackageImport: {
        status: "packages_from_current_course_balances",
        currentTotalHours: 10,
        currentUsedHours: 4,
        currentRemainingHours: 6,
        adjustmentContracts: [],
      },
    },
    lessonPackages: [{
      sourcePackageId: "A-course",
      name: " 英语 ",
      subjectIds: ["ENG", "MATH"],
      purchaseRecords: [{ sourcePurchaseId: "A-buy", purchasedAt: "2026-01-02", hours: 10, note: " first " }],
      consumedHours: 4,
    }],
  },
  {
    sourceRow: "J-C", name: "Carol", remainingHours: 5, contractHours: 8, packageCoverage: "partial",
    attributes: {
      jiaowubaoPackageImport: {
        status: "partial_packages_unresolved_course_balances",
        currentTotalHours: 8,
        currentUsedHours: 3,
        currentRemainingHours: 5,
        unresolvedCourseBalances: [{
          courseId: "C-unresolved", title: "Unresolved", totalHours: 2, usedHours: 1, remainingHours: 1,
        }],
        adjustmentContracts: [],
      },
    },
    lessonPackages: [{
      sourcePackageId: "C-course", name: "Science", subjectIds: ["SCI"],
      purchaseRecords: [{ sourcePurchaseId: "C-buy", purchasedAt: "2026-02-02", hours: 6 }],
      consumedHours: 2,
    }],
  },
  {
    sourceRow: "J-B1", name: "Bob", remainingHours: 5, contractHours: 8, packageCoverage: "partial",
    lessonPackages: [{
      sourcePackageId: "B1", name: "B1", subjectIds: ["SCI"],
      purchaseRecords: [{ sourcePurchaseId: "B1-buy", purchasedAt: "2026-02-02", hours: 8 }],
      consumedHours: 3,
    }],
    attributes: {
      jiaowubaoPackageImport: {
        status: "partial_packages_unresolved_course_balances",
        currentTotalHours: 8,
        currentUsedHours: 3,
        currentRemainingHours: 5,
        unresolvedCourseBalances: [],
        adjustmentContracts: [],
      },
    },
  },
  {
    sourceRow: "J-B2", name: "Bob", remainingHours: 4, contractHours: 8, packageCoverage: "partial",
    lessonPackages: [{
      sourcePackageId: "B2", name: "B2", subjectIds: ["SCI"],
      purchaseRecords: [{ sourcePurchaseId: "B2-buy", purchasedAt: "2026-02-02", hours: 8 }],
      consumedHours: 4,
    }],
    attributes: {
      jiaowubaoPackageImport: {
        status: "partial_packages_unresolved_course_balances",
        currentTotalHours: 8,
        currentUsedHours: 4,
        currentRemainingHours: 4,
        unresolvedCourseBalances: [],
        adjustmentContracts: [],
      },
    },
  },
  {
    sourceRow: "J-D", name: "Dave", remainingHours: -2, contractHours: 0, packageCoverage: "none",
    attributes: {
      jiaowubaoPackageImport: {
        status: "aggregate_only_negative_balance",
        currentTotalHours: 0,
        currentUsedHours: 2,
        currentRemainingHours: -2,
        adjustmentContracts: [],
      },
    },
  },
];

function functionBody(qualifiedName, nextMarker) {
  const start = sql.toLowerCase().indexOf(`create or replace function ${qualifiedName}`.toLowerCase());
  assert.notEqual(start, -1, `${qualifiedName} is missing`);
  const end = nextMarker
    ? sql.toLowerCase().indexOf(nextMarker.toLowerCase(), start)
    : sql.toLowerCase().indexOf("\n$$;", start) + 4;
  assert.ok(end > start, `${qualifiedName} body boundary is missing`);
  return sql.slice(start, end);
}

test("TypeScript golden fixture covers every projection precedence branch", () => {
  const sourceSnapshot = parseStudentImportSourceSnapshot({
    master: { sourceId: "fixture-😀", revision: "master-r1", rows: GOLDEN_MASTER_ROWS },
    jwb: { sourceId: "jwb-fixture", revision: "jwb-r1", rows: GOLDEN_JWB_ROWS },
    identityLinks: [],
    studentNumberReservations: [],
    identityLinkFingerprint: `sha256:${"0".repeat(64)}`,
    identityReviewEpoch: 0,
    masterDuplicateResolutions: [],
    masterDuplicateResolutionFingerprint: `sha256:${"1".repeat(64)}`,
    fuAttachmentReferences: {
      studentIds: ["LEGACY-FU"],
      fingerprint: `sha256:${"2".repeat(64)}`,
    },
  });
  const plan = buildStudentImportPlan({
    masterRows: sourceSnapshot.master.rows,
    jwbRows: sourceSnapshot.jwb.rows,
    existingStudents: GOLDEN_CURRENT_STUDENTS,
    masterSourceNamespace: sourceSnapshot.master.sourceId,
    allowLegacyIdentityFallback: false,
    preserveManualTrials: true,
    // SQL derives these from a booking occurrence override and FU attachment.
    preserveReferencedStudentIds: new Set(["LEGACY-OVERRIDE", "LEGACY-FU"]),
  });

  assert.deepEqual(plan.students, GOLDEN_PROJECTION);
  assert.deepEqual(plan.ambiguous, [{
    kind: "name",
    normalizedName: "bob",
    masterSourceRows: ["30"],
    jwbSourceRows: ["J-B1", "J-B2"],
    existingStudentIds: [],
  }]);
  assert.ok(!GOLDEN_PROJECTION_JSON.includes("DROP-ME"));
  assert.ok(!GOLDEN_PROJECTION_JSON.includes("PKG-JWB-OLD"));
});

test("new-student initials keep complete Unicode code points", () => {
  const plan = buildStudentImportPlan({
    masterRows: [{ sourceRow: "emoji-initials", name: "A 😀", status: "在读" }],
    jwbRows: [],
    existingStudents: [],
    masterSourceNamespace: "fixture-😀",
    allowLegacyIdentityFallback: false,
  });
  assert.equal(plan.students[0]?.initials, "A😀");
  assert.doesNotMatch(String(plan.students[0]?.initials), /[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test("name matching uses NFKC plus ASCII-only case folding", () => {
  assert.equal(normalizeStudentImportName("ÉLODIE"), "Élodie");
  assert.notEqual(normalizeStudentImportName("ÉLODIE"), "élodie");

  const nameKey = functionBody("internal.student_import_name_key");
  assert.doesNotMatch(nameKey, /\blower\s*\(/i);
  assert.match(nameKey, /translate\s*\(/i);
  assert.match(nameKey, /ABCDEFGHIJKLMNOPQRSTUVWXYZ[\s\S]*abcdefghijklmnopqrstuvwxyz/i);
  assert.match(sql, /student_import_name_key\s*\(\s*'ÉLODIE'\s*\)[\s\S]*<\s*>\s*'Élodie'/i);
  assert.match(sql, /student_import_initials\s*\(\s*'A 😀'\s*\)[\s\S]*<\s*>\s*'A😀'/i);
});

test("student commit keeps one six-argument RPC and accepts no caller projection digest", () => {
  const commit = functionBody(
    "public.commit_student_import_plan_atomic",
    "revoke all on function public.commit_student_import_plan_atomic",
  );

  assert.match(commit, /p_plan_fingerprint\s+text[\s\S]*p_expected_student_version\s+bigint[\s\S]*p_source_revisions\s+jsonb[\s\S]*p_students\s+jsonb[\s\S]*p_actor\s+text/i);
  assert.doesNotMatch(commit, /p_projection_fingerprint/i);
  assert.match(
    sql,
    /revoke all on function public\.commit_student_import_plan_atomic\(text, text, bigint, jsonb, jsonb, text\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.commit_student_import_plan_atomic\(text, text, bigint, jsonb, jsonb, text\)[\s\S]*to anon, authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.commit_student_import_plan_atomic\(text, text, text, bigint, jsonb, jsonb, text\)/i,
    "no caller-supplied projection-fingerprint overload may be executable",
  );
});

test("the database reconstructs the complete projection from locked evidence", () => {
  const projection = functionBody("internal.student_import_canonical_projection");
  const commit = functionBody(
    "public.commit_student_import_plan_atomic",
    "revoke all on function public.commit_student_import_plan_atomic",
  );

  assert.match(projection, /p_master_source_id\s+text/i);
  assert.match(projection, /p_resolved_master_rows\s+jsonb/i);
  assert.match(projection, /p_jwb_rows\s+jsonb/i);
  assert.match(projection, /p_current_students\s+jsonb/i);
  assert.match(projection, /p_identity_links\s+jsonb/i);
  assert.match(projection, /p_referenced_student_ids\s+jsonb/i);

  assert.match(commit, /expected_students\s+jsonb/i);
  assert.match(commit, /expected_students\s*:=\s*internal\.student_import_canonical_projection\s*\(/i);
  assert.ok(
    commit.indexOf("expected_students := internal.student_import_canonical_projection")
      > commit.indexOf("from internal.student_import_source_rows s"),
    "projection must be built only after the source rows are locked",
  );
  assert.ok(
    commit.indexOf("expected_students := internal.student_import_canonical_projection")
      > commit.indexOf("for locked_state in"),
    "projection must be built only after current/reference ops_state rows are locked",
  );
  assert.match(commit, /internal\.student_import_canonical_projection\s*\([\s\S]*master\.source_id[\s\S]*resolved_master_rows[\s\S]*jwb\.rows[\s\S]*current_state\.payload/i);
  assert.match(commit, /internal\.student_import_canonical_projection\s*\([\s\S]*link_set\.links/i);
});

test("every referenced student source, including nested booking overrides, feeds canonical archives", () => {
  const commit = functionBody(
    "public.commit_student_import_plan_atomic",
    "revoke all on function public.commit_student_import_plan_atomic",
  );
  const projectionCallAt = commit.indexOf("expected_students := internal.student_import_canonical_projection");
  assert.ok(projectionCallAt > 0);
  const beforeProjection = commit.slice(0, projectionCallAt);

  assert.match(beforeProjection, /reference_entities\s+constant\s+text\[\][\s\S]*'bookings'[\s\S]*'files'[\s\S]*'lpItems'[\s\S]*'messages'[\s\S]*'operations'[\s\S]*'payroll'[\s\S]*'renewals'[\s\S]*'tasks'/i);
  assert.match(beforeProjection, /jsonb_array_elements\([\s\S]*occurrenceOverrides[\s\S]*override[\s\S]*studentId/i);
  assert.match(beforeProjection, /student_fu_attachments[\s\S]*student_id/i);
  assert.match(commit, /internal\.student_import_canonical_projection\s*\([\s\S]*referenced_student_ids/i);
  assert.match(commit, /jsonb_array_elements_text\(referenced_student_ids\)[\s\S]*archived_student ->> 'id'/i);
  assert.match(commit, /jsonb_array_elements_text\(referenced_student_ids\)[\s\S]*old_student ->> 'id'/i);
});

test("canonical projection owns managed overlays and JWB package derivation", () => {
  const projection = functionBody("internal.student_import_canonical_projection");

  for (const managedField of [
    "id", "name", "status", "sourceRow", "masterSourceKey", "importSource",
    "jwbMatchStatus", "jwbSourceRow", "remainingHours", "contractHours",
    "contractEffectiveDate", "lessonPackages", "packageCoverage",
    "importArchived", "importArchivedReason",
  ]) {
    assert.match(projection, new RegExp(`['\"]${managedField}['\"]`, "i"), `${managedField} must be database-owned`);
  }

  assert.match(projection, /student_import_defaults/i);
  assert.match(projection, /student_import_(?:copy_)?unmanaged|managed_fields/i);
  assert.match(projection, /attributes[\s\S]*location[\s\S]*year[\s\S]*owner[\s\S]*planner/i);
  assert.match(projection, /student_import_package_id/i);
  assert.match(projection, /student_import_purchase_id/i);
  assert.match(projection, /PKG-JWB-/i);
  assert.match(projection, /packageCoverage[\s\S]*complete[\s\S]*partial[\s\S]*none/is);
  assert.match(projection, /existing_manual_packages|manual_packages/i);
  assert.match(projection, /purchaseRecords[\s\S]*consumedHours/i);
  assert.match(projection, /remainingHours[\s\S]*contractHours/i);
  assert.match(
    projection,
    /preserve_existing_aggregate\s*:=\s*matched_jwb is null[\s\S]*partial[\s\S]*none/i,
  );
  assert.match(
    projection,
    /preserve_existing_aggregate[\s\S]*existing_student -> 'remainingHours'[\s\S]*existing_student -> 'contractHours'/i,
  );
});

test("canonical package helpers bound aggregate integer micro-hours", () => {
  const packages = functionBody("internal.student_import_canonical_jwb_packages");
  const totals = functionBody("internal.student_import_package_totals");

  for (const helper of [packages, totals]) {
    assert.match(helper, /9007199254740991/i);
    assert.match(helper, /(?:purchase|contract)_total\s*\*\s*1000000/i);
    assert.match(helper, /remaining_total\s*\*\s*1000000/i);
    assert.match(helper, /invalid_student_import_(?:jwb_)?package_total/i);
  }
  assert.match(
    sql,
    /student_import_canonical_jwb_packages\s*\([\s\S]*9007199254\.740991[\s\S]*invalid_student_import_jwb_package_total/i,
  );
});

test("canonical output ordering mirrors TypeScript without reordering nested ledgers", () => {
  const projection = functionBody("internal.student_import_canonical_projection");
  assert.match(projection, /jsonb_agg\([\s\S]*order by[\s\S]*(?:sourceRow|source_key|student_id|->> 'id')/i);
  assert.match(projection, /manual_trial[\s\S]*order by[\s\S]*(?:student_id|->> 'id')/i);
  assert.match(projection, /referenced_history[\s\S]*order by[\s\S]*(?:student_id|->> 'id')/i);
  assert.match(projection, /(?:with ordinality|ordinality|source_position|package_position)/i);
  assert.match(projection, /lessonPackages[\s\S]*(?:ordinality|source_position|package_position)/i);
  assert.match(projection, /purchaseRecords[\s\S]*(?:ordinality|source_position|purchase_position)/i);
});

test("caller projection must equal DB projection and only DB projection is persisted", () => {
  const commit = functionBody(
    "public.commit_student_import_plan_atomic",
    "revoke all on function public.commit_student_import_plan_atomic",
  );
  assert.match(commit, /p_students\s+(?:is distinct from|<>)\s+expected_students/i);
  assert.match(commit, /student_import_(?:projection|canonical_projection)_mismatch/i);
  assert.match(commit, /projected_student ->> 'jwbMatchStatus' = 'ambiguous'[\s\S]*student_import_ambiguous_projection/i);
  assert.doesNotMatch(commit, /p_projection_fingerprint/i);

  assert.match(commit, /students_hash\s*:=\s*encode\s*\(\s*extensions\.digest\s*\(\s*expected_students::text/i);
  assert.match(commit, /update public\.ops_state[\s\S]*payload\s*=\s*expected_students/i);
  assert.doesNotMatch(commit, /update public\.ops_state[\s\S]*payload\s*=\s*p_students/i);
  assert.match(commit, /'studentCount'\s*,\s*jsonb_array_length\(expected_students\)/i);
});

test("idempotent replay is bound to the post-commit bookings result as well as students", () => {
  const commit = functionBody(
    "public.commit_student_import_plan_atomic",
    "revoke all on function public.commit_student_import_plan_atomic",
  );
  const replayAt = commit.indexOf("if replaying_prior then");
  const replayReturnAt = commit.indexOf("return query select", replayAt);
  assert.ok(replayAt > 0 && replayReturnAt > replayAt);
  const replayGuard = commit.slice(replayAt, replayReturnAt);

  assert.match(sql, /create table if not exists internal\.student_import_commits[\s\S]*bookings_version_before\s+bigint\s+not null/i);
  assert.match(sql, /create table if not exists internal\.student_import_commits[\s\S]*bookings_version\s+bigint\s+not null/i);
  assert.match(sql, /create table if not exists internal\.student_import_commits[\s\S]*bookings_sha256\s+text\s+not null[\s\S]*\^\[a-f0-9\]\{64\}\$/i);
  assert.match(replayGuard, /current_state\.version\s*<>\s*prior\.students_version/i);
  assert.match(replayGuard, /booking_state\.version\s*<>\s*prior\.bookings_version/i);
  assert.match(replayGuard, /extensions\.digest\(current_state\.payload::text,\s*'sha256'\)[\s\S]*prior\.students_sha256/i);
  assert.match(replayGuard, /extensions\.digest\(booking_state\.payload::text,\s*'sha256'\)[\s\S]*prior\.bookings_sha256/i);
  assert.match(replayGuard, /student_import_idempotent_state_changed/i);
  assert.match(commit, /p_source_revisions\s*-\s*'master'[\s\S]*'bookingsVersion'/i);
  assert.match(commit, /booking_state\.version\s*<>\s*expected_bookings_version/i);
  assert.match(commit, /prior\.bookings_version_before\s*<>\s*expected_bookings_version/i);

  const duplicateProofAt = commit.indexOf("duplicate_snapshot := internal.student_import_master_duplicate_snapshot");
  const projectionProofAt = commit.indexOf("expected_students := internal.student_import_canonical_projection");
  assert.ok(replayReturnAt > duplicateProofAt, "replay must revalidate duplicate decisions before returning");
  assert.ok(replayReturnAt > projectionProofAt, "replay must revalidate the DB-owned projection before returning");
  assert.match(commit, /duplicate_decision_state\.version\s*:=\s*p_expected_student_version/i);

  assert.match(commit, /insert into internal\.student_import_commits\s*\([\s\S]*bookings_version[\s\S]*bookings_sha256/i);
  assert.match(commit, /booking_state\.version[\s\S]*encode\(extensions\.digest\(booking_state\.payload::text,\s*'sha256'\),\s*'hex'\)/i);
  assert.ok(
    commit.lastIndexOf("booking_state.version") > commit.indexOf("if next_bookings is distinct from booking_state.payload then"),
    "the stored booking proof must describe the final state after optional package backfill",
  );
});

test("canonical projection helpers are private and carry a fixed SQL fixture", () => {
  const helperNames = [...sql.matchAll(/create or replace function internal\.(student_import_[a-z0-9_]+)\s*\(/gi)]
    .map((match) => match[1])
    .filter((name) => /canonical_projection|unmanaged|package|purchase|jwb/.test(name));
  assert.ok(helperNames.includes("student_import_canonical_projection"));
  for (const helperName of new Set(helperNames)) {
    assert.match(
      sql,
      new RegExp(`revoke all on function internal\\.${helperName}\\([^)]*\\)\\s+from public, anon, authenticated`, "i"),
      `${helperName} must not be directly executable by API roles`,
    );
  }
  const fixtureAt = sql.indexOf("student_import_canonical_projection_fixture_mismatch");
  assert.ok(fixtureAt > 0, "migration must fail itself when its projection differs from the golden value");
  const fixtureStart = sql.lastIndexOf("\ndo $$", fixtureAt);
  const fixtureEnd = sql.indexOf("\n$$;", fixtureAt);
  assert.ok(fixtureStart > 0 && fixtureEnd > fixtureAt, "projection fixture DO block is incomplete");
  const fixture = sql.slice(fixtureStart + 1, fixtureEnd + 4);
  assert.match(fixture, /internal\.student_import_canonical_projection\s*\(/i);
  assert.match(fixture, /projection_result\s+(?:is distinct from|<>)\s+expected_projection/i);

  const call = fixture.match(
    /internal\.student_import_canonical_projection\s*\(\s*'([^']*)'\s*,\s*'([^']*)'::jsonb\s*,\s*'([^']*)'::jsonb\s*,\s*'([^']*)'::jsonb\s*,\s*'([^']*)'::jsonb\s*,\s*'([^']*)'::jsonb\s*\)/i,
  );
  assert.ok(call, "projection fixture arguments must be literal and inspectable");
  assert.equal(call[1], "fixture-😀");
  assert.deepEqual(JSON.parse(call[2]), GOLDEN_MASTER_ROWS);
  assert.deepEqual(JSON.parse(call[3]), GOLDEN_JWB_ROWS);
  assert.deepEqual(JSON.parse(call[4]), GOLDEN_CURRENT_STUDENTS);
  assert.deepEqual(JSON.parse(call[5]), []);
  assert.deepEqual(JSON.parse(call[6]), ["LEGACY-OVERRIDE", "LEGACY-FU"]);

  const expected = fixture.match(/expected_projection\s*:=\s*'([^']*)'::jsonb/i);
  assert.ok(expected, "projection fixture expected value must be literal and inspectable");
  assert.deepEqual(JSON.parse(expected[1]), GOLDEN_PROJECTION);
});

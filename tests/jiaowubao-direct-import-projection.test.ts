import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalJson,
  JIAOWUBAO_DIRECT_STAGING_FORMAT,
  JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS,
  type JiaowubaoDirectPreparedStaging,
  type JiaowubaoDirectStagingChunk,
  type JiaowubaoDirectStagingRecord,
  type JiaowubaoDirectStagingRecordKind,
  type JiaowubaoDirectWorkbookManifest,
} from "../lib/jiaowubao-direct-import-preflight.ts";
import {
  buildJiaowubaoDirectAtomicImportRequest,
  buildJiaowubaoDirectSequentialImportPlan,
  compileJiaowubaoDirectImportProjection,
  JIAOWUBAO_DIRECT_IMPORT_FORMAT,
  JiaowubaoDirectProjectionError,
  type JiaowubaoDirectProjectionAuthority,
} from "../lib/jiaowubao-direct-import-projection.ts";

const SHA256 = "a".repeat(64);
const TIMEZONE_BASIS = JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS;

const WORKBOOK_KINDS = [
  "quick_list",
  "students",
  "contracts",
  "hours",
  "class_members",
  "schedule",
  "leave_makeups",
] as const;

function emptyCounts(): Record<JiaowubaoDirectStagingRecordKind, number> {
  return {
    student_snapshot: 0,
    quick_list: 0,
    contract_history: 0,
    hour_balance: 0,
    class_membership: 0,
    schedule_event: 0,
    leave_makeup: 0,
  };
}

function workbookFor(kind: (typeof WORKBOOK_KINDS)[number], count: number): JiaowubaoDirectWorkbookManifest {
  return {
    kind,
    workbookName: `${kind}.xlsx`,
    workbookSha256: SHA256,
    sheetName: "Sheet1",
    sourceRecordCount: count,
  } as JiaowubaoDirectWorkbookManifest;
}

function refFor(kind: JiaowubaoDirectStagingRecordKind, number: number) {
  const workbook = kind === "student_snapshot" ? "students"
    : kind === "contract_history" ? "contracts"
      : kind === "hour_balance" ? "hours"
        : kind === "class_membership" ? "class_members"
          : kind === "schedule_event" ? "schedule"
            : kind === "leave_makeup" ? "leave_makeups"
              : "quick_list";
  return kind === "schedule_event"
    ? [{ workbook, row: number, cell: `B${number}` }]
    : [{ workbook, row: number }];
}

function sourceKey(kind: JiaowubaoDirectStagingRecordKind, number: number) {
  return `jwb-static-v1:${kind}:r${number}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function record(
  kind: JiaowubaoDirectStagingRecordKind,
  number: number,
  source: Record<string, unknown>,
  staging: Record<string, unknown> = {},
): JiaowubaoDirectStagingRecord {
  const base = {
    kind,
    sourceKey: sourceKey(kind, number),
    sourceRefs: refFor(kind, number),
    studentRelationship: {
      state: kind === "schedule_event" || kind === "leave_makeup" || kind === "student_snapshot"
        ? "pending_authoritative_tencent_match"
        : "not_applicable",
      automaticAttachment: "forbidden",
      sourceIdentity: kind === "schedule_event" ? "schedule_display_names" : "tabular_identity_hint",
    },
    payload: {
      source,
      staging: {
        entity: kind,
        writeMode: "server_only_relational_staging",
        studentCreation: "forbidden",
        ...staging,
      },
    },
  };
  return {
    ...base,
    sourceDigest: sha256(canonicalJson(base)),
  } as JiaowubaoDirectStagingRecord;
}

function supplemental(
  number: number,
  name: string,
  phone: string,
  kind: Extract<JiaowubaoDirectStagingRecordKind, "student_snapshot" | "quick_list" | "contract_history" | "hour_balance" | "class_membership"> = "student_snapshot",
) {
  return record(kind, number, {
    identity: { name, phone },
    raw: { fields: { 姓名: name, 手机号: phone } },
  });
}

function schedule(
  number: number,
  teacher: string,
  names: readonly string[],
  options: Readonly<{ course?: string; rawText?: string; resolved?: boolean }> = {},
) {
  const resolved = options.resolved ?? true;
  return record("schedule_event", number, {
    raw: { rawText: options.rawText ?? "regular operational class" },
    sourceDate: "2026-08-18",
    sourceTimezone: "Australia/Melbourne",
    className: "Fixture class",
    course: options.course ?? "",
    teacher,
    studentDisplayNames: names,
  }, {
    temporal: resolved
      ? {
        state: "resolved",
        sourceDate: "2026-08-18",
        start: "09:00",
        end: "10:00",
        sourceTimezone: "Australia/Melbourne",
        sourceStartInstant: "2026-08-17T23:00:00.000Z",
        sourceEndInstant: "2026-08-18T00:00:00.000Z",
      }
      : {
        state: "invalid",
        reason: "invalid_time_interval",
        sourceDate: "2026-08-18",
        sourceTimezone: "Australia/Melbourne",
      },
  });
}

function leave(number: number, name: string) {
  return record("leave_makeup", number, {
    identity: { name },
    raw: { fields: { 姓名: name, 请假类型: "personal" } },
    sourceDate: "2026-08-18",
  });
}

function prepared(...recordChunks: readonly (readonly JiaowubaoDirectStagingRecord[])[]): JiaowubaoDirectPreparedStaging {
  const counts = emptyCounts();
  const workbookCounts: Record<string, number> = Object.fromEntries(WORKBOOK_KINDS.map((kind) => [kind, 0]));
  for (const records of recordChunks) {
    for (const item of records) {
      counts[item.kind] += 1;
      workbookCounts[item.sourceRefs[0].workbook] += 1;
    }
  }
  const workbooks = WORKBOOK_KINDS.map((kind) => workbookFor(kind, workbookCounts[kind]));
  const recordOrder = new Map<JiaowubaoDirectStagingRecordKind, number>([
    ["student_snapshot", 0],
    ["quick_list", 1],
    ["contract_history", 2],
    ["hour_balance", 3],
    ["class_membership", 4],
    ["schedule_event", 5],
    ["leave_makeup", 6],
  ]);
  const revision = `sha256:${sha256(canonicalJson({
    format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
    sourceTimezone: "Australia/Melbourne",
    workbooks,
    records: recordChunks.flat()
      .sort((left, right) => (recordOrder.get(left.kind) ?? 0) - (recordOrder.get(right.kind) ?? 0)
        || left.sourceKey.localeCompare(right.sourceKey))
      .map((item) => ({ kind: item.kind, sourceKey: item.sourceKey, sourceDigest: item.sourceDigest })),
  }))}`;
  const chunks = recordChunks.map((records, index) => ({
    format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
    revision,
    contract: {
      storage: "server_only_relational_staging",
      studentAuthority: "tencent_master",
      studentCreation: "forbidden",
      studentMatching: "server_side_current_tencent_only",
      scheduleProjection: "read_only_imported_schedule_event",
      scheduleBookingExpansion: "forbidden",
      sourceMutation: "forbidden",
    },
    sourceTimezone: "Australia/Melbourne",
    sourceTimezoneBasis: TIMEZONE_BASIS,
    workbooks,
    recordCounts: counts,
    chunk: { index, count: recordChunks.length },
    records,
  })) as readonly JiaowubaoDirectStagingChunk[];
  return {
    revision,
    contract: chunks[0].contract,
    workbooks,
    recordCounts: counts,
    chunks,
    manifest: {
      format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
      revision,
      contract: chunks[0].contract,
      sourceTimezone: "Australia/Melbourne",
      sourceTimezoneBasis: TIMEZONE_BASIS,
      workbooks,
      recordCounts: counts,
      chunks: chunks.map((chunk) => ({
        index: chunk.chunk.index,
        fileName: `chunks/${String(chunk.chunk.index + 1).padStart(4, "0")}.json`,
        recordCount: chunk.records.length,
        bytes: Buffer.byteLength(canonicalJson(chunk), "utf8"),
        sha256: sha256(canonicalJson(chunk)),
      })),
    },
    reconciliation: {} as JiaowubaoDirectPreparedStaging["reconciliation"],
  };
}

function authority(
  masterRows: readonly Readonly<{ sourceRow: number; name: string; status: string }>[],
  teacherRows: readonly Readonly<{ id: string; name: string }>[],
): JiaowubaoDirectProjectionAuthority {
  return {
    masterSource: {
      sourceId: "tencent-master",
      revision: "tencent-revision",
      rowsSha256: "b".repeat(64),
      rows: masterRows,
    },
    students: masterRows
      .filter((row) => row.status !== "不活跃 + 无课时")
      .map((row) => ({
        id: `student-${row.sourceRow}`,
        name: row.name,
        sourceRow: row.sourceRow,
        importSource: "master",
      })),
    teachers: teacherRows,
  };
}

test("projects unique Tencent matches, class participants, leave incidents, and AVA blocks without course gating", () => {
  const learner = "Ready Learner";
  const phone = "0400000001";
  const classmate = "Ready Classmate";
  const classmatePhone = "0400000002";
  const learnerSupplement = supplemental(3, learner, phone);
  const classmateSupplement = supplemental(4, classmate, classmatePhone, "quick_list");
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared([
      learnerSupplement,
      supplemental(5, learner, phone, "class_membership"),
      classmateSupplement,
      schedule(6, "Exact Tutor", [learner, classmate], { course: "" }),
      leave(7, learner),
    ]),
    authority([
      { sourceRow: 101, name: learner, status: "在读" },
      { sourceRow: 102, name: classmate, status: "活跃 + 有课时" },
    ], [{ id: "teacher-101", name: "Exact Tutor" }]),
  );

  const projection = compiled.chunks[0].projection;
  assert.equal(projection.supplemental.length, 3);
  assert.equal(projection.supplemental.filter((entry) => entry.identityProof).length, 2);
  assert.equal(projection.supplemental[0].resolution.state, "attached");
  assert.equal(projection.scheduleEvents[0].teacherResolution, "exact_name");
  assert.equal(projection.scheduleEvents[0].availabilityEffect, "blocks_teacher_ava");
  assert.deepEqual(projection.scheduleEvents[0].participants[0].resolution, { state: "attached", reason: null });
  assert.equal(projection.scheduleEvents[0].participants[0].identitySupplementalSourceKey, learnerSupplement.sourceKey);
  assert.deepEqual(projection.scheduleEvents[0].participants[1].resolution, { state: "attached", reason: null });
  assert.equal(projection.scheduleEvents[0].participants[1].identitySupplementalSourceKey, classmateSupplement.sourceKey);
  assert.equal(projection.leaveMakeups[0].incidentKind, "leave");
  assert.equal(projection.leaveMakeups[0].resolution.state, "attached");
  assert.equal(compiled.report.schedule.blocksTeacherAva, 1);
  assert.deepEqual(compiled.report.schedule.subjectResolution, {
    unresolved: 1,
    sourceCourseMissing: 1,
  });

  const report = canonicalJson(compiled.report);
  assert.equal(report.includes(learner), false);
  assert.equal(report.includes(phone), false);
  assert.equal(report.includes(classmate), false);
  assert.equal(report.includes(classmatePhone), false);
  assert.equal(report.includes("Exact Tutor"), false);

  const request = buildJiaowubaoDirectAtomicImportRequest(compiled, "local-importer");
  assert.equal(request.format, JIAOWUBAO_DIRECT_IMPORT_FORMAT);
  assert.equal(request.chunks.length, 1);
  assert.equal("projectionSha256" in request.chunks[0], false);
  assert.equal(canonicalJson(request.chunks[0].chunk), canonicalJson(compiled.chunks[0].chunk));
  const sequential = buildJiaowubaoDirectSequentialImportPlan(compiled, "local-importer");
  assert.equal(sequential.begin.envelope, compiled.envelope);
  assert.equal(sequential.stages.length, 1);
  assert.deepEqual(sequential.complete, { actor: "local-importer" });
});

test("binds audited legacy Tencent students by globally unique active name while retaining explicit master source proof", () => {
  const legacyName = "Legacy Active Learner";
  const explicitName = "Explicit Master Learner";
  const coexistName = "Legacy Beside Manual Learner";
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared([
      supplemental(801, legacyName, "0400000801"),
      supplemental(802, explicitName, "0400000802"),
      supplemental(803, coexistName, "0400000803"),
    ]),
    {
      masterSource: {
        sourceId: "tencent-master",
        revision: "tencent-revision",
        rowsSha256: "b".repeat(64),
        rows: [
          { sourceRow: 801, name: legacyName, status: "在读" },
          { sourceRow: 802, name: explicitName, status: "在读" },
          { sourceRow: 803, name: coexistName, status: "在读" },
        ],
      },
      students: [
        {
          id: "legacy-active",
          name: legacyName,
          sourceRow: 999_801,
          status: "不活跃 + 无课时",
        },
        {
          id: "explicit-master",
          name: explicitName,
          sourceRow: 802,
          importSource: "master",
        },
        {
          id: "legacy-beside-manual",
          name: coexistName,
          sourceRow: 999_803,
          importSource: "   ",
        },
        {
          id: "manual-source",
          name: coexistName,
          sourceRow: 803,
          importSource: "manual_trial",
        },
      ],
      teachers: [],
    },
  );

  assert.deepEqual(
    compiled.chunks[0].projection.supplemental.map((entry) => entry.resolution),
    [
      { state: "attached", studentId: "legacy-active", masterSourceRow: "801", reason: null },
      { state: "attached", studentId: "explicit-master", masterSourceRow: "802", reason: null },
      { state: "attached", studentId: "legacy-beside-manual", masterSourceRow: "803", reason: null },
    ],
  );
  assert.deepEqual(compiled.report.authority, {
    masterRows: 3,
    activeMasterRows: 3,
    currentStudentCandidates: 3,
    currentMasterStudents: 3,
    currentExplicitMasterStudents: 1,
    currentLegacyMasterStudents: 2,
    currentTeachers: 0,
  });
});

test("rejects stale explicit source rows, duplicate current names, and excluded Tencent masters", () => {
  const staleName = "Stale Explicit Learner";
  const duplicateName = "Duplicate Current Learner";
  const excludedName = "Excluded Legacy Learner";
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared([
      supplemental(811, staleName, "0400000811"),
      supplemental(812, duplicateName, "0400000812"),
      supplemental(813, excludedName, "0400000813"),
    ]),
    {
      masterSource: {
        sourceId: "tencent-master",
        revision: "tencent-revision",
        rowsSha256: "b".repeat(64),
        rows: [
          { sourceRow: 811, name: staleName, status: "在读" },
          { sourceRow: 812, name: duplicateName, status: "在读" },
          { sourceRow: 813, name: excludedName, status: "不活跃 + 无课时" },
        ],
      },
      students: [
        { id: "stale-explicit", name: staleName, sourceRow: 999_811, importSource: "master" },
        { id: "duplicate-a", name: duplicateName },
        { id: "duplicate-b", name: duplicateName, importSource: "" },
        { id: "excluded-legacy", name: excludedName },
      ],
      teachers: [],
    },
  );

  assert.deepEqual(
    compiled.chunks[0].projection.supplemental.map((entry) => entry.resolution.reason),
    ["unmatched_tencent_student", "ambiguous_tencent_student", "excluded_tencent_student"],
  );
  assert.equal(compiled.report.authority.currentStudentCandidates, 4);
  assert.equal(compiled.report.authority.currentMasterStudents, 0);
  assert.equal(compiled.report.authority.currentExplicitMasterStudents, 0);
  assert.equal(compiled.report.authority.currentLegacyMasterStudents, 0);
});

test("quarantines excluded or duplicate Tencent identities and treats non-operational schedule rows as display-only", () => {
  const excluded = "Excluded Learner";
  const duplicate = "Duplicate Learner";
  const operational = "Matched Learner";
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared([
      supplemental(10, excluded, "0400000010"),
      supplemental(11, duplicate, "0400000011"),
      supplemental(12, operational, "0400000012"),
      schedule(13, "Exact Tutor", [operational], { rawText: "退款处理" }),
      schedule(14, "Exact Tutor", [operational], { rawText: "转班处理" }),
      schedule(15, "Exact Tutor", [operational], { rawText: "消课处理" }),
      schedule(16, "Exact Tutor", [operational], { rawText: "测试处理" }),
      schedule(17, "Duplicate Tutor", [operational]),
      schedule(18, "Exact Tutor", [operational], { resolved: false }),
      leave(19, excluded),
    ]),
    authority([
      { sourceRow: 201, name: excluded, status: "不活跃 + 无课时" },
      { sourceRow: 202, name: duplicate, status: "在读" },
      { sourceRow: 203, name: duplicate, status: "活跃 + 有课时" },
      { sourceRow: 204, name: operational, status: "在读" },
    ], [
      { id: "teacher-201", name: "Exact Tutor" },
      { id: "teacher-202", name: "Duplicate Tutor" },
      { id: "teacher-203", name: "Duplicate Tutor" },
    ]),
  );

  const projection = compiled.chunks[0].projection;
  assert.equal(projection.supplemental[0].resolution.reason, "excluded_tencent_student");
  assert.equal(projection.supplemental[1].resolution.reason, "ambiguous_tencent_student");
  assert.equal(projection.leaveMakeups[0].resolution.reason, "excluded_tencent_student");
  assert.deepEqual(
    projection.scheduleEvents.map((entry) => entry.availabilityEffect),
    ["display_only", "display_only", "display_only", "display_only", "display_only", "display_only"],
  );
  assert.equal(projection.scheduleEvents[4].teacherResolution, "ambiguous");
  assert.deepEqual(compiled.report.schedule.nonOperationalByReason, {
    refund: 1,
    transfer: 1,
    consumption: 1,
    test: 1,
  });
  assert.equal(compiled.report.schedule.blocksTeacherAva, 0);
  assert.equal(compiled.report.supplemental.quarantinedByReason.excluded_tencent_student, 1);
  assert.equal(compiled.report.supplemental.quarantinedByReason.ambiguous_tencent_student, 1);
});

test("never emits a schedule attachment that would cite a later staged identity proof", () => {
  const learner = "Late Proof Learner";
  const lateProof = supplemental(31, learner, "0400000031");
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared(
      [schedule(30, "Exact Tutor", [learner])],
      [lateProof],
    ),
    authority([{ sourceRow: 301, name: learner, status: "在读" }], [{ id: "teacher-301", name: "Exact Tutor" }]),
  );

  const scheduleProjection = compiled.chunks[0].projection.scheduleEvents[0];
  assert.equal(compiled.chunks[1].projection.supplemental[0].identityProof, true);
  assert.equal(scheduleProjection.participants[0].resolution.state, "quarantined");
  assert.equal(scheduleProjection.participants[0].resolution.reason, "class_not_resolved");
  assert.equal(scheduleProjection.participants[0].identitySupplementalSourceKey, null);
  assert.equal(scheduleProjection.availabilityEffect, "display_only");
});

test("maps leave/makeup source evidence without inventing operational actions", () => {
  const learner = "Incident Learner";
  const makeup = record("leave_makeup", 36, {
    identity: { name: learner },
    raw: { fields: { 姓名: learner, 补课详情: "recorded makeup" } },
  });
  const unknown = record("leave_makeup", 37, {
    identity: { name: learner },
    raw: { fields: { 姓名: learner } },
  });
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared([makeup, unknown]),
    authority([{ sourceRow: 361, name: learner, status: "在读" }], []),
  );
  assert.deepEqual(
    compiled.chunks[0].projection.leaveMakeups.map((entry) => ({ kind: entry.incidentKind, state: entry.resolution.state })),
    [{ kind: "makeup", state: "attached" }, { kind: "unknown", state: "attached" }],
  );
  assert.deepEqual(compiled.report.leaveMakeups, {
    leave: 0,
    makeup: 1,
    unknown: 1,
    attached: 2,
    quarantined: 0,
    quarantinedByReason: {
      unmatched_tencent_student: 0,
      ambiguous_tencent_student: 0,
      excluded_tencent_student: 0,
      empty_name: 0,
      missing_phone: 0,
      duplicate_identity: 0,
      review_required: 0,
      class_not_resolved: 0,
      invalid_source_value: 0,
    },
  });
});

test("fails closed when the immutable manifest or Melbourne temporal proof is altered", () => {
  const learner = "Integrity Learner";
  const authoritySnapshot = authority(
    [{ sourceRow: 401, name: learner, status: "在读" }],
    [{ id: "teacher-401", name: "Exact Tutor" }],
  );
  const valid = prepared([supplemental(40, learner, "0400000040"), schedule(41, "Exact Tutor", [learner])]);
  const alteredManifest = {
    ...valid,
    manifest: {
      ...valid.manifest,
      chunks: valid.manifest.chunks.map((chunk, index) => index === 0 ? { ...chunk, sha256: "0".repeat(64) } : chunk),
    },
  } as JiaowubaoDirectPreparedStaging;
  assert.throws(
    () => compileJiaowubaoDirectImportProjection(alteredManifest, authoritySnapshot),
    (error: unknown) => error instanceof JiaowubaoDirectProjectionError && error.code === "invalid_preflight",
  );

  const badTemporal = record("schedule_event", 42, {
    raw: { rawText: "regular operational class" },
    sourceDate: "2026-08-18",
    sourceTimezone: "Australia/Melbourne",
    className: "Fixture class",
    teacher: "Exact Tutor",
    studentDisplayNames: [learner],
  }, {
    temporal: {
      state: "resolved",
      sourceDate: "2026-08-18",
      start: "09:00",
      end: "10:00",
      sourceTimezone: "Australia/Melbourne",
      sourceStartInstant: "2026-08-17T22:00:00.000Z",
      sourceEndInstant: "2026-08-18T00:00:00.000Z",
    },
  });
  assert.throws(
    () => compileJiaowubaoDirectImportProjection(
      prepared([supplemental(43, learner, "0400000040"), badTemporal]),
      authoritySnapshot,
    ),
    (error: unknown) => error instanceof JiaowubaoDirectProjectionError && error.code === "invalid_preflight",
  );
});

test("refuses the atomic fixture wrapper for a multi-chunk production-shaped plan", () => {
  const learner = "Sequential Learner";
  const compiled = compileJiaowubaoDirectImportProjection(
    prepared(
      [supplemental(50, learner, "0400000050")],
      [schedule(51, "Exact Tutor", [learner])],
      [schedule(52, "Exact Tutor", [learner])],
      [schedule(53, "Exact Tutor", [learner])],
      [schedule(54, "Exact Tutor", [learner])],
    ),
    authority([{ sourceRow: 501, name: learner, status: "在读" }], [{ id: "teacher-501", name: "Exact Tutor" }]),
  );
  assert.equal(buildJiaowubaoDirectSequentialImportPlan(compiled, "local-importer").stages.length, 5);
  assert.throws(
    () => buildJiaowubaoDirectAtomicImportRequest(compiled, "local-importer"),
    (error: unknown) => error instanceof JiaowubaoDirectProjectionError && error.code === "atomic_fixture_too_large",
  );
});

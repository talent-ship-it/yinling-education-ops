import assert from "node:assert/strict";
import test from "node:test";

import {
  TEACHER_WORKBOOK_SHEETS,
  buildTeacherImportPlan,
  normalizeTeacherImportName,
  teacherCrossWorkbookDecisionKey,
  teacherIdentityResolutionKey,
  teacherSameWorkbookResolutionKey,
  teacherSameWorkbookDecisionKey,
  teacherSubjectResolutionKey,
  teacherIdForSource,
  type TeacherWorkbookSnapshot,
} from "../lib/teacher-import.ts";

function workbook(overrides: Partial<TeacherWorkbookSnapshot> = {}): TeacherWorkbookSnapshot {
  return {
    workbook: "k12",
    sourceId: "fixture-k12",
    revision: "fixture-revision-1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.k12,
    rosterRows: [],
    subjectRows: [],
    ...overrides,
  };
}

test("the authoritative sheet orders mirror the K12 and university workbooks", () => {
  assert.deepEqual(TEACHER_WORKBOOK_SHEETS.k12, [
    "在职总表", "Local English", "ABC华裔English", "Maths&Science", "VCE数学科学", "VCE其他",
    "奖学金", "AEAS", "青少英语", "QCE", "HSC", "WACE", "SACE", "AMC数学竞赛", "科学竞赛",
    "雅思PTE", "IB", "已离职教师",
  ]);
  assert.deepEqual(TEACHER_WORKBOOK_SHEETS.university, [
    "大学老师在职总表", "Engineering", "商科", "IT", "理科", "文科（含论文辅导）", "教育学", "其他科目",
  ]);
});

test("matches subject tabs conservatively and keeps their source order", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{ workbook: "k12", sourceRow: 7, name: "Ａvery   Example", attributes: { location: "VIC" } }],
      subjectRows: [
        { workbook: "k12", sheetName: "IB", sourceRow: 12, name: "avery example", subjectDetail: "Physics" },
        { workbook: "k12", sheetName: "Local English", sourceRow: 3, name: "Avery Example" },
      ],
    })],
  });

  assert.equal(normalizeTeacherImportName(" Ａvery   Example "), "avery example");
  assert.equal(plan.summary.insert, 1);
  assert.deepEqual(plan.teachers[0].subjects, ["Local English", "IB"]);
  assert.equal(plan.teachers[0].subjectDetail, "Physics");
  assert.deepEqual(plan.teachers[0].departments, ["中小学"]);
  assert.equal(plan.teachers[0].location, "VIC");
  assert.equal(plan.teachers[0].availability, "待老师按月提交");
  assert.equal(plan.teachers[0].timezone, "Australia/Melbourne");
  assert.equal(plan.teachers[0].load, 0);
  assert.equal(plan.teachers[0].capacity, 0);
  assert.equal(plan.teachers[0].acceptsStudents, false);
  assert.equal(plan.teachers[0].note, "待教务审核教师资料与月度 AVA");
  assert.equal("availabilityWindows" in plan.teachers[0], false);
  assert.equal("newStudentCapacity" in plan.teachers[0], false);
});

test("uniquely matches subject rows whose roster display only adds an operational state annotation", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: 1, name: "Lauren Johnston(已弱化)" },
        { workbook: "k12", sourceRow: 2, name: "Janice Jiang" },
        { workbook: "k12", sourceRow: 3, name: "Jenny Liang\n(已弱化)" },
      ],
      subjectRows: [
        { workbook: "k12", sheetName: "IB", sourceRow: 11, name: "Lauren Johnston" },
        { workbook: "k12", sheetName: "AEAS", sourceRow: 12, name: "Janice Jiang已弱化" },
        { workbook: "k12", sheetName: "Maths&Science", sourceRow: 13, name: "Jenny Liang(弱化)" },
      ],
    })],
  });

  assert.deepEqual(plan.teachers.map((teacher) => [teacher.name, teacher.subjects]).sort(), [
    ["Lauren Johnston(已弱化)", ["IB"]],
    ["Janice Jiang", ["AEAS"]],
    ["Jenny Liang (已弱化)", ["Maths&Science"]],
  ].sort());
  assert.equal(plan.issues.some((issue) => issue.code === "subject_teacher_not_in_roster"), false);
});

test("matches a parenthesized nickname only when the roster source text corroborates it", () => {
  const confirmed = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{
        workbook: "k12",
        sourceRow: 1,
        name: "Areejz Slamang",
        availabilityText: "Ree老师8.24之后可接新生",
      }],
      subjectRows: [{ workbook: "k12", sheetName: "HSC", sourceRow: 11, name: "Areejz Slamang(Ree)" }],
    })],
  });
  assert.deepEqual(confirmed.teachers[0].subjects, ["HSC"]);
  assert.equal(confirmed.issues.some((issue) => issue.code === "subject_teacher_not_in_roster"), false);

  const unconfirmed = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Areejz Slamang" }],
      subjectRows: [{ workbook: "k12", sheetName: "HSC", sourceRow: 11, name: "Areejz Slamang(Ree)" }],
    })],
  });
  assert.deepEqual(unconfirmed.teachers[0].subjects, []);
  assert.equal(unconfirmed.issues.some((issue) => issue.code === "subject_teacher_not_in_roster"), true);
});

test("operational aliases remain ambiguous when more than one roster row could own a subject", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: 1, name: "Duplicate Teacher(弱化)" },
        { workbook: "k12", sourceRow: 2, name: "Duplicate Teacher(已弱化)" },
      ],
      subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 11, name: "Duplicate Teacher" }],
    })],
  });

  assert.equal(plan.issues.some((issue) => issue.code === "subject_name_ambiguous"), true);
  assert.equal(plan.teachers.every((teacher) => teacher.subjects.length === 0), true);
});

test("explicit operational teacher fields survive source refresh", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 4, name: "Existing Teacher" }] })],
    existingTeachers: [{
      id: "TEA-EXISTING",
      name: "Existing Teacher",
      initials: "ET",
      timezone: "Australia/Perth",
      load: 3,
      capacity: 6,
      acceptsStudents: true,
      note: "Reviewed operational profile",
    }],
  });

  assert.deepEqual(
    Object.fromEntries(["initials", "timezone", "load", "capacity", "acceptsStudents", "note"]
      .map((field) => [field, plan.teachers[0][field]])),
    {
      initials: "ET",
      timezone: "Australia/Perth",
      load: 3,
      capacity: 6,
      acceptsStudents: true,
      note: "Reviewed operational profile",
    },
  );
});

test("teachers absent from a source refresh remain valid and are never deleted", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 4, name: "Imported Teacher" }] })],
    existingTeachers: [{ id: "TEA-MANUAL", name: "Manual Teacher" }],
  });
  const preserved = plan.teachers.find((teacher) => teacher.id === "TEA-MANUAL");
  assert.ok(preserved);
  assert.equal(preserved.timezone, "Australia/Melbourne");
  assert.equal(preserved.acceptsStudents, false);
  assert.equal(plan.actions.find((action) => action.teacherId === "TEA-MANUAL")?.matchMethod, "preserved_existing");
});

test("source references create stable ids and win over a later display-name change", () => {
  const reference = { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 9 };
  const id = teacherIdForSource(reference);
  assert.equal(id, teacherIdForSource(reference));
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 9, name: "Updated Name" }] })],
    existingTeachers: [{ id, name: "Old Name", teacherSourceRefs: [reference], subjects: [] }],
  });

  assert.equal(plan.actions[0].matchMethod, "source_reference");
  assert.equal(plan.actions[0].kind, "update");
  assert.equal(plan.teachers[0].id, id);
  assert.equal(plan.teachers[0].name, "Updated Name");
});

test("a unique legacy name may be linked once and persists the stable source reference", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 4, name: "Legacy Teacher" }] })],
    existingTeachers: [{ id: "TEA-LEGACY", name: "legacy teacher" }],
  });

  assert.equal(plan.actions[0].matchMethod, "unique_name");
  assert.equal(plan.teachers[0].id, "TEA-LEGACY");
  assert.deepEqual(plan.teachers[0].teacherSourceRefs, [{ workbook: "k12", sourceId: "fixture-k12", sourceRow: 4 }]);
});

test("free-text AVA and capacity remain raw and require review even when capacity looks numeric", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{
        workbook: "k12",
        sourceRow: 2,
        name: "Review Teacher",
        availabilityText: "周二晚上；12月后更多",
        capacityText: "2",
      }],
    })],
  });

  assert.equal(plan.teachers[0].availabilitySourceText, "周二晚上;12月后更多");
  assert.equal(plan.teachers[0].capacitySourceText, "2");
  assert.equal(plan.teachers[0].availabilityStatus, "待确认");
  assert.equal("availabilityWindows" in plan.teachers[0], false);
  assert.equal("newStudentCapacity" in plan.teachers[0], false);
  assert.equal(plan.summary.unstructuredAvailability, 1);
  assert.equal(plan.summary.unstructuredCapacity, 1);
});

test("duplicate names never receive subject data and are blocked in dry-run", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: 1, name: "Same Teacher" },
        { workbook: "k12", sourceRow: 2, name: "same teacher" },
      ],
      subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 20, name: "Same Teacher" }],
    })],
  });

  assert.equal(plan.teachers.length, 0);
  assert.equal(plan.summary.blocked, 2);
  assert.deepEqual(plan.issues.map((issue) => issue.code), ["duplicate_roster_name", "subject_name_ambiguous"]);
});

test("same name in K12 and university is not guessed to be one person", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [
      workbook({ rosterRows: [{ workbook: "k12", sourceRow: 3, name: "Cross Roster" }] }),
      workbook({
        workbook: "university",
        sourceId: "fixture-university",
        sheetNames: TEACHER_WORKBOOK_SHEETS.university,
        rosterRows: [{ workbook: "university", sourceRow: 6, name: "Cross Roster" }],
      }),
    ],
  });

  assert.equal(plan.teachers.length, 0);
  assert.equal(plan.summary.blocked, 2);
  assert.equal(plan.issues.some((issue) => issue.code === "cross_workbook_name_ambiguous"), true);
});

test("explicit stable refs merge one teacher across both workbooks", () => {
  const refs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 3 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 6 },
  ];
  const plan = buildTeacherImportPlan({
    workbooks: [
      workbook({
        rosterRows: [{ workbook: "k12", sourceRow: 3, name: "Cross Roster", availabilityText: "周二晚" }],
        subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 13, name: "Cross Roster", subjectDetail: "IB Physics" }],
      }),
      workbook({
        workbook: "university",
        sourceId: "fixture-university",
        sheetNames: TEACHER_WORKBOOK_SHEETS.university,
        rosterRows: [{ workbook: "university", sourceRow: 6, name: "Cross Roster", availabilityText: "周六上午", capacityText: "需确认" }],
        subjectRows: [{ workbook: "university", sheetName: "Engineering", sourceRow: 16, name: "Cross Roster", subjectDetail: "Mechanics" }],
      }),
    ],
    existingTeachers: [{ id: "TEA-CROSS", name: "Canonical Teacher", teacherSourceRefs: refs }],
  });

  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].matchMethod, "source_reference");
  assert.equal(plan.teachers[0].id, "TEA-CROSS");
  assert.equal(plan.teachers[0].name, "Canonical Teacher");
  assert.deepEqual(plan.teachers[0].subjects, ["IB", "Engineering"]);
  assert.deepEqual(plan.teachers[0].departments, ["中小学", "大学"]);
  assert.deepEqual(plan.teachers[0].sourceCategories, ["IB", "Engineering"]);
  assert.deepEqual(plan.teachers[0].teacherSourceRefs, refs);
  assert.equal(plan.teachers[0].subjectDetail, "IB Physics；Mechanics");
  assert.equal(plan.teachers[0].availabilitySourceText, "周二晚；周六上午");
  assert.equal(plan.teachers[0].capacitySourceText, "需确认");
  assert.equal(plan.issues.some((issue) => issue.code === "cross_workbook_name_ambiguous"), false);
});

test("stable refs also merge when the two workbooks use different display names", () => {
  const refs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 8 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 9 },
  ];
  const plan = buildTeacherImportPlan({
    workbooks: [
      workbook({ rosterRows: [{ workbook: "k12", sourceRow: 8, name: "Roster Name A" }] }),
      workbook({
        workbook: "university",
        sourceId: "fixture-university",
        sheetNames: TEACHER_WORKBOOK_SHEETS.university,
        rosterRows: [{ workbook: "university", sourceRow: 9, name: "Roster Name B" }],
      }),
    ],
    existingTeachers: [{ id: "TEA-CROSS", name: "Canonical Teacher", teacherSourceRefs: refs }],
  });

  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.summary.blocked, 0);
});

test("university full-width parenthesis sheet uses one canonical identity", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      workbook: "university",
      sourceId: "fixture-university",
      sheetNames: TEACHER_WORKBOOK_SHEETS.university,
      rosterRows: [{ workbook: "university", sourceRow: 4, name: "Humanities Teacher" }],
      subjectRows: [{ workbook: "university", sheetName: "文科（含论文辅导）", sourceRow: 14, name: "Humanities Teacher" }],
    })],
  });

  assert.deepEqual(plan.teachers[0].subjects, ["文科（含论文辅导）"]);
  assert.equal(plan.issues.some((issue) => issue.code === "missing_expected_sheet" || issue.code === "unknown_subject_sheet"), false);
});

test("sheet drift and orphan subject rows are visible without importing invented categories", () => {
  const sheetNames = [...TEACHER_WORKBOOK_SHEETS.k12];
  [sheetNames[1], sheetNames[2]] = [sheetNames[2], sheetNames[1]];
  sheetNames.splice(sheetNames.indexOf("IB"), 1);
  sheetNames.push("临时自由分类");
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      sheetNames,
      rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Roster Teacher" }],
      subjectRows: [
        { workbook: "k12", sheetName: "IB", sourceRow: 2, name: "Roster Teacher" },
        { workbook: "k12", sheetName: "HSC", sourceRow: 3, name: "Unknown Teacher" },
        { workbook: "k12", sheetName: "临时自由分类", sourceRow: 4, name: "Roster Teacher" },
      ],
    })],
  });

  const codes = new Set(plan.issues.map((issue) => issue.code));
  assert.equal(codes.has("missing_expected_sheet"), true);
  assert.equal(codes.has("unknown_subject_sheet"), true);
  assert.equal(codes.has("sheet_order_mismatch"), true);
  assert.equal(codes.has("subject_teacher_not_in_roster"), true);
  assert.deepEqual(plan.teachers[0].subjects, []);
});

test("source attributes cannot invent capacity or AVA windows, while existing confirmations survive", () => {
  const existingWindow = [{ id: "confirmed-window", validFrom: "2026-09-01", validTo: "2026-09-30" }];
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{
      workbook: "k12",
      sourceRow: 14,
      name: "Confirmed Teacher",
      availabilityText: "旧表写着周末",
      capacityText: "大概还能接人",
      attributes: { availabilityWindows: [{ id: "invented" }], newStudentCapacity: 99, acceptsStudents: false },
    }] })],
    existingTeachers: [{
      id: "TEA-CONFIRMED",
      name: "Confirmed Teacher",
      availability: "本月已确认",
      availabilityStatus: "可接新生",
      availabilityWindows: existingWindow,
      newStudentCapacity: 2,
      acceptsStudents: true,
    }],
  });

  assert.equal(plan.teachers[0].availability, "本月已确认");
  assert.equal(plan.teachers[0].availabilityStatus, "可接新生");
  assert.deepEqual(plan.teachers[0].availabilityWindows, existingWindow);
  assert.equal(plan.teachers[0].newStudentCapacity, 2);
  assert.equal(plan.teachers[0].acceptsStudents, true);
  assert.equal(plan.teachers[0].availabilitySourceText, "旧表写着周末");
  assert.equal(plan.teachers[0].capacitySourceText, "大概还能接人");
});

test("a newer source revision replaces stale source text without promoting it to operational AVA", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{
      workbook: "k12",
      sourceRow: 15,
      name: "Revision Teacher",
      availabilityText: "周三晚上",
      capacityText: "可接一人",
    }] })],
    existingTeachers: [{
      id: "TEA-REVISION",
      name: "Revision Teacher",
      availabilitySourceText: "周二晚上",
      capacitySourceText: "暂不接新生",
    }],
  });

  assert.equal(plan.teachers[0].availabilitySourceText, "周三晚上");
  assert.equal(plan.teachers[0].capacitySourceText, "可接一人");
  assert.equal(plan.teachers[0].availability, "待老师按月提交");
  assert.equal(plan.teachers[0].availabilityStatus, "待确认");
});

test("multiple existing name matches and duplicate stable refs are blocked", () => {
  const ref = { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 };
  const ambiguousName = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Ambiguous Existing" }] })],
    existingTeachers: [
      { id: "TEA-1", name: "Ambiguous Existing" },
      { id: "TEA-2", name: "ambiguous existing" },
    ],
  });
  assert.equal(ambiguousName.summary.blocked, 1);
  assert.equal(ambiguousName.issues[0].code, "existing_name_ambiguous");

  const duplicateRef = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 2, name: "Reference Collision" }] })],
    existingTeachers: [
      { id: "TEA-A", name: "One", teacherSourceRefs: [ref] },
      { id: "TEA-B", name: "Two", teacherSourceRefs: [ref] },
    ],
  });
  assert.equal(duplicateRef.summary.blocked, 1);
  assert.equal(duplicateRef.issues[0].code, "duplicate_source_reference");
});

test("a revision-bound explicit identity link merges exactly one row from each workbook", () => {
  const k12 = workbook({
    sourceId: "fixture-k12",
    revision: "k12-r1",
    rosterRows: [{ workbook: "k12", sourceRow: 2, name: "Shared Teacher" }],
  });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
    rosterRows: [{ workbook: "university", sourceRow: 4, name: "Shared Teacher" }],
  });
  const sourceRefs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 4 },
  ];
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const blocked = buildTeacherImportPlan({ workbooks: [k12, university] });
  assert.equal(blocked.identityResolutions.length, 1);
  assert.equal(blocked.identityResolutions[0].resolutionKey, teacherIdentityResolutionKey({ sourceRefs, sourceRevisions }));

  const linked = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [{
      resolutionKey: blocked.identityResolutions[0].resolutionKey,
      decision: "merge",
      sourceRefs,
      sourceRevisions,
    }],
  });
  assert.equal(linked.summary.blocked, 0);
  assert.equal(linked.teachers.length, 1);
  assert.equal(linked.teachers[0].teacherSourceRefs.length, 2);
  assert.equal(linked.actions[0].matchMethod, "identity_link");
  assert.equal(linked.issues.some((issue) => issue.code === "cross_workbook_name_ambiguous"), false);
});

test("identity links cannot bypass same-workbook duplicates or survive a revision change", () => {
  const k12 = workbook({
    revision: "k12-r1",
    rosterRows: [
      { workbook: "k12", sourceRow: 2, name: "Shared Teacher" },
      { workbook: "k12", sourceRow: 3, name: "Shared Teacher" },
    ],
  });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
    rosterRows: [{ workbook: "university", sourceRow: 4, name: "Shared Teacher" }],
  });
  const sourceRefs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 4 },
  ];
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const link = { resolutionKey: teacherIdentityResolutionKey({ sourceRefs, sourceRevisions }), decision: "merge" as const, sourceRefs, sourceRevisions };
  const duplicate = buildTeacherImportPlan({ workbooks: [k12, university], identityLinks: [link] });
  assert.equal(duplicate.issues.some((issue) => issue.code === "identity_link_invalid"), true);
  assert.equal(duplicate.issues.some((issue) => issue.code === "duplicate_roster_name"), true);

  const changedRevision = buildTeacherImportPlan({
    workbooks: [{ ...k12, revision: "k12-r2", rosterRows: [k12.rosterRows[0]] }, university],
    identityLinks: [link],
  });
  assert.equal(changedRevision.issues.some((issue) => issue.code === "identity_link_invalid"), false);
  assert.equal(changedRevision.identityResolutions.length, 1);
  assert.ok(changedRevision.summary.blocked > 0);
});

test("historical identity links are ignored and a current revision can be confirmed independently", () => {
  const sourceRefs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 4 },
  ];
  const historicalRevisions = { k12: "k12-r1", university: "university-r1" };
  const historical = {
    resolutionKey: teacherIdentityResolutionKey({ sourceRefs, sourceRevisions: historicalRevisions }),
    decision: "merge" as const,
    sourceRefs,
    sourceRevisions: historicalRevisions,
  };
  const k12 = workbook({ revision: "k12-r2", rosterRows: [{ workbook: "k12", sourceRow: 2, name: "Shared Teacher" }] });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r2",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
    rosterRows: [{ workbook: "university", sourceRow: 4, name: "Shared Teacher" }],
  });
  const pending = buildTeacherImportPlan({ workbooks: [k12, university], identityLinks: [historical] });
  assert.equal(pending.issues.some((issue) => issue.code === "identity_link_invalid"), false);
  assert.equal(pending.identityResolutions.length, 1);

  const currentRevisions = { k12: "k12-r2", university: "university-r2" };
  const current = {
    resolutionKey: teacherIdentityResolutionKey({ sourceRefs, sourceRevisions: currentRevisions }),
    decision: "merge" as const,
    sourceRefs,
    sourceRevisions: currentRevisions,
  };
  const resolved = buildTeacherImportPlan({ workbooks: [k12, university], identityLinks: [historical, current] });
  assert.equal(resolved.summary.blocked, 0);
  assert.equal(resolved.teachers.length, 1);
});

test("an explicit separate decision creates two stable records and preserves distinct existing source owners", () => {
  const k12 = workbook({ revision: "k12-r1", rosterRows: [{ workbook: "k12", sourceRow: 2, name: "Shared Teacher" }] });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
    rosterRows: [{ workbook: "university", sourceRow: 4, name: "Shared Teacher" }],
  });
  const sourceRefs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 4 },
  ];
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const link = {
    resolutionKey: teacherIdentityResolutionKey({ sourceRefs, sourceRevisions }),
    decision: "separate" as const,
    sourceRefs,
    sourceRevisions,
  };
  const inserted = buildTeacherImportPlan({ workbooks: [k12, university], identityLinks: [link] });
  assert.equal(inserted.summary.blocked, 0);
  assert.equal(inserted.teachers.length, 2);
  assert.ok(inserted.actions.every((action) => action.matchMethod === "identity_separate"));

  const existing = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [link],
    existingTeachers: [
      { id: "TEA-K12", name: "Shared Teacher", teacherSourceRefs: [sourceRefs[0]] },
      { id: "TEA-UNI", name: "Shared Teacher", teacherSourceRefs: [sourceRefs[1]] },
    ],
  });
  assert.equal(existing.summary.blocked, 0);
  assert.deepEqual(existing.teachers.map((teacher) => teacher.id).sort(), ["TEA-K12", "TEA-UNI"]);

  const unresolvedLegacy = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [link],
    existingTeachers: [{ id: "TEA-LEGACY", name: "Shared Teacher" }],
  });
  assert.ok(unresolvedLegacy.summary.blocked > 0);
  assert.equal(unresolvedLegacy.issues.some((issue) => issue.code === "identity_link_existing_conflict"), true);

  const alreadyMerged = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [link],
    existingTeachers: [{ id: "TEA-MERGED", name: "Shared Teacher", teacherSourceRefs: sourceRefs }],
  });
  assert.ok(alreadyMerged.summary.blocked > 0);
  assert.equal(alreadyMerged.issues.some((issue) => issue.code === "identity_link_existing_conflict"), true);
});

test("same-workbook duplicate rows expose revision-bound merge/separate choices", () => {
  const k12 = workbook({
    revision: "k12-r1",
    rosterRows: [
      { workbook: "k12", sourceRow: 2, name: "Duplicate Teacher" },
      { workbook: "k12", sourceRow: 3, name: "duplicate teacher" },
    ],
  });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
  });
  const sourceRefs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 },
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 3 },
  ];
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const blocked = buildTeacherImportPlan({ workbooks: [k12, university] });
  const candidate = blocked.identityResolutions.find((resolution) => resolution.kind === "same_workbook_identity");
  assert.ok(candidate);
  assert.equal(candidate.resolutionKey, teacherSameWorkbookResolutionKey({ sourceRefs, sourceRevisions }));
  const mergeKey = teacherSameWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "merge" });
  const separateKey = teacherSameWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "separate" });
  assert.equal(mergeKey, "sha256:1d3a46fd4b218aa83738a732628cfd57fdba8dc5045c8537cf2b92d7103b1c67");
  assert.deepEqual(candidate.options.map((option) => option.resolutionKey), [separateKey, mergeKey]);

  const merged = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{ kind: "same_workbook_identity", resolutionKey: mergeKey, decision: "merge", sourceRefs, sourceRevisions }],
  });
  assert.equal(merged.summary.blocked, 0);
  assert.equal(merged.teachers.length, 1);

  const separate = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{ kind: "same_workbook_identity", resolutionKey: separateKey, decision: "separate", sourceRefs, sourceRevisions }],
  });
  assert.equal(separate.summary.blocked, 0);
  assert.equal(separate.teachers.length, 2);
});

test("mixed 1+N duplicate groups expose one V2 cross-workbook partition choice", () => {
  const k12 = workbook({
    revision: "k12-r1",
    rosterRows: [{ workbook: "k12", sourceRow: 2, name: "Complex Teacher" }],
  });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
    rosterRows: [
      { workbook: "university", sourceRow: 30, name: "Complex Teacher" },
      { workbook: "university", sourceRow: 71, name: "complex teacher" },
    ],
  });
  const sourceRefs = [
    { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 2 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 30 },
    { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 71 },
  ];
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const blocked = buildTeacherImportPlan({ workbooks: [k12, university] });
  const candidates = blocked.identityResolutions.filter((resolution) => resolution.name === "Complex Teacher");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "cross_workbook_identity");
  assert.equal(candidates[0].persistenceContract, "teacher_hard_resolution_v2");
  const mergeKey = teacherCrossWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "merge" });
  const separateKey = teacherCrossWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "separate" });
  assert.equal(separateKey, "sha256:cbe8d81ca7a47e98f14a30cb5e799f042371d72d6db5e0462f46c92364a8e328");
  assert.equal(candidates[0].options.find((option) => option.decision === "merge")?.resolutionKey, mergeKey);

  const merged = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{
      kind: "cross_workbook_identity",
      resolutionKey: mergeKey,
      decision: "merge",
      sourceRefs,
      sourceRevisions,
    }],
  });
  assert.equal(merged.summary.blocked, 0);
  assert.equal(merged.teachers.length, 1);
});

test("NFKC-only and zero-width cross-workbook pairs stay on the opaque V2 contract", () => {
  const k12 = workbook({
    revision: "k12-r1",
    rosterRows: [
      { workbook: "k12", sourceRow: 101, name: "Ｗｉｄｔｈ Teacher" },
      { workbook: "k12", sourceRow: 102, name: "Zero\u200BWidth Teacher" },
    ],
  });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
    rosterRows: [
      { workbook: "university", sourceRow: 201, name: "Width Teacher" },
      { workbook: "university", sourceRow: 202, name: "ZeroWidth Teacher" },
    ],
  });
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const plan = buildTeacherImportPlan({ workbooks: [k12, university] });
  const candidates = plan.identityResolutions
    .filter((resolution) => resolution.kind === "cross_workbook_identity")
    .sort((left, right) => Number(left.sourceRefs[0]?.sourceRow) - Number(right.sourceRefs[0]?.sourceRow));
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.persistenceContract === "teacher_hard_resolution_v2"));

  const expected = [
    {
      refs: [
        { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 101 },
        { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 201 },
      ],
      separate: "sha256:bfbc3e5b70c4e35ee6a87cab1a5530722d36bc519c0df1497ddca92badcb303d",
      merge: "sha256:c2b46c06370631eaa84f87085cc1407e6a7384cadbdb2bdf4bdf6faf95245ec6",
    },
    {
      refs: [
        { workbook: "k12" as const, sourceId: "fixture-k12", sourceRow: 102 },
        { workbook: "university" as const, sourceId: "fixture-university", sourceRow: 202 },
      ],
      separate: "sha256:1390b9b37ec5e3c3bba8ec4b59915c92ecb2ae5c104c2f1f77bd47a1b381ad4a",
      merge: "sha256:5a8bdd161a397c3f996bb2c57749a230fb4671e3e374dd607e03269ea10a1912",
    },
  ];
  for (const [index, fixture] of expected.entries()) {
    const candidate = candidates[index];
    assert.deepEqual(candidate.sourceRefs, fixture.refs);
    assert.equal(
      teacherCrossWorkbookDecisionKey({
        sourceRefs: fixture.refs,
        sourceRevisions,
        decision: "separate",
      }),
      fixture.separate,
    );
    assert.equal(
      teacherCrossWorkbookDecisionKey({
        sourceRefs: fixture.refs,
        sourceRevisions,
        decision: "merge",
      }),
      fixture.merge,
    );
    assert.deepEqual(candidate.options.map((option) => option.resolutionKey), [fixture.separate, fixture.merge]);
  }
});

test("subject rows offer only current roster assignments or explicit ignore", () => {
  const k12 = workbook({
    revision: "k12-r1",
    rosterRows: [
      { workbook: "k12", sourceRow: 2, name: "Possible One" },
      { workbook: "k12", sourceRow: 3, name: "Possible Two" },
    ],
    subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 20, name: "Legacy Alias", subjectDetail: "Physics" }],
  });
  const university = workbook({
    workbook: "university",
    sourceId: "fixture-university",
    revision: "university-r1",
    sheetNames: TEACHER_WORKBOOK_SHEETS.university,
  });
  const sourceRevisions = { k12: "k12-r1", university: "university-r1" };
  const pending = buildTeacherImportPlan({ workbooks: [k12, university] });
  const candidate = pending.subjectResolutions[0];
  assert.ok(candidate);
  assert.equal(candidate.options.length, 3);
  assert.deepEqual(new Set(candidate.options.map((option) => option.decision)), new Set(["assign", "ignore"]));

  const assignment = candidate.options.find((option) => option.decision === "assign" && option.rosterRef?.sourceRow === 3);
  assert.ok(assignment?.rosterRef);
  assert.equal(assignment.resolutionKey, teacherSubjectResolutionKey({
    subjectRef: candidate.subjectRef,
    rosterRef: assignment.rosterRef,
    decision: "assign",
    sourceRevisions,
  }));
  assert.equal(assignment.resolutionKey, "sha256:3b62fca49e69afceb26cef4779c94679433c0a4c91760f9bf03cc282f30be214");
  const assigned = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{
      kind: "subject_assignment",
      resolutionKey: assignment.resolutionKey,
      decision: "assign",
      sourceRevisions,
      subjectRef: candidate.subjectRef,
      rosterRef: assignment.rosterRef,
    }],
  });
  assert.equal(assigned.subjectResolutions.length, 0);
  assert.deepEqual(assigned.teachers.find((teacher) => teacher.teacherSourceRefs[0]?.sourceRow === 3)?.subjects, ["IB"]);

  const ignore = candidate.options.find((option) => option.decision === "ignore");
  assert.ok(ignore);
  assert.equal(ignore.resolutionKey, "sha256:cd624be68238fec52227362399eed001d2d0b6e463bdff0f966de6ca177d2eac");
  const ignored = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{ kind: "subject_assignment", resolutionKey: ignore.resolutionKey, decision: "ignore", sourceRevisions, subjectRef: candidate.subjectRef }],
  });
  assert.equal(ignored.subjectResolutions.length, 0);
  assert.equal(ignored.issues.some((issue) => issue.code === "subject_row_ignored"), true);
});

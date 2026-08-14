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
  teacherIdForAuthorityName,
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

test("name normalization folds ASCII case only after deterministic NFKC cleanup", () => {
  assert.equal(normalizeTeacherImportName("ASCII Teacher"), "ascii teacher");
  assert.equal(normalizeTeacherImportName("ascii teacher"), "ascii teacher");
  assert.equal(normalizeTeacherImportName("OﬃCE ＆ MATH"), "office & math");
  assert.equal(normalizeTeacherImportName("office & math"), "office & math");
  assert.equal(normalizeTeacherImportName("ÉLODIE"), "Élodie");
  assert.equal(normalizeTeacherImportName("İSTANBUL"), "İstanbul");
  assert.equal(normalizeTeacherImportName("ΑΘΗΝΑ"), "ΑΘΗΝΑ");

  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: 1, name: "ASCII Teacher" },
        { workbook: "k12", sourceRow: 2, name: "ascii teacher" },
        { workbook: "k12", sourceRow: 3, name: "OﬃCE ＆ MATH" },
        { workbook: "k12", sourceRow: 4, name: "office & math" },
      ],
    })],
  });
  assert.equal(plan.summary.blocked, 0);
  assert.equal(plan.teachers.length, 2);
  assert.ok(plan.teachers.every((teacher) => teacher.teacherSourceRefs.length === 2));
});

test("operational annotations remain distinct exact names and never fuzzy-merge", () => {
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
    ["Lauren Johnston(已弱化)", []],
    ["Lauren Johnston", ["IB"]],
    ["Janice Jiang", []],
    ["Janice Jiang已弱化", ["AEAS"]],
    ["Jenny Liang (已弱化)", []],
    ["Jenny Liang(弱化)", ["Maths&Science"]],
  ].sort());
  assert.equal(plan.issues.some((issue) => issue.code === "subject_teacher_not_in_roster"), false);
});

test("parenthesized nicknames never fuzzy-merge even when source text mentions the nickname", () => {
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
  assert.equal(confirmed.teachers.length, 2);
  assert.deepEqual(confirmed.teachers.find((teacher) => teacher.name === "Areejz Slamang")?.subjects, []);
  assert.deepEqual(confirmed.teachers.find((teacher) => teacher.name === "Areejz Slamang(Ree)")?.subjects, ["HSC"]);
  assert.equal(confirmed.issues.some((issue) => issue.code === "subject_teacher_not_in_roster"), false);

  const unconfirmed = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Areejz Slamang" }],
      subjectRows: [{ workbook: "k12", sheetName: "HSC", sourceRow: 11, name: "Areejz Slamang(Ree)" }],
    })],
  });
  assert.equal(unconfirmed.teachers.length, 2);
  assert.deepEqual(unconfirmed.teachers.find((teacher) => teacher.name === "Areejz Slamang(Ree)")?.subjects, ["HSC"]);
  assert.equal(unconfirmed.issues.some((issue) => issue.code === "subject_teacher_not_in_roster"), false);
});

test("different operationally similar names stay distinct while the exact subject name becomes authoritative", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: 1, name: "Duplicate Teacher(弱化)" },
        { workbook: "k12", sourceRow: 2, name: "Duplicate Teacher(已弱化)" },
      ],
      subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 11, name: "Duplicate Teacher" }],
    })],
  });

  assert.equal(plan.issues.some((issue) => issue.code === "subject_name_ambiguous"), false);
  assert.equal(plan.teachers.length, 3);
  assert.deepEqual(plan.teachers.find((teacher) => teacher.name === "Duplicate Teacher")?.subjects, ["IB"]);
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

test("active existing operational fields follow the SQL-mirror golden contract", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [
      workbook({
        sourceId: "fixture-k12",
        rosterRows: [{
          workbook: "k12",
          sourceRow: 4,
          name: "Golden Teacher",
          availabilityText: " First　AVA ",
          capacityText: " One ",
          attributes: { location: "NSW", acceptsStudents: false, capacity: 999 },
        }],
      }),
      workbook({
        workbook: "university",
        sourceId: "fixture-university",
        sheetNames: TEACHER_WORKBOOK_SHEETS.university,
        rosterRows: [{
          workbook: "university",
          sourceRow: 5,
          name: "golden teacher",
          availabilityText: "First AVA",
          capacityText: "Two",
          attributes: { location: "VIC", availabilityStatus: "暂停接新", load: 999 },
        }],
      }),
    ],
    existingTeachers: [{
      id: "TEA-GOLDEN",
      name: "GOLDEN Teacher",
      initials: " ｇｔ ",
      availability: "  Reviewed；AVA  ",
      availabilityStatus: "可接新生",
      load: 2.5,
      capacity: 7,
      acceptsStudents: true,
      note: " Reviewed　note ",
      location: " WA ",
      timezone: " Australia/Perth ",
      availabilitySourceText: "stale AVA",
      capacitySourceText: "stale capacity",
      availabilityWindows: [{ id: "reviewed-window" }],
      payrollHistory: { invoice: "INV-GOLDEN" },
    }],
  });
  const teacher = plan.teachers.find((item) => item.id === "TEA-GOLDEN");
  assert.ok(teacher);
  assert.deepEqual(Object.fromEntries([
    "name", "initials", "availability", "availabilityStatus", "load", "capacity",
    "acceptsStudents", "note", "location", "timezone", "availabilitySourceText", "capacitySourceText",
  ].map((field) => [field, teacher[field]])), {
    name: "GOLDEN Teacher",
    initials: "gt",
    availability: "  Reviewed；AVA  ",
    availabilityStatus: "可接新生",
    load: 2.5,
    capacity: 7,
    acceptsStudents: true,
    note: "Reviewed note",
    location: "WA",
    timezone: "Australia/Perth",
    availabilitySourceText: "First AVA",
    capacitySourceText: "One；Two",
  });
  assert.deepEqual(teacher.availabilityWindows, [{ id: "reviewed-window" }]);
  assert.deepEqual(teacher.payrollHistory, { invoice: "INV-GOLDEN" });
});

test("active new operational fields ignore source tampering and omit absent optional keys", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{
        workbook: "k12",
        sourceRow: 6,
        name: "New Teacher",
        availabilityText: "　 ",
        capacityText: "",
        attributes: {
          location: "VIC",
          initials: "EVIL",
          availability: "invented",
          availabilityStatus: "可接新生",
          load: 999,
          capacity: 999,
          acceptsStudents: true,
          note: "invented",
          timezone: "Pacific/Auckland",
          availabilitySourceText: "invented",
          capacitySourceText: "invented",
        },
      }],
    })],
  });
  const teacher = plan.teachers[0];
  assert.deepEqual(Object.fromEntries([
    "name", "initials", "availability", "availabilityStatus", "load", "capacity",
    "acceptsStudents", "note", "location", "timezone",
  ].map((field) => [field, teacher[field]])), {
    name: "New Teacher",
    initials: "NT",
    availability: "待老师按月提交",
    availabilityStatus: "待确认",
    load: 0,
    capacity: 0,
    acceptsStudents: false,
    note: "待教务审核教师资料与月度 AVA",
    location: "VIC",
    timezone: "Australia/Melbourne",
  });
  assert.equal("availabilitySourceText" in teacher, false);
  assert.equal("capacitySourceText" in teacher, false);

  const stale = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 7, name: "Stale Source Text" }] })],
    existingTeachers: [{
      id: "TEA-STALE-SOURCE",
      name: "Stale Source Text",
      availabilitySourceText: "old AVA",
      capacitySourceText: "old capacity",
      location: "   ",
    }],
  }).teachers[0];
  assert.equal("availabilitySourceText" in stale, false);
  assert.equal("capacitySourceText" in stale, false);
  assert.equal("location" in stale, false);
});

test("active source ordering uses UTF-8 byte order rather than host locale", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: "ä", name: "ORDER TEACHER", availabilityText: "umlaut row" },
        { workbook: "k12", sourceRow: "z", name: "Order Teacher", availabilityText: "ascii row" },
      ],
    })],
  });
  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.teachers[0].name, "Order Teacher");
  assert.equal(plan.teachers[0].availabilitySourceText, "ascii row；umlaut row");
  assert.deepEqual(plan.teachers[0].teacherSourceRefs, [
    { workbook: "k12", sourceId: "fixture-k12", sourceRow: "z" },
    { workbook: "k12", sourceId: "fixture-k12", sourceRow: "ä" },
  ]);
});

test("teachers absent from the authority keep their ID and history but lose stale teaching claims", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 4, name: "Imported Teacher" }] })],
    existingTeachers: [{
      id: "TEA-MANUAL",
      name: "Manual Teacher",
      subjects: ["IB"],
      departments: ["中小学", "大学"],
      sourceCategories: ["IB"],
      subjectDetail: "stale physics",
      availabilityStatus: "可接新生",
      acceptsStudents: true,
      availabilityWindows: [{ id: "historical-window", start: "2026-01-01T00:00:00Z" }],
      teacherSourceRefs: [
        { workbook: "k12", sourceId: "fixture-k12", sourceRow: 99 },
        { workbook: "k12", sourceId: "fixture-k12#subjects", sourceRow: "name:old" },
        { workbook: "k12", sourceId: "historical-k12", sourceRow: 8 },
      ],
    }],
  });
  const preserved = plan.teachers.find((teacher) => teacher.id === "TEA-MANUAL");
  assert.ok(preserved);
  assert.equal(preserved.timezone, "Australia/Melbourne");
  assert.equal(preserved.acceptsStudents, false);
  assert.equal(preserved.availabilityStatus, "暂停接新");
  assert.deepEqual(preserved.subjects, []);
  assert.deepEqual(preserved.departments, []);
  assert.deepEqual(preserved.sourceCategories, []);
  assert.equal("subjectDetail" in preserved, false);
  assert.deepEqual(preserved.availabilityWindows, [{ id: "historical-window", start: "2026-01-01T00:00:00Z" }]);
  assert.deepEqual(preserved.teacherSourceRefs, [
    { workbook: "k12", sourceId: "historical-k12", sourceRow: 8 },
  ]);
  assert.equal(plan.actions.find((action) => action.teacherId === "TEA-MANUAL")?.matchMethod, "preserved_existing");
});

test("historical projection cleans reviewed optional source fields and removes blank or null keys", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Current Teacher" }] })],
    existingTeachers: [
      {
        id: "TEA-HISTORICAL-REVIEWED",
        name: "Historical Reviewed",
        location: " VIC ",
        availabilitySourceText: " Reviewed　AVA ",
        capacitySourceText: " Reviewed　capacity ",
        availabilityWindows: [{ id: "reviewed-history" }],
        payrollHistory: { invoice: "INV-REVIEWED" },
      },
      {
        id: "TEA-HISTORICAL-BLANK",
        name: "Historical Blank",
        location: "\u200B",
        availabilitySourceText: "　",
        capacitySourceText: null,
        subjectDetail: "stale detail",
      },
    ],
  });
  const reviewed = plan.teachers.find((teacher) => teacher.id === "TEA-HISTORICAL-REVIEWED");
  assert.ok(reviewed);
  assert.equal(reviewed.location, "VIC");
  assert.equal(reviewed.availabilitySourceText, "Reviewed AVA");
  assert.equal(reviewed.capacitySourceText, "Reviewed capacity");
  assert.deepEqual(reviewed.availabilityWindows, [{ id: "reviewed-history" }]);
  assert.deepEqual(reviewed.payrollHistory, { invoice: "INV-REVIEWED" });

  const blank = plan.teachers.find((teacher) => teacher.id === "TEA-HISTORICAL-BLANK");
  assert.ok(blank);
  assert.equal("location" in blank, false);
  assert.equal("availabilitySourceText" in blank, false);
  assert.equal("capacitySourceText" in blank, false);
  assert.equal("subjectDetail" in blank, false);
});

test("a different name can reuse a source row directly while the prior teacher history is preserved", () => {
  const revision1Source = workbook({
    revision: "direct-r1",
    rosterRows: [{ workbook: "k12", sourceRow: 7, name: "Direct Alice" }],
    subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 70, name: "Direct Alice", subjectDetail: "Physics" }],
  });
  const revision1 = buildTeacherImportPlan({ workbooks: [revision1Source] });
  const aliceId = teacherIdForAuthorityName("Direct Alice");
  const committedAlice = {
    ...revision1.teachers[0],
    acceptsStudents: true,
    payrollHistory: { retainedInvoice: "INV-DIRECT-A" },
  };

  const revision2Source = workbook({
    revision: "direct-r2",
    rosterRows: [{ workbook: "k12", sourceRow: 7, name: "Direct Bob" }],
  });
  const revision2 = buildTeacherImportPlan({
    workbooks: [revision2Source],
    existingTeachers: [committedAlice],
  });
  const bobId = teacherIdForAuthorityName("Direct Bob");
  assert.equal(revision2.summary.blocked, 0);
  assert.notEqual(aliceId, bobId);
  const alice = revision2.teachers.find((teacher) => teacher.id === aliceId);
  const bob = revision2.teachers.find((teacher) => teacher.id === bobId);
  assert.equal(alice?.name, "Direct Alice");
  assert.equal(alice?.acceptsStudents, false);
  assert.deepEqual(alice?.subjects, []);
  assert.deepEqual(alice?.sourceCategories, []);
  assert.deepEqual(alice?.teacherSourceRefs, []);
  assert.equal(alice && "subjectDetail" in alice, false);
  assert.deepEqual(alice?.payrollHistory, { retainedInvoice: "INV-DIRECT-A" });
  assert.equal(bob?.name, "Direct Bob");
  assert.deepEqual(bob?.teacherSourceRefs, [{ workbook: "k12", sourceId: "fixture-k12", sourceRow: 7 }]);

  const replay = buildTeacherImportPlan({
    workbooks: [revision2Source],
    existingTeachers: revision2.teachers,
  });
  assert.equal(replay.summary.blocked, 0);
  assert.equal(replay.summary.unchanged, 2);
  assert.deepEqual(replay.teachers, revision2.teachers);
});

test("authoritative name IDs use exact normalized UTF-8 bytes and ignore source placement", () => {
  const expectedId = "TEA-TX-A-ed62142be3bc6f1f3c19457d0d78fee6210f3e287cd6df153c4ea5b131f98b68";
  assert.equal(normalizeTeacherImportName(" Ｎi，：老师 "), "ni,:老师");
  assert.equal(teacherIdForAuthorityName(" Ｎi，：老师 "), expectedId);
  assert.equal(teacherIdForAuthorityName("ni,:老师"), expectedId);

  const rosterPlan = buildTeacherImportPlan({
    workbooks: [workbook({
      sourceId: "来源-一",
      rosterRows: [{ workbook: "k12", sourceRow: 7, name: " Ｎi，：老师 " }],
    })],
  });
  const movedPlan = buildTeacherImportPlan({
    workbooks: [workbook({
      sourceId: "来源-二",
      rosterRows: [{ workbook: "k12", sourceRow: 900, name: "ni,:老师" }],
    })],
  });
  assert.equal(rosterPlan.teachers[0].id, expectedId);
  assert.equal(movedPlan.teachers[0].id, expectedId);
});

test("three revisions preserve an absent teacher when a different name later reuses the source row", () => {
  const revision1 = buildTeacherImportPlan({
    workbooks: [workbook({
      revision: "r1",
      rosterRows: [{ workbook: "k12", sourceRow: 7, name: "Lifecycle Teacher A" }],
    })],
  });
  const teacherAId = teacherIdForAuthorityName("Lifecycle Teacher A");
  assert.equal(revision1.teachers[0].id, teacherAId);
  const committedTeacherA = {
    ...revision1.teachers[0],
    acceptsStudents: true,
    payrollHistory: { retainedInvoice: "INV-A" },
  };

  const revision2 = buildTeacherImportPlan({
    workbooks: [workbook({ revision: "r2", rosterRows: [] })],
    existingTeachers: [committedTeacherA],
  });
  const absentTeacherA = revision2.teachers.find((teacher) => teacher.id === teacherAId);
  assert.ok(absentTeacherA);
  assert.equal(absentTeacherA.name, "Lifecycle Teacher A");
  assert.equal(absentTeacherA.acceptsStudents, false);
  assert.deepEqual(absentTeacherA.teacherSourceRefs, []);
  assert.deepEqual(absentTeacherA.payrollHistory, { retainedInvoice: "INV-A" });

  const revision3Source = workbook({
    revision: "r3",
    rosterRows: [{ workbook: "k12", sourceRow: 7, name: "Lifecycle Teacher B" }],
  });
  const revision3 = buildTeacherImportPlan({
    workbooks: [revision3Source],
    existingTeachers: revision2.teachers,
  });
  const teacherBId = teacherIdForAuthorityName("Lifecycle Teacher B");
  assert.equal(revision3.summary.blocked, 0);
  assert.notEqual(teacherAId, teacherBId);
  assert.deepEqual(revision3.teachers.map((teacher) => [teacher.name, teacher.id]), [
    ["Lifecycle Teacher A", teacherAId],
    ["Lifecycle Teacher B", teacherBId],
  ]);
  const retainedTeacherA = revision3.teachers.find((teacher) => teacher.id === teacherAId);
  assert.equal(retainedTeacherA?.acceptsStudents, false);
  assert.deepEqual(retainedTeacherA?.teacherSourceRefs, []);
  assert.deepEqual(retainedTeacherA?.payrollHistory, { retainedInvoice: "INV-A" });

  const replay = buildTeacherImportPlan({
    workbooks: [revision3Source],
    existingTeachers: revision3.teachers,
  });
  assert.equal(replay.summary.blocked, 0);
  assert.deepEqual(replay.teachers.map((teacher) => [teacher.name, teacher.id]), [
    ["Lifecycle Teacher A", teacherAId],
    ["Lifecycle Teacher B", teacherBId],
  ]);
});

test("an authoritative derived ID occupied by a different exact name fails closed", () => {
  const derivedId = teacherIdForAuthorityName("Collision Target");
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{ workbook: "k12", sourceRow: 31, name: "Collision Target" }],
    })],
    existingTeachers: [{
      id: derivedId,
      name: "Different Historical Teacher",
      payrollHistory: { retainedInvoice: "INV-HISTORICAL" },
    }],
  });

  assert.equal(plan.summary.blocked, 1);
  assert.equal(plan.issues.some((issue) => issue.code === "derived_id_collision"), true);
  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.teachers[0].name, "Different Historical Teacher");
  assert.deepEqual(plan.teachers[0].payrollHistory, { retainedInvoice: "INV-HISTORICAL" });
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

test("same-workbook exact duplicate names automatically form one canonical teacher", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [
        { workbook: "k12", sourceRow: 1, name: "Same Teacher" },
        { workbook: "k12", sourceRow: 2, name: "same teacher" },
      ],
      subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 20, name: "Same Teacher" }],
    })],
  });

  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.summary.blocked, 0);
  assert.deepEqual(plan.teachers[0].subjects, ["IB"]);
  assert.equal(plan.teachers[0].teacherSourceRefs.length, 2);
  assert.deepEqual(plan.identityResolutions, []);
  assert.deepEqual(plan.subjectResolutions, []);
});

test("the same exact normalized name across workbooks is one canonical teacher", () => {
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

  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.summary.blocked, 0);
  assert.deepEqual(plan.teachers[0].departments, ["中小学", "大学"]);
  assert.equal(plan.teachers[0].teacherSourceRefs.length, 2);
  assert.equal(plan.issues.some((issue) => issue.code === "cross_workbook_name_ambiguous"), false);
});

test("an exact-name existing teacher reuses its ID across both workbooks", () => {
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
    existingTeachers: [{ id: "TEA-CROSS", name: "Cross Roster", teacherSourceRefs: refs }],
  });

  assert.equal(plan.teachers.length, 1);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].matchMethod, "source_reference");
  assert.equal(plan.teachers[0].id, "TEA-CROSS");
  assert.equal(plan.teachers[0].name, "Cross Roster");
  assert.deepEqual(plan.teachers[0].subjects, ["IB", "Engineering"]);
  assert.deepEqual(plan.teachers[0].departments, ["中小学", "大学"]);
  assert.deepEqual(plan.teachers[0].sourceCategories, ["IB", "Engineering"]);
  assert.deepEqual(plan.teachers[0].teacherSourceRefs, refs);
  assert.equal(plan.teachers[0].subjectDetail, "IB Physics；Mechanics");
  assert.equal(plan.teachers[0].availabilitySourceText, "周二晚；周六上午");
  assert.equal(plan.teachers[0].capacitySourceText, "需确认");
  assert.equal(plan.issues.some((issue) => issue.code === "cross_workbook_name_ambiguous"), false);
});

test("different exact names stay distinct even when a legacy record claimed both source refs", () => {
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

  assert.equal(plan.summary.blocked, 0);
  assert.equal(plan.teachers.length, 3);
  const historical = plan.teachers.find((teacher) => teacher.id === "TEA-CROSS");
  assert.equal(historical?.acceptsStudents, false);
  assert.deepEqual(historical?.teacherSourceRefs, []);
  assert.ok(plan.teachers.some((teacher) => teacher.name === "Roster Name A"));
  assert.ok(plan.teachers.some((teacher) => teacher.name === "Roster Name B"));
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

test("sheet drift blocks invented categories while exact subject-only names remain authoritative", () => {
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
  assert.equal(codes.has("subject_teacher_not_in_roster"), false);
  assert.deepEqual(plan.teachers[0].subjects, []);
  assert.deepEqual(plan.teachers.find((teacher) => teacher.name === "Unknown Teacher")?.subjects, ["HSC"]);
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

test("multiple exact-name existing IDs fail closed while differently named historical refs are retired", () => {
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
  assert.equal(duplicateRef.summary.blocked, 0);
  assert.equal(duplicateRef.teachers.length, 3);
  assert.deepEqual(duplicateRef.teachers.find((teacher) => teacher.id === "TEA-A")?.teacherSourceRefs, []);
  assert.deepEqual(duplicateRef.teachers.find((teacher) => teacher.id === "TEA-B")?.teacherSourceRefs, []);
  assert.deepEqual(duplicateRef.teachers.find((teacher) => teacher.name === "Reference Collision")?.teacherSourceRefs, [ref]);
});

test("same-name rows merge without an identity link and historical links cannot change the result", () => {
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
  const baseline = buildTeacherImportPlan({ workbooks: [k12, university] });
  assert.equal(baseline.identityResolutions.length, 0);
  assert.equal(baseline.teachers.length, 1);

  const linked = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [{
      resolutionKey: teacherIdentityResolutionKey({ sourceRefs, sourceRevisions }),
      decision: "separate",
      sourceRefs,
      sourceRevisions,
    }],
  });
  assert.equal(linked.summary.blocked, 0);
  assert.equal(linked.teachers.length, 1);
  assert.equal(linked.teachers[0].teacherSourceRefs.length, 2);
  assert.deepEqual(linked.teachers, baseline.teachers);
  assert.equal(linked.issues.some((issue) => issue.code === "cross_workbook_name_ambiguous"), false);
});

test("identity links are inert across duplicate rows and source revision changes", () => {
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
  assert.equal(duplicate.summary.blocked, 0);
  assert.equal(duplicate.teachers.length, 1);
  assert.deepEqual(duplicate.identityResolutions, []);

  const changedRevision = buildTeacherImportPlan({
    workbooks: [{ ...k12, revision: "k12-r2", rosterRows: [k12.rosterRows[0]] }, university],
    identityLinks: [link],
  });
  assert.equal(changedRevision.issues.some((issue) => issue.code === "identity_link_invalid"), false);
  assert.equal(changedRevision.identityResolutions.length, 0);
  assert.equal(changedRevision.summary.blocked, 0);
  assert.equal(changedRevision.teachers.length, 1);
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
  assert.equal(pending.identityResolutions.length, 0);
  assert.equal(pending.teachers.length, 1);

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

test("an explicit separate decision is inert and duplicate exact-name existing IDs still fail closed", () => {
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
  assert.equal(inserted.teachers.length, 1);
  assert.deepEqual(inserted.identityResolutions, []);

  const existing = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [link],
    existingTeachers: [
      { id: "TEA-K12", name: "Shared Teacher", teacherSourceRefs: [sourceRefs[0]] },
      { id: "TEA-UNI", name: "Shared Teacher", teacherSourceRefs: [sourceRefs[1]] },
    ],
  });
  assert.equal(existing.summary.blocked, 2);
  assert.deepEqual(existing.teachers.map((teacher) => teacher.id).sort(), ["TEA-K12", "TEA-UNI"]);

  const unresolvedLegacy = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [link],
    existingTeachers: [{ id: "TEA-LEGACY", name: "Shared Teacher" }],
  });
  assert.equal(unresolvedLegacy.summary.blocked, 0);
  assert.equal(unresolvedLegacy.teachers.length, 1);
  assert.equal(unresolvedLegacy.teachers[0].id, "TEA-LEGACY");

  const alreadyMerged = buildTeacherImportPlan({
    workbooks: [k12, university],
    identityLinks: [link],
    existingTeachers: [{ id: "TEA-MERGED", name: "Shared Teacher", teacherSourceRefs: sourceRefs }],
  });
  assert.equal(alreadyMerged.summary.blocked, 0);
  assert.equal(alreadyMerged.teachers.length, 1);
  assert.equal(alreadyMerged.teachers[0].id, "TEA-MERGED");
});

test("same-workbook duplicate rows auto-merge and hard merge/separate choices are inert", () => {
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
  const baseline = buildTeacherImportPlan({ workbooks: [k12, university] });
  assert.equal(baseline.teachers.length, 1);
  assert.deepEqual(baseline.identityResolutions, []);
  assert.match(teacherSameWorkbookResolutionKey({ sourceRefs, sourceRevisions }), /^sha256:/);
  const mergeKey = teacherSameWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "merge" });
  const separateKey = teacherSameWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "separate" });
  assert.equal(mergeKey, "sha256:1d3a46fd4b218aa83738a732628cfd57fdba8dc5045c8537cf2b92d7103b1c67");

  const merged = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{ kind: "same_workbook_identity", resolutionKey: mergeKey, decision: "merge", sourceRefs, sourceRevisions }],
  });
  assert.equal(merged.summary.blocked, 0);
  assert.equal(merged.teachers.length, 1);
  assert.deepEqual(merged.teachers, baseline.teachers);

  const separate = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{ kind: "same_workbook_identity", resolutionKey: separateKey, decision: "separate", sourceRefs, sourceRevisions }],
  });
  assert.equal(separate.summary.blocked, 0);
  assert.equal(separate.teachers.length, 1);
  assert.deepEqual(separate.teachers, baseline.teachers);
});

test("mixed 1+N exact-name groups auto-merge and V2 partition choices are inert", () => {
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
  const baseline = buildTeacherImportPlan({ workbooks: [k12, university] });
  assert.equal(baseline.teachers.length, 1);
  assert.deepEqual(baseline.identityResolutions, []);
  const mergeKey = teacherCrossWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "merge" });
  const separateKey = teacherCrossWorkbookDecisionKey({ sourceRefs, sourceRevisions, decision: "separate" });
  assert.equal(separateKey, "sha256:cbe8d81ca7a47e98f14a30cb5e799f042371d72d6db5e0462f46c92364a8e328");

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
  assert.deepEqual(merged.teachers, baseline.teachers);
});

test("NFKC-only and zero-width cross-workbook pairs auto-merge without opaque choices", () => {
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
  const plan = buildTeacherImportPlan({ workbooks: [k12, university] });
  assert.equal(plan.teachers.length, 2);
  assert.ok(plan.teachers.every((teacher) => teacher.teacherSourceRefs.length === 2));
  assert.deepEqual(plan.identityResolutions, []);
  assert.equal(normalizeTeacherImportName("Punctuation，："), "punctuation,:");
});

test("a subject-only exact name is authoritative and assign/ignore choices are inert", () => {
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
  const baseline = buildTeacherImportPlan({ workbooks: [k12, university] });
  assert.deepEqual(baseline.subjectResolutions, []);
  assert.equal(baseline.teachers.length, 3);
  const authoritative = baseline.teachers.find((teacher) => teacher.name === "Legacy Alias");
  assert.deepEqual(authoritative?.subjects, ["IB"]);
  assert.equal(authoritative?.subjectDetail, "Physics");

  const ignored = buildTeacherImportPlan({
    workbooks: [k12, university],
    hardResolutions: [{
      kind: "subject_assignment",
      resolutionKey: teacherSubjectResolutionKey({
        subjectRef: { workbook: "k12", sourceId: "fixture-k12", sheetName: "IB", sourceRow: 20 },
        decision: "ignore",
        sourceRevisions,
      }),
      decision: "ignore",
      sourceRevisions,
      subjectRef: { workbook: "k12", sourceId: "fixture-k12", sheetName: "IB", sourceRow: 20 },
    }],
  });
  assert.deepEqual(ignored, baseline);
});

test("fifteen authoritative subject categories replace any legacy category set exactly", () => {
  const sheets = TEACHER_WORKBOOK_SHEETS.k12.slice(1, 16);
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Fifteen Category Teacher" }],
      subjectRows: sheets.map((sheetName, index) => ({
        workbook: "k12" as const,
        sheetName,
        sourceRow: index + 10,
        name: "Fifteen Category Teacher",
      })),
    })],
    existingTeachers: [{
      id: "TEA-FIFTEEN",
      name: "Fifteen Category Teacher",
      subjects: ["IB"],
      sourceCategories: ["IB"],
      subjectDetail: "stale detail",
    }],
  });
  assert.deepEqual(plan.teachers[0].subjects, sheets);
  assert.deepEqual(plan.teachers[0].sourceCategories, sheets);
  assert.equal("subjectDetail" in plan.teachers[0], false);
});

test("a subject-only teacher uses the SQL-compatible UTF-8 name hash and replays stably", () => {
  const source = workbook({
    revision: "k12-r1",
    subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 20, name: "Subject Only" }],
  });
  const first = buildTeacherImportPlan({ workbooks: [source] });
  assert.deepEqual(first.teachers[0].teacherSourceRefs, [{
    workbook: "k12",
    sourceId: "fixture-k12#subjects",
    sourceRow: "name:831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a",
  }]);
  const replay = buildTeacherImportPlan({
    workbooks: [{ ...source, revision: "k12-r2" }],
    existingTeachers: first.teachers,
  });
  assert.equal(replay.teachers[0].id, first.teachers[0].id);
  assert.deepEqual(replay.teachers[0].teacherSourceRefs, first.teachers[0].teacherSourceRefs);
});

test("refresh replaces refs in both current namespaces and preserves unrelated history", () => {
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({ rosterRows: [{ workbook: "k12", sourceRow: 4, name: "Refresh Teacher" }] })],
    existingTeachers: [{
      id: "TEA-REFRESH",
      name: "Refresh Teacher",
      teacherSourceRefs: [
        { workbook: "k12", sourceId: "fixture-k12", sourceRow: 99 },
        { workbook: "k12", sourceId: "fixture-k12#subjects", sourceRow: "name:old" },
        { workbook: "k12", sourceId: "historical-k12", sourceRow: 8 },
      ],
    }],
  });
  assert.deepEqual(plan.teachers[0].teacherSourceRefs, [
    { workbook: "k12", sourceId: "fixture-k12", sourceRow: 4 },
    { workbook: "k12", sourceId: "historical-k12", sourceRow: 8 },
  ]);
});

test("production projection counts are 227 authority, 190 reuse, 37 new, 27 legacy and 254 final", () => {
  const authorityNames = Array.from({ length: 227 }, (_, index) =>
    `Authority Teacher ${String(index + 1).padStart(3, "0")}`);
  const existingTeachers = [
    ...authorityNames.slice(0, 190).map((name, index) => ({
      id: `TEA-REUSE-${index + 1}`,
      name,
      subjects: ["IB"],
      sourceCategories: ["IB"],
    })),
    ...Array.from({ length: 27 }, (_, index) => ({
      id: `TEA-LEGACY-${index + 1}`,
      name: `Legacy Teacher ${index + 1}`,
      subjects: ["IB"],
      sourceCategories: ["IB"],
      subjectDetail: "stale",
      acceptsStudents: true,
    })),
  ];
  const plan = buildTeacherImportPlan({
    workbooks: [workbook({
      rosterRows: authorityNames.map((name, index) => ({ workbook: "k12", sourceRow: index + 1, name })),
    })],
    existingTeachers,
  });
  assert.equal(plan.summary.blocked, 0);
  assert.equal(plan.summary.insert, 37);
  assert.equal(plan.summary.update, 217);
  assert.equal(plan.teachers.filter((teacher) => teacher.name.startsWith("Authority Teacher")).length, 227);
  assert.equal(plan.teachers.filter((teacher) => teacher.name.startsWith("Legacy Teacher")).length, 27);
  assert.equal(plan.teachers.length, 254);
  assert.ok(plan.teachers.filter((teacher) => teacher.name.startsWith("Legacy Teacher"))
    .every((teacher) => teacher.subjects.length === 0
      && teacher.sourceCategories.length === 0
      && teacher.acceptsStudents === false
      && !("subjectDetail" in teacher)));
});

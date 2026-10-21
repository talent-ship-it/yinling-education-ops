import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LP_WORKFLOW_FORM_NAMES,
  LpWorkflowFields,
  LpWorkflowDetails,
  LpWorkflowFormDataError,
  lpRevisionDocumentUrl,
  parseLpWorkflowFormData,
} from "../app/lp-workflow-fields.tsx";
import { operationsOwnerFormOptions, resolveAssignableOperationsOwner } from "../lib/demo-users";
import type { LpRevision } from "../lib/lp-workflows.ts";

function revision(documentUrl: unknown): LpRevision {
  return {
    id: "REV-002",
    workflowId: "LP-001",
    number: 2,
    changedAt: "2026-08-12T08:00:00.000Z",
    changedBy: "Nixon",
    before: {},
    after: { documentUrl: documentUrl as never },
  };
}

test("returns a link only for http and https revision documents", () => {
  assert.equal(lpRevisionDocumentUrl(revision("https://docs.qq.com/doc/example")), "https://docs.qq.com/doc/example");
  assert.equal(lpRevisionDocumentUrl(revision("http://example.com/version/2")), "http://example.com/version/2");
  assert.equal(lpRevisionDocumentUrl(revision("javascript:alert(1)")), null);
  assert.equal(lpRevisionDocumentUrl(revision("not a URL")), null);
  assert.equal(lpRevisionDocumentUrl(revision({ url: "https://example.com" })), null);
});

test("renders only non-empty schema fields and makes only http or https URL fields clickable", () => {
  const html = renderToStaticMarkup(<LpWorkflowDetails
    type="试听 LP"
    fields={{
      responsibleOperations: "Abby",
      specifiedContentStatus: "已指定",
      specialNotes: "   ",
      preparationFollowUp: "否",
      isUniversityStudent: false,
      universityMajor: "stale hidden value",
      assignedTeacher: "Teacher A",
      subject: "English",
      oneSentenceDescription: "Year 8 writing",
      locationTimezone: "Australia/Melbourne",
      contactPerson: "家长",
      timeMentioned: false,
      preferredTime: "stale preferred time",
      studentNameKnown: false,
      trialPaymentMethod: "免费试听",
      documentUrl: "https://hidden.example/internal",
      internalExplanation: { debug: "must not render" },
    }}
  />);

  assert.match(html, /试听 LP 字段/);
  assert.doesNotMatch(html, /当前完整字段|所属教务|>Abby</);
  assert.match(html, /是否知道学生姓名/);
  assert.match(html, />否</);
  assert.doesNotMatch(html, /specialNotes|stale hidden value|stale preferred time|hidden\.example|internalExplanation|must not render/);

  const urlHtml = renderToStaticMarkup(<LpWorkflowDetails
    type="老师 LP 修改"
    fields={{
      responsibleOperations: "Abby",
      specifiedContentStatus: "无需指定",
      preparationFollowUp: "否",
      isUniversityStudent: false,
      teacher: "Teacher A",
      subject: "English",
      documentUrl: "https://docs.qq.com/doc/example",
      modificationRequirements: "Update unit 2",
    }}
  />);
  assert.match(urlHtml, /href="https:\/\/docs\.qq\.com\/doc\/example"/);
  assert.match(urlHtml, /target="_blank" rel="noreferrer"/);

  const unsafeUrlHtml = renderToStaticMarkup(<LpWorkflowDetails
    type="老师 LP 修改"
    fields={{ documentUrl: "javascript:alert(1)" }}
  />);
  assert.match(unsafeUrlHtml, /javascript:alert\(1\)/);
  assert.doesNotMatch(unsafeUrlHtml, /href=/);
});

test("renders the distinguishing saved fields for all seven LP workflow types", () => {
  const cases = [
    ["试听 LP", { assignedTeacher: "Trial Teacher" }, "安排老师", "Trial Teacher"],
    ["老师新 LP", { recommendedResources: "ClassIn folder" }, "建议资料库", "ClassIn folder"],
    ["老师 LP 修改", { modificationRequirements: "Replace unit 2" }, "修改要求", "Replace unit 2"],
    ["换老师试听", { recommendedNextContent: "Continue algebra" }, "建议后续内容与资料", "Continue algebra"],
    ["代课 LP", { coverageStartDate: "2026-09-01" }, "覆盖开始日期", "2026-09-01"],
    ["学生直报（无试听）", { purchasedHours: 0 }, "购买课时", "0"],
    ["学生报名交接", { coursePackage: "English 20h" }, "课程 / 课包", "English 20h"],
  ] as const;

  for (const [type, fields, label, value] of cases) {
    const html = renderToStaticMarkup(<LpWorkflowDetails type={type} fields={fields} />);
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

function formData(
  workflowType: string,
  values: Record<string, string> = {},
): FormData {
  const result = new FormData();
  const common = {
    [LP_WORKFLOW_FORM_NAMES.workflowType]: workflowType,
    [LP_WORKFLOW_FORM_NAMES.responsibleOperations]: "Abby",
    [LP_WORKFLOW_FORM_NAMES.specifiedContentStatus]: "已指定",
    [LP_WORKFLOW_FORM_NAMES.preparationFollowUp]: "否",
    [LP_WORKFLOW_FORM_NAMES.requestSentAt]: "2026-10-21T03:00:00.000Z",
    [LP_WORKFLOW_FORM_NAMES.writingRequired]: "否",
    [LP_WORKFLOW_FORM_NAMES.paperRequired]: "否",
  };
  Object.entries({ ...common, ...values }).forEach(([name, value]) => result.set(name, value));
  return result;
}

test("parses every dedicated LP handover form instead of returning common fields only", () => {
  const teacherLp = parseLpWorkflowFormData(formData("老师新 LP", {
    teacher: "Teacher A",
    subject: "English",
    documentUrl: "https://docs.example/lp",
    additionalNotes: "Encourage the student",
    basicInfo: "Year 8",
    studentFoundation: "Developing",
    learningGoal: "Improve school results",
    recommendedResources: "ClassIn English folder",
    teachingLanguage: "English",
    firstLessonContent: "Persuasive writing",
    lessonSchedule: "Weekly, one hour",
  }));
  assert.equal(teacherLp.workflowType, "老师新 LP");
  assert.equal("teacher" in teacherLp.fields && teacherLp.fields.teacher, "Teacher A");

  const modification = parseLpWorkflowFormData(formData("老师 LP 修改", {
    teacher: "Teacher A",
    subject: "English",
    modificationRequirements: "Replace unit 2",
  }));
  assert.equal(
    "modificationRequirements" in modification.fields
      && modification.fields.modificationRequirements,
    "Replace unit 2",
  );

  const teacherChange = parseLpWorkflowFormData(formData("换老师试听", {
    originalTeacher: "Teacher A",
    newTeacher: "Teacher B",
    subject: "Math",
    changeReason: "Availability",
    trialInformation: "Saturday 10:00",
    handoverFromTeacher: "Teacher A",
    materialsAndContentTaught: "Reading workbook unit 4",
    recommendedNextContent: "Continue inference questions",
    studentStrengthsAndLearningProfile: "Quiet and responds to encouragement",
    lastHomework: "Workbook pages 20-25",
    lastLessonRecordingUrl: "https://recording.example/lesson",
  }));
  assert.equal("newTeacher" in teacherChange.fields && teacherChange.fields.newTeacher, "Teacher B");

  const substitute = parseLpWorkflowFormData(formData("代课 LP", {
    originalTeacher: "Teacher A",
    substituteTeacher: "Teacher B",
    subject: "Math",
    coverageStartDate: "2026-09-01",
    coverageEndDate: "2026-09-30",
    additionalNotes: "Keep the same lesson rhythm",
    basicInfo: "Year 8",
    studentFoundation: "Developing",
    learningGoal: "School English",
    allocatedLessonContentAndResources: "Lesson 1: workbook pages 20-25",
    teachingLanguage: "English",
    lastHomework: "Workbook pages 18-19",
    lastLessonRecordingUrl: "https://recording.example/lesson",
  }));
  assert.equal(
    "coverageEndDate" in substitute.fields && substitute.fields.coverageEndDate,
    "2026-09-30",
  );

  const enrollment = parseLpWorkflowFormData(formData("学生报名交接", {
    planner: "Tara",
    coursePackage: "20 hours",
    subject: "English",
    enrollmentHandoverNotes: "Start next week",
    purchasedHours: "20",
    bonusHours: "2",
    lessonFrequency: "Weekly",
    preferredTime: "Saturday 10:00",
    coursesAndTeachers: "Year 8 English / Teacher A",
  }));
  assert.equal("planner" in enrollment.fields && enrollment.fields.planner, "Tara");
});

test("uses final domain validation for URLs and date ranges", () => {
  assert.throws(
    () => parseLpWorkflowFormData(formData("老师 LP 修改", {
      teacher: "Teacher A",
      subject: "English",
      documentUrl: "javascript:alert(1)",
      modificationRequirements: "Update school report",
    })),
    /http or https/,
  );
  assert.throws(
    () => parseLpWorkflowFormData(formData("代课 LP", {
      originalTeacher: "Teacher A",
      substituteTeacher: "Teacher B",
      subject: "English",
      coverageStartDate: "2026-09-30",
      coverageEndDate: "2026-09-01",
      additionalNotes: "Continue current plan",
      basicInfo: "Year 8",
      studentFoundation: "Developing",
      learningGoal: "School English",
      allocatedLessonContentAndResources: "Workbook unit 4",
      teachingLanguage: "English",
      lastHomework: "Unit 3",
      lastLessonRecordingUrl: "https://recording.example/lesson",
    })),
    /must not be before/,
  );
});

test("direct enrollment rejects a zero purchased-plus-bonus total", () => {
  const base = {
    assignedTeacher: "Teacher A",
    subject: "English",
    oneSentenceDescription: "Year 8 writing",
    locationTimezone: "Australia/Melbourne",
    contactPerson: "家长",
    timeMentioned: "否",
    lessonFrequency: "Weekly",
    coursesAndTeachers: "Year 8 English / Teacher A",
  };
  assert.throws(
    () => parseLpWorkflowFormData(formData("学生直报（无试听）", {
      ...base,
      purchasedHours: "0",
      bonusHours: "0",
    })),
    (error: unknown) => {
      assert.ok(error instanceof LpWorkflowFormDataError);
      assert.equal(error.fieldName, LP_WORKFLOW_FORM_NAMES.purchasedHours);
      return true;
    },
  );
  assert.equal(
    parseLpWorkflowFormData(formData("学生直报（无试听）", {
      ...base,
      purchasedHours: "0",
      bonusHours: "2",
    })).workflowType,
    "学生直报（无试听）",
  );
});

test("enrollment handover also rejects a zero purchased-plus-bonus total", () => {
  assert.throws(
    () => parseLpWorkflowFormData(formData("学生报名交接", {
      planner: "Tara",
      coursePackage: "Year 8 English",
      subject: "English",
      purchasedHours: "0",
      bonusHours: "0",
      lessonFrequency: "Weekly",
      preferredTime: "Saturday 10:00",
      coursesAndTeachers: "Year 8 English / Teacher A",
    })),
    (error: unknown) => {
      assert.ok(error instanceof LpWorkflowFormDataError);
      assert.equal(error.fieldName, LP_WORKFLOW_FORM_NAMES.purchasedHours);
      return true;
    },
  );
});

test("stable form names include every dedicated handover field", () => {
  assert.deepEqual(
    Object.keys(LP_WORKFLOW_FORM_NAMES),
    [
      "workflowType",
      "responsibleOperations",
      "specifiedContentStatus",
      "specialNotes",
      "preparationFollowUp",
      "isUniversityStudent",
      "universityMajor",
      "universityYear",
      "assignedTeacher",
      "requestSentAt",
      "subject",
      "oneSentenceDescription",
      "locationTimezone",
      "contactPerson",
      "contactParents",
      "contactStudent",
      "contactNote",
      "writingRequired",
      "writingNote",
      "paperRequired",
      "paperNote",
      "timeMentioned",
      "preferredTime",
      "studentNameKnown",
      "studentName",
      "preparationNote",
      "trialDurationMinutes",
      "trialDurationNote",
      "trialPaymentMethod",
      "purchasedHours",
      "bonusHours",
      "lessonFrequency",
      "coursesAndTeachers",
      "teacher",
      "documentUrl",
      "modificationRequirements",
      "additionalNotes",
      "basicInfo",
      "studentFoundation",
      "learningGoal",
      "recommendedResources",
      "teachingLanguage",
      "firstLessonContent",
      "lessonSchedule",
      "comments",
      "originalTeacher",
      "newTeacher",
      "changeReason",
      "trialInformation",
      "handoverFromTeacher",
      "materialsAndContentTaught",
      "recommendedNextContent",
      "studentStrengthsAndLearningProfile",
      "lastHomework",
      "lastLessonRecordingUrl",
      "substituteTeacher",
      "coverageStartDate",
      "coverageEndDate",
      "handoverNotes",
      "allocatedLessonContentAndResources",
      "planner",
      "coursePackage",
      "enrollmentHandoverNotes",
    ],
  );
});

test("renders each dedicated workflow with hard options and strict URL/date controls", () => {
  const sharedProps = {
    responsibleOperationsOptions: [{ value: "Abby" }],
    teacherOptions: [{ value: "teacher-a", label: "Teacher A" }],
    subjectOptions: [{ value: "English" }],
    plannerOptions: [{ value: "Tara" }],
    coursePackageOptions: [{ value: "package-20", label: "20 hours" }],
  } as const;
  const expectedNames = {
    "老师新 LP": ["teacher", "subject", "documentUrl", "additionalNotes", "basicInfo", "studentFoundation", "learningGoal", "recommendedResources", "teachingLanguage", "firstLessonContent", "lessonSchedule", "comments"],
    "老师 LP 修改": ["teacher", "subject", "documentUrl", "modificationRequirements"],
    "换老师试听": ["originalTeacher", "newTeacher", "subject", "changeReason", "trialInformation", "handoverFromTeacher", "materialsAndContentTaught", "recommendedNextContent", "studentStrengthsAndLearningProfile", "lastHomework", "lastLessonRecordingUrl"],
    "代课 LP": [
      "originalTeacher",
      "substituteTeacher",
      "subject",
      "coverageStartDate",
      "coverageEndDate",
      "additionalNotes",
      "basicInfo",
      "studentFoundation",
      "learningGoal",
      "allocatedLessonContentAndResources",
      "teachingLanguage",
      "lastHomework",
      "lastLessonRecordingUrl",
    ],
    "学生报名交接": ["planner", "coursePackage", "subject", "purchasedHours", "bonusHours", "lessonFrequency", "preferredTime", "coursesAndTeachers", "enrollmentHandoverNotes"],
  } as const;

  for (const [initialType, names] of Object.entries(expectedNames)) {
    const html = renderToStaticMarkup(
      <LpWorkflowFields
        {...sharedProps}
        initialType={initialType as keyof typeof expectedNames}
      />,
    );
    names.forEach((name) => assert.match(html, new RegExp(`name="${name}"`)));
    assert.doesNotMatch(html, /<small/);
    assert.match(html, /<select name="subject"/);
  }

  const teacherLp = renderToStaticMarkup(
    <LpWorkflowFields {...sharedProps} initialType="老师新 LP" />,
  );
  assert.match(teacherLp, /<select name="teacher"/);
  assert.match(teacherLp, /<input type="url" name="documentUrl"/);

  const substitute = renderToStaticMarkup(
    <LpWorkflowFields {...sharedProps} initialType="代课 LP" />,
  );
  assert.match(substitute, /<input type="date"[^>]*name="coverageStartDate"/);
  assert.match(substitute, /<input type="date"[^>]*name="coverageEndDate"/);

  const enrollment = renderToStaticMarkup(
    <LpWorkflowFields {...sharedProps} initialType="学生报名交接" />,
  );
  assert.match(enrollment, /<select name="planner"/);
  assert.match(enrollment, /<select name="coursePackage"/);
});

test("renders the exact trial operations list and seven customisable location suggestions", () => {
  const html = renderToStaticMarkup(<LpWorkflowFields
    initialType="试听 LP"
    responsibleOperationsOptions={[{ value: "Nixon" }]}
    timezoneOptions={[{ value: "Australia/Melbourne" }]}
  />);
  const operations = html.match(/<select name="responsibleOperations"[\s\S]*?<\/select>/)?.[0] ?? "";
  const locations = html.match(/<datalist id="lp-options-locationTimezone"[\s\S]*?<\/datalist>/)?.[0] ?? "";

  for (const name of ["Tiffany", "Ella", "Abby", "Molly", "Thea", "Erin"]) {
    assert.match(operations, new RegExp(`value="${name}"`));
  }
  assert.doesNotMatch(operations, /Nixon/);
  for (const location of ["VIC", "NSW", "QLD", "WA", "SA", "NZ", "国内"]) {
    assert.match(locations, new RegExp(`value="${location}"`));
  }
  for (const label of ["是否要指定内容", "是否要写作", "是否发试卷、收试卷", "是否跟进老师备课内容"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /<input(?=[^>]*name="locationTimezone")(?=[^>]*list="lp-options-locationTimezone")[^>]*>/);
  assert.doesNotMatch(locations, /Australia\/Melbourne/);
});

test("non-trial LP forms retain the exact existing owner instead of selecting another coordinator", () => {
  for (const owner of ["Tara", "Eileen", "ELLA 教务", " Ｅｌｌａ ", "思佳", "Historical Owner"]) {
    const html = renderToStaticMarkup(<LpWorkflowFields
      initialType="老师新 LP"
      initialValues={{ responsibleOperations: owner }}
      responsibleOperationsOptions={operationsOwnerFormOptions(owner).map((value) => ({ value }))}
    />);
    const operations = html.match(/<select name="responsibleOperations"[\s\S]*?<\/select>/)?.[0] ?? "";
    assert.ok(operations.includes(`value="${owner}" selected=""`), owner);
  }
});


test("admin LP forms canonicalize current aliases and require an explicit owner for historical assignments", () => {
  for (const owner of ["ELLA 教务", " Ｅｌｌａ ", "Tara", "Eileen", "思佳", "Historical Owner"]) {
    const selectedOwner = resolveAssignableOperationsOwner(owner) ?? "";
    for (const initialType of ["老师新 LP", "试听 LP"] as const) {
      const html = renderToStaticMarkup(<LpWorkflowFields
        initialType={initialType}
        initialValues={{ responsibleOperations: selectedOwner }}
        responsibleOperationsOptions={operationsOwnerFormOptions(selectedOwner).map((value) => ({ value }))}
      />);
      const operations = html.match(/<select name="responsibleOperations"[\s\S]*?<\/select>/)?.[0] ?? "";
      assert.ok(operations.includes(`value="${selectedOwner}" selected=""`), owner);
      assert.doesNotMatch(operations, /value="(?:Tara|Eileen|思佳|Historical Owner)"/);
      assert.match(operations, /required=""/);
    }
  }
});

test("LP forms do not silently select the first coordinator for an absent owner", () => {
  for (const owner of ["", "Nixon", "Historical Owner"]) {
    const html = renderToStaticMarkup(<LpWorkflowFields
      initialType="试听 LP"
      initialValues={{ responsibleOperations: owner }}
    />);
    const operations = html.match(/<select name="responsibleOperations"[\s\S]*?<\/select>/)?.[0] ?? "";
    assert.match(operations, /value="" selected="">请选择教务/);
    assert.doesNotMatch(operations, /value="Tiffany" selected/);
  }
});


test("robot drafts require explicit choices instead of filling missing facts with manual defaults", () => {
  const html = renderToStaticMarkup(<LpWorkflowFields requireExplicitSelection initialType="试听 LP" initialValues={{ responsibleOperations: "Ella" }} />);
  for (const name of ["planner", "writingRequired", "paperRequired", "timeMentioned", "studentNameKnown", "trialDurationMinutes", "trialPaymentMethod", "specifiedContentStatus", "preparationFollowUp"]) {
    const select = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(select, name);
    assert.match(select[1], /<option value="" selected="">/);
  }
  assert.match(html, /name="workflowType" value="试听 LP"/);
  assert.doesNotMatch(html, /name="contactParents"[^>]*checked/);
});

test("accepts the three concise handover templates without requiring LP document content", () => {
  const newLp = parseLpWorkflowFormData(formData("老师新 LP", {
    teacher: "Teacher A", subject: "English", writingRequired: "是", writingNote: "Essay", paperRequired: "是", paperNote: "School paper",
  }));
  assert.equal(newLp.fields.requestSentAt, "2026-10-21T03:00:00.000Z");
  assert.equal("writingRequired" in newLp.fields && newLp.fields.writingRequired, true);
  assert.equal("paperNote" in newLp.fields && newLp.fields.paperNote, "School paper");
  assert.equal("basicInfo" in newLp.fields, false);

  const repeat = parseLpWorkflowFormData(formData("换老师试听", {
    newTeacher: "Teacher B", subject: "English", changeReason: "Try a different teaching style",
  }));
  assert.equal("originalTeacher" in repeat.fields, false);
  assert.equal("writingRequired" in repeat.fields, false);
  assert.equal("lastLessonRecordingUrl" in repeat.fields, false);

  const modificationForm = formData("老师 LP 修改", { subject: "English", modificationRequirements: "Use school revision materials" });
  modificationForm.delete("specifiedContentStatus");
  modificationForm.delete("preparationFollowUp");
  const modification = parseLpWorkflowFormData(modificationForm);
  assert.equal("teacher" in modification.fields, false);
  assert.equal(modification.fields.specifiedContentStatus, "无需指定");
  assert.equal(modification.fields.preparationFollowUp, "否");
});

test("handover controls require the source template fields and keep historical details optional", () => {
  const teacher = renderToStaticMarkup(<LpWorkflowFields initialType="老师新 LP" requireExplicitSelection />);
  for (const name of ["requestSentAt", "teacher", "subject", "writingRequired", "paperRequired"]) {
    assert.match(teacher, new RegExp(`<(?:input|select)(?=[^>]*name="${name}")(?=[^>]*required)[^>]*>`));
  }
  assert.doesNotMatch(teacher, /<textarea[^>]*name="basicInfo"[^>]*required/);
  const repeat = renderToStaticMarkup(<LpWorkflowFields initialType="换老师试听" />);
  assert.doesNotMatch(repeat, /<(?:input|select)[^>]*name="originalTeacher"[^>]*required/);
  assert.doesNotMatch(repeat, /<input[^>]*name="lastLessonRecordingUrl"[^>]*required/);
  const modification = renderToStaticMarkup(<LpWorkflowFields initialType="老师 LP 修改" teacherOptions={[{ value: "Teacher A" }]} />);
  assert.doesNotMatch(modification, /name="(?:specifiedContentStatus|preparationFollowUp)"/);
  assert.match(modification, /<option value="" selected="">未指定<\/option>/);
  assert.doesNotMatch(modification, /<(?:input|select)[^>]*name="teacher"[^>]*required/);
});

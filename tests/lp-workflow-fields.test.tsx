import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LP_WORKFLOW_FORM_NAMES,
  LpWorkflowFields,
  LpWorkflowFormDataError,
  lpRevisionDocumentUrl,
  parseLpWorkflowFormData,
} from "../app/lp-workflow-fields.tsx";
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
  };
  Object.entries({ ...common, ...values }).forEach(([name, value]) => result.set(name, value));
  return result;
}

test("parses every dedicated LP handover form instead of returning common fields only", () => {
  const teacherLp = parseLpWorkflowFormData(formData("老师新 LP", {
    teacher: "Teacher A",
    subject: "English",
    documentUrl: "https://docs.example/lp",
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
  }));
  assert.equal("newTeacher" in teacherChange.fields && teacherChange.fields.newTeacher, "Teacher B");

  const substitute = parseLpWorkflowFormData(formData("代课 LP", {
    originalTeacher: "Teacher A",
    substituteTeacher: "Teacher B",
    subject: "Math",
    coverageStartDate: "2026-09-01",
    coverageEndDate: "2026-09-30",
    handoverNotes: "Continue unit 4",
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
  }));
  assert.equal("planner" in enrollment.fields && enrollment.fields.planner, "Tara");
});

test("uses final domain validation for URLs and date ranges", () => {
  assert.throws(
    () => parseLpWorkflowFormData(formData("老师 LP 修改", {
      teacher: "Teacher A",
      subject: "English",
      documentUrl: "javascript:alert(1)",
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
      handoverNotes: "Continue current plan",
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
      "subject",
      "oneSentenceDescription",
      "locationTimezone",
      "contactPerson",
      "purchasedHours",
      "bonusHours",
      "teacher",
      "documentUrl",
      "modificationRequirements",
      "originalTeacher",
      "newTeacher",
      "changeReason",
      "trialInformation",
      "substituteTeacher",
      "coverageStartDate",
      "coverageEndDate",
      "handoverNotes",
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
    "老师新 LP": ["teacher", "subject", "documentUrl", "modificationRequirements"],
    "老师 LP 修改": ["teacher", "subject", "documentUrl", "modificationRequirements"],
    "换老师试听": ["originalTeacher", "newTeacher", "subject", "changeReason", "trialInformation"],
    "代课 LP": [
      "originalTeacher",
      "substituteTeacher",
      "subject",
      "coverageStartDate",
      "coverageEndDate",
      "handoverNotes",
    ],
    "学生报名交接": ["planner", "coursePackage", "subject", "enrollmentHandoverNotes"],
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

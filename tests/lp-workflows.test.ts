import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedLpResultStatuses,
  changeLpResultStatus,
  changeLpStage,
  getLpWorkflowSchema,
  LP_STAGES,
  LP_RESULT_STATUSES,
  LP_WORKFLOW_SCHEMAS,
  LP_WORKFLOW_TYPES,
  PREPARATION_FOLLOW_UP_OPTIONS,
  reviseLpWorkflow,
  SPECIFIED_CONTENT_STATUSES,
  validateLpDate,
  validateLpDocumentUrl,
  validateLpResultStatus,
  validateLpWorkflowFields,
  type LpWorkflowRecord,
} from "../lib/lp-workflows.ts";

const commonKeys = [
  "responsibleOperations",
  "specifiedContentStatus",
  "specialNotes",
  "preparationFollowUp",
  "isUniversityStudent",
  "universityMajor",
  "universityYear",
];

function fieldKeys(type: (typeof LP_WORKFLOW_TYPES)[number]) {
  return getLpWorkflowSchema(type).fields.map((field) => field.key);
}

test("defines exactly the seven LP workflow types requested in the feedback", () => {
  assert.deepEqual(LP_WORKFLOW_TYPES, [
    "试听 LP",
    "老师新 LP",
    "老师 LP 修改",
    "换老师试听",
    "代课 LP",
    "学生直报（无试听）",
    "学生报名交接",
  ]);
  assert.deepEqual(Object.keys(LP_WORKFLOW_SCHEMAS), LP_WORKFLOW_TYPES);
});

test("uses the confirmed common fields and normalises the specified-content typo", () => {
  for (const type of LP_WORKFLOW_TYPES) {
    assert.deepEqual(fieldKeys(type).slice(0, commonKeys.length), commonKeys);

    const specifiedContent = getLpWorkflowSchema(type).fields.find((field) => field.key === "specifiedContentStatus");
    const preparation = getLpWorkflowSchema(type).fields.find((field) => field.key === "preparationFollowUp");
    assert.deepEqual(specifiedContent?.options, SPECIFIED_CONTENT_STATUSES);
    assert.deepEqual(specifiedContent?.options, ["已指定", "无需指定", "需要跟进"]);
    assert.deepEqual(preparation?.options, PREPARATION_FOLLOW_UP_OPTIONS);
  }
});

test("makes university major and year conditional rather than adding unconfirmed fields", () => {
  const schema = getLpWorkflowSchema("老师新 LP");
  const major = schema.fields.find((field) => field.key === "universityMajor");
  const year = schema.fields.find((field) => field.key === "universityYear");

  assert.deepEqual(major?.visibleWhen, { field: "isUniversityStudent", equals: true });
  assert.equal(major?.requirement, "university-only");
  assert.deepEqual(year?.visibleWhen, { field: "isUniversityStudent", equals: true });
  assert.equal(year?.requirement, "university-only");
});

test("adds the minimal system handover fields without claiming a group-template copy", () => {
  const trialKeys = fieldKeys("试听 LP");
  for (const key of ["assignedTeacher", "subject", "oneSentenceDescription", "locationTimezone", "contactPerson"]) {
    assert.ok(trialKeys.includes(key as never));
  }

  const directSchema = getLpWorkflowSchema("学生直报（无试听）");
  const directKeys = fieldKeys("学生直报（无试听）");
  assert.ok(directKeys.includes("purchasedHours"));
  assert.ok(directKeys.includes("bonusHours"));
  assert.equal(directSchema.fields.find((field) => field.key === "purchasedHours")?.min, 0);
  assert.equal(directSchema.fields.find((field) => field.key === "bonusHours")?.min, 0);

  const expected = {
    "老师新 LP": ["teacher", "subject", "documentUrl", "modificationRequirements"],
    "老师 LP 修改": ["teacher", "subject", "documentUrl", "modificationRequirements"],
    "换老师试听": ["originalTeacher", "newTeacher", "subject", "changeReason", "trialInformation"],
    "代课 LP": ["originalTeacher", "substituteTeacher", "subject", "coverageStartDate", "coverageEndDate", "handoverNotes"],
    "学生报名交接": ["planner", "coursePackage", "subject", "enrollmentHandoverNotes"],
  } as const;
  for (const [type, keys] of Object.entries(expected)) {
    const schema = getLpWorkflowSchema(type as keyof typeof expected);
    assert.equal(schema.typeSpecificFieldsDocumented, true);
    assert.deepEqual(fieldKeys(type as keyof typeof expected), [...commonKeys, ...keys]);
    for (const key of keys) assert.ok(schema.fields.find((field) => field.key === key)?.label);
  }
  assert.equal(getLpWorkflowSchema("老师新 LP").fields.find((field) => field.key === "documentUrl")?.control, "url");
  assert.equal(getLpWorkflowSchema("代课 LP").fields.find((field) => field.key === "coverageStartDate")?.control, "date");
});

function commonFields() {
  return {
    responsibleOperations: "Abby",
    specifiedContentStatus: "已指定",
    preparationFollowUp: "是",
    isUniversityStudent: false,
  } as const;
}

test("validates the minimum dedicated handover fields, URLs and coverage dates", () => {
  assert.doesNotThrow(() => validateLpWorkflowFields("老师新 LP", {
    ...commonFields(), teacher: "Teacher A", subject: "Math", documentUrl: "https://docs.example/lp",
  }));
  assert.throws(() => validateLpWorkflowFields("老师 LP 修改", {
    ...commonFields(), teacher: "Teacher A", subject: "Math", documentUrl: "javascript:alert(1)",
  }), /http or https/);
  assert.doesNotThrow(() => validateLpWorkflowFields("换老师试听", {
    ...commonFields(), originalTeacher: "A", newTeacher: "B", subject: "English", changeReason: "Availability", trialInformation: "Saturday trial",
  }));
  assert.doesNotThrow(() => validateLpWorkflowFields("代课 LP", {
    ...commonFields(), originalTeacher: "A", substituteTeacher: "B", subject: "English", coverageStartDate: "2026-09-01", coverageEndDate: "2026-09-30", handoverNotes: "Use current plan",
  }));
  assert.throws(() => validateLpWorkflowFields("代课 LP", {
    ...commonFields(), originalTeacher: "A", substituteTeacher: "B", subject: "English", coverageStartDate: "2026-09-30", coverageEndDate: "2026-09-01", handoverNotes: "Use current plan",
  }), /must not be before/);
  assert.doesNotThrow(() => validateLpWorkflowFields("学生报名交接", {
    ...commonFields(), planner: "Tara", coursePackage: "Year 8 English / 20h", subject: "English", enrollmentHandoverNotes: "Enrolled after trial",
  }));
  assert.equal(validateLpDocumentUrl("https://docs.example/lp"), "https://docs.example/lp");
  assert.equal(validateLpDate("2028-02-29"), "2028-02-29");
  assert.throws(() => validateLpDate("2027-02-29"), /valid calendar date/);
});

test("keeps business result independent from stage and restricts it by workflow type", () => {
  assert.deepEqual(LP_RESULT_STATUSES, ["试听成功", "试听失败", "有希望报名", "试听未进行", "在读试听成功", "在读试听失败"]);
  assert.deepEqual(allowedLpResultStatuses("试听 LP"), ["试听成功", "试听失败", "有希望报名", "试听未进行"]);
  assert.deepEqual(allowedLpResultStatuses("换老师试听"), ["在读试听成功", "在读试听失败"]);
  assert.deepEqual(allowedLpResultStatuses("老师新 LP"), []);
  assert.doesNotThrow(() => validateLpResultStatus("试听 LP", "有希望报名"));
  assert.throws(() => validateLpResultStatus("试听 LP", "在读试听成功"), /not valid/);
  assert.throws(() => validateLpResultStatus("老师新 LP", "试听成功"), /not valid/);

  const current = workflow();
  const changed = changeLpResultStatus(current, "试听成功", {
    id: "AUD-RESULT-1", at: "2026-08-13T10:00:00.000Z", actor: "Abby", note: "Family confirmed",
  });
  assert.equal(changed.stage, "待审核");
  assert.equal(changed.resultStatus, "试听成功");
  assert.equal(changed.audit.length, 0);
  assert.deepEqual(changed.resultAudit?.at(-1), {
    id: "AUD-RESULT-1",
    workflowId: "LP-001",
    action: "result_status_changed",
    occurredAt: "2026-08-13T10:00:00.000Z",
    actor: "Abby",
    toResultStatus: "试听成功",
    note: "Family confirmed",
  });
  assert.equal(changeLpResultStatus(changed, "试听成功", { id: "unused", at: "2026-08-13", actor: "Abby" }), changed);
  const cleared = changeLpResultStatus(changed, undefined, { id: "AUD-RESULT-2", at: "2026-08-13T11:00:00.000Z", actor: "Abby" });
  assert.equal(cleared.resultStatus, undefined);
  assert.deepEqual(cleared.resultAudit?.at(-1), {
    id: "AUD-RESULT-2",
    workflowId: "LP-001",
    action: "result_status_changed",
    occurredAt: "2026-08-13T11:00:00.000Z",
    actor: "Abby",
    fromResultStatus: "试听成功",
  });
});

test("includes the needs-revision LP stage", () => {
  assert.ok(LP_STAGES.includes("需修改"));
  assert.ok(LP_STAGES.indexOf("需修改") > LP_STAGES.indexOf("待审核"));
});

function workflow(): LpWorkflowRecord {
  return {
    id: "LP-001",
    type: "试听 LP",
    stage: "待审核",
    fields: {
      responsibleOperations: "Eileen",
      specifiedContentStatus: "已指定",
      preparationFollowUp: "是",
      isUniversityStudent: false,
      nested: { topic: "algebra" },
    },
    revisionNumber: 1,
    revisions: [],
    audit: [],
  };
}

test("creates an immutable revision without mutating the current workflow or caller patch", () => {
  const current = workflow();
  const patch = { nested: { topic: "calculus" }, specialNotes: "Use the school worksheet" };
  const revised = reviseLpWorkflow(current, patch, {
    id: "REV-002",
    at: "2026-08-12T08:00:00.000Z",
    actor: "Nixon",
    note: "Teacher requested a change",
  });

  assert.notEqual(revised, current);
  assert.equal(current.revisionNumber, 1);
  assert.deepEqual(current.fields.nested, { topic: "algebra" });
  assert.equal(revised.revisionNumber, 2);
  assert.equal(revised.revisions.length, 1);
  assert.deepEqual(revised.revisions[0].before.nested, { topic: "algebra" });
  assert.deepEqual(revised.revisions[0].after.nested, { topic: "calculus" });
  assert.equal(Object.isFrozen(revised.revisions[0]), true);
  assert.equal(Object.isFrozen(revised.revisions[0].before), true);
  assert.equal(Object.isFrozen(revised.revisions[0].after.nested), true);

  patch.nested.topic = "mutated outside";
  assert.deepEqual(revised.fields.nested, { topic: "calculus" });
  assert.deepEqual(revised.revisions[0].after.nested, { topic: "calculus" });
});

test("records every real stage change in the audit history and ignores no-op transitions", () => {
  const current = workflow();
  const changed = changeLpStage(current, "需修改", {
    id: "AUD-001",
    at: "2026-08-12T09:30:00.000Z",
    actor: "Tara",
    note: "Missing school report",
  });

  assert.equal(current.stage, "待审核");
  assert.equal(current.audit.length, 0);
  assert.equal(changed.stage, "需修改");
  assert.deepEqual(changed.audit[0], {
    id: "AUD-001",
    workflowId: "LP-001",
    action: "stage_changed",
    occurredAt: "2026-08-12T09:30:00.000Z",
    actor: "Tara",
    fromStage: "待审核",
    toStage: "需修改",
    note: "Missing school report",
  });
  assert.equal(Object.isFrozen(changed.audit), true);
  assert.equal(Object.isFrozen(changed.audit[0]), true);
  assert.equal(changeLpStage(changed, "需修改", {
    id: "AUD-unused",
    at: "2026-08-12T09:31:00.000Z",
    actor: "Tara",
  }), changed);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  changeLpStage,
  getLpWorkflowSchema,
  LP_STAGES,
  LP_WORKFLOW_SCHEMAS,
  LP_WORKFLOW_TYPES,
  PREPARATION_FOLLOW_UP_OPTIONS,
  reviseLpWorkflow,
  SPECIFIED_CONTENT_STATUSES,
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

test("adds only documented trial fields and models direct-enrolment purchased and bonus hours separately", () => {
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

  for (const type of ["老师新 LP", "老师 LP 修改", "换老师试听", "代课 LP", "学生报名交接"] as const) {
    assert.equal(getLpWorkflowSchema(type).typeSpecificFieldsDocumented, false);
    assert.deepEqual(fieldKeys(type), commonKeys);
  }
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

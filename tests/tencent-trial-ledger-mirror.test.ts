import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTencentTrialLedgerMirrorRows,
  TENCENT_TRIAL_LEDGER_FIELDS,
} from "../lib/tencent-trial-ledger-mirror";

test("projects the handbook's exact 13 columns from authoritative trial state", () => {
  const [row] = buildTencentTrialLedgerMirrorRows({
    students: [{
      id: "STU-1",
      name: "AutomaticName",
      guardianWechat: "Parent WeChat",
      planner: "Eileen",
      course: "Y8 English",
      teacher: "Fallback Teacher",
    }],
    lpItems: [{
      id: "LP-1",
      studentId: "STU-1",
      workflowType: "试听 LP",
      owner: "Tiffany",
      requestedAt: "2026-08-27T01:00:00.000Z",
      fields: {
        subject: "AEAS Reading",
        assignedTeacher: "Assigned Teacher",
        trialPaymentMethod: "付费试听（已付费）",
      },
      trialIntake: {
        studentName: "PartialName",
        requestSentAt: "2026-08-27T02:00:00.000Z",
        planner: "Tara",
      },
      trialSchedule: {
        startsAt: "2026-08-31T15:00:00.000Z",
        studentName: "JiaowubaoName张同学",
        teacherName: "Jiaowubao Teacher",
      },
      resultStatus: "试听成功",
      trialLedgerNote: "Sales note",
    }],
  });

  assert.deepEqual(Object.keys(row.values), TENCENT_TRIAL_LEDGER_FIELDS);
  assert.deepEqual(row, {
    lpItemId: "LP-1",
    values: {
      学生姓名: "JiaowubaoName张同学",
      家长微信名: "Parent WeChat",
      "LP 类型": "试听 LP",
      上课月份: "2026-09",
      "请求日期/时间": "2026-08-27T02:00:00.000Z",
      "上课日期和时间（墨尔本）": "2026-08-31T15:00:00.000Z",
      教务: "Tiffany",
      课程规划老师: "Tara",
      科目: "AEAS Reading",
      老师: "Jiaowubao Teacher",
      试听状态: "试听成功",
      是否付费: "是",
      备注: "Sales note",
    },
  });
});
test("manual ledger values override automatic values and remain deterministic", () => {
  const rows = buildTencentTrialLedgerMirrorRows({
    students: [{ id: "STU-1", name: "Automatic", guardian: "Guardian", teacher: "Old Teacher" }],
    lpItems: [{
      id: "LP-Z",
      studentId: "STU-1",
      workflowType: "换老师试听",
      owner: "Ella",
      trialLedgerOverrides: {
        studentName: "Manual Name",
        guardianWechat: "Manual Parent",
        workflowType: "试听 LP",
        lessonMonth: "2026-10",
        requestedAt: "2026-09-01T00:00:00.000Z",
        scheduledAt: "2026-10-02T09:30:00.000Z",
        operationsOwner: "Abby",
        planner: "Eileen",
        subject: "Manual Subject",
        teacher: "Manual Teacher",
      },
      fields: { trialPaymentMethod: "付费试听（已付费）" },
      trialPaid: false,
      trialLedgerNote: "Manual note",
      resultStatus: "有希望报名",
    }, {
      id: "LP-A",
      studentId: "STU-1",
      workflowType: "试听 LP",
      owner: "Ella",
      trialSchedule: { startsAt: "2026-11-01T00:00:00.000Z" },
    }],
  });

  assert.deepEqual(rows.map((row) => row.lpItemId), ["LP-A", "LP-Z"]);
  assert.equal(rows[0].values.试听状态, "试听未进行");
  assert.deepEqual(rows[1].values, {
    学生姓名: "Manual Name",
    家长微信名: "Manual Parent",
    "LP 类型": "试听 LP",
    上课月份: "2026-10",
    "请求日期/时间": "2026-09-01T00:00:00.000Z",
    "上课日期和时间（墨尔本）": "2026-10-02T09:30:00.000Z",
    教务: "Abby",
    课程规划老师: "Eileen",
    科目: "Manual Subject",
    老师: "Manual Teacher",
    试听状态: "有希望报名",
    是否付费: "否",
    备注: "Manual note",
  });
});

test("normalizes legacy aliases and replaces invalid trial status with the handbook default", () => {
  const [row] = buildTencentTrialLedgerMirrorRows({
    students: [{ id: "STU-1", planner: "Tara龙" }],
    lpItems: [{
      id: "LP-1",
      studentId: "STU-1",
      workflowType: "试听 LP",
      owner: "Nixon",
      resultStatus: "Legacy custom result",
    }],
  });

  assert.equal(row.values["LP 类型"], "试听 LP");
  assert.equal(row.values.教务, "");
  assert.equal(row.values.课程规划老师, "Tara");
  assert.equal(row.values.试听状态, "试听未进行");
});

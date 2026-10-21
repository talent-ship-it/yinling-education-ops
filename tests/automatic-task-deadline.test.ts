import assert from "node:assert/strict";
import test from "node:test";

import { generateTrialPaymentTasks, hasAutomaticTaskDeadline, isCanonicalTaskDueAt } from "../lib/ops-tasks";

const templates = [
  ["试听 LP：核对交接信息", "试听 LP 创建后自动生成"],
  ["跟进家长指定内容", "试听 LP：需要跟进家长指定内容"],
  ["确认家长在 48 小时内完成指定资料/试卷", "试听 LP：家长指定内容时限"],
  ["确认老师备课内容与资料", "试听 LP：需要跟进老师备课"],
  ["最迟 24 小时内完成试听排课", "试听 LP 排课时限"],
  ["将 LP 发审核群并发给老师", "试听 LP 课前资料交接"],
  ["试听收费确认", "试听 LP 收费提醒"],
  ["试听当天课后跟进", "试听 LP 课后跟进"],
];

test("recognizes the complete original automatic trial task family without treating a matching manual title as automation", () => {
  for (const [title, trigger] of templates) {
    assert.equal(hasAutomaticTaskDeadline({ title, trigger }), true, title);
    assert.equal(hasAutomaticTaskDeadline({ title, trigger: "人工创建" }), false, title);
    assert.equal(hasAutomaticTaskDeadline({ title: `${title} 自定义`, trigger }), false, title);
  }
  assert.equal(hasAutomaticTaskDeadline({ ruleKey: undefined }), true);
  assert.equal(hasAutomaticTaskDeadline({ anchorBookingId: null }), true);
  assert.equal(hasAutomaticTaskDeadline({ title: null, trigger: 17 }), false);
});

test("real trial start evidence still generates precise rule-bound payment deadlines without manual input", () => {
  const generated = generateTrialPaymentTasks({
    anchorBookingId: "BOOK-AUTO-DEADLINE",
    studentId: "STU-AUTO-DEADLINE",
    planner: "Abby",
    trialStartsAt: "2026-08-20T00:00:00.000Z",
    trialPaymentMethod: "付费试听（未付费）",
    now: "2026-08-19T01:00:00.000Z",
  });
  assert.deepEqual(generated.map((task) => task.dueAt), ["2026-08-18T08:00:00.000Z", "2026-08-19T00:00:00.000Z"]);
  assert.ok(generated.every((task) => hasAutomaticTaskDeadline(task) && isCanonicalTaskDueAt(task.dueAt)));
});

import assert from "node:assert/strict";
import test from "node:test";

import { projectOperationalAuditEntry } from "../lib/operational-audit";

test("projects only server audit fields into the administrator view", () => {
  assert.deepEqual(projectOperationalAuditEntry({
    id: "11111111-1111-4111-8111-111111111111",
    action: "ops_state.students.updated",
    actor: "Nixon",
    target_type: "ops_state",
    target_id: "students",
    created_at: "2026-08-27T01:02:03.000Z",
  }), {
    id: "AUD-11111111-1111-4111-8111-111111111111",
    time: "2026-08-27T01:02:03.000Z",
    actor: "Admin",
    action: "更新学生",
    detail: "ops_state · students · ops_state.students.updated",
    tone: "blue",
  });
});

test("uses conservative labels and tones for dedicated atomic operations", () => {
  const entry = projectOperationalAuditEntry({
    id: "22222222-2222-4222-8222-222222222222",
    action: "lp.atomic.create",
    actor: "Abby",
    target_type: "student",
    target_id: "STU-1",
    created_at: "2026-08-27T01:02:03.000Z",
  });
  assert.equal(entry.action, "创建业务记录");
  assert.equal(entry.tone, "green");
  assert.equal(entry.actor, "Abby");
});

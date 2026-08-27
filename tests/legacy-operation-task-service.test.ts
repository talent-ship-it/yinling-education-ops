import assert from "node:assert/strict";
import test from "node:test";

import { parseLegacyOperationTaskCommand } from "../lib/legacy-operation-task-service";

test("legacy command keeps only leave/replacement semantic inputs", () => {
  const parsed = parseLegacyOperationTaskCommand({ commandKey: "operation-task-create:123e4567-e89b-42d3-a456-426614174000", type: "换老师", detail: "匹配新老师", studentId: "S-1", teacherId: "T-1", eventStart: "2026-08-21", eventEnd: "2026-08-21", expectedVersions: { bookings: 1, operations: 2, students: 3, tasks: 4, teachers: 5 } });
  assert.equal(parsed.type, "换老师");
  assert.throws(() => parseLegacyOperationTaskCommand({ ...parsed, operations: [] }), /reviewed operation/);
  assert.throws(() => parseLegacyOperationTaskCommand({ ...parsed, type: "老师请假" }), /invalid|studentId and teacherId/);
});

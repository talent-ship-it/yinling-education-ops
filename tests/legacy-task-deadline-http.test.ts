import assert from "node:assert/strict";
import test from "node:test";

import { legacyTaskDeadlineHttpError } from "../lib/legacy-task-deadline-http";
import { LegacyTaskDeadlineServiceError } from "../lib/legacy-task-deadline-service";

test("maps a replay-miss clear command to the stable 422 clear_disabled response", () => {
  const response = legacyTaskDeadlineHttpError(new LegacyTaskDeadlineServiceError(
    "clear_disabled",
    "准确截止时间只能修改，不能清除。",
  ));
  assert.deepEqual(response, {
    status: 422,
    body: {
      error: "准确截止时间只能修改，不能清除。",
      code: "clear_disabled",
    },
  });
});

test("preserves the route's authorization, conflict, missing, and availability statuses", () => {
  const cases = [
    ["admin_forbidden", 403],
    ["task_not_found", 404],
    ["task_closed", 409],
    ["invalid_shared_state", 503],
    ["invalid_request", 422],
  ] as const;
  for (const [code, status] of cases) {
    assert.equal(legacyTaskDeadlineHttpError(new LegacyTaskDeadlineServiceError(code, code)).status, status);
  }
});

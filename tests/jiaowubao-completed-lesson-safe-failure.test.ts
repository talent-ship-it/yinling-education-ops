import assert from "node:assert/strict";
import test from "node:test";

import { safeJiaowubaoCompletedLessonDatabaseFailure } from "../lib/jiaowubao-completed-lesson-database-failure.ts";

test("database failures expose only a bounded code category", () => {
  const privateFailure = {
    message: "synthetic-private-message-must-not-appear",
    code: "23514",
    detail: "synthetic-private-detail-must-not-appear",
    constraint: "synthetic-private-constraint-must-not-appear",
  };
  const safe = safeJiaowubaoCompletedLessonDatabaseFailure(privateFailure);
  assert.deepEqual(safe, { kind: "database", code: "23514" });
  assert.deepEqual(Object.keys(safe).sort(), ["code", "kind"]);
  assert.doesNotMatch(JSON.stringify(safe), /private-message|private-detail|private-constraint/);

  assert.deepEqual(
    safeJiaowubaoCompletedLessonDatabaseFailure({ message: "hidden", code: "PGRST116" }),
    { kind: "database", code: "PGRST116" },
  );
  assert.deepEqual(
    safeJiaowubaoCompletedLessonDatabaseFailure({ message: "hidden", code: "unsafe-source-id" }),
    { kind: "database", code: "other" },
  );
});

test("known database messages map to fixed diagnostic codes without exposing the message", () => {
  const knownFailure = {
    message: "jiaowubao_completed_lesson_snapshot_page_invalid",
    code: "22023",
    detail: "synthetic-private-detail-must-not-appear",
  };
  const safe = safeJiaowubaoCompletedLessonDatabaseFailure(knownFailure);
  assert.deepEqual(
    safe,
    { kind: "database", code: "snapshot_page_invalid" },
  );
  assert.deepEqual(Object.keys(safe).sort(), ["code", "kind"]);
  assert.doesNotMatch(JSON.stringify(safe), /jiaowubao_completed|private-detail/);
});

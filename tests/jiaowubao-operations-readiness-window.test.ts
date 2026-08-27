import assert from "node:assert/strict";
import test from "node:test";

import {
  JIAOWUBAO_OPERATIONS_READINESS_WINDOW_DAYS,
  buildJiaowubaoOperationsReadinessWindow,
} from "../lib/jiaowubao-operations-readiness-window.ts";

test("builds one fixed, canonical UTC 63-day review window without DST arithmetic", () => {
  const window = buildJiaowubaoOperationsReadinessWindow(new Date("2026-10-03T23:47:12.123Z"));
  assert.deepEqual(window, {
    startsAt: "2026-10-03T00:00:00.000Z",
    endsAt: "2026-12-05T00:00:00.000Z",
  });
  assert.equal(new Date(window.endsAt).getTime() - new Date(window.startsAt).getTime(), JIAOWUBAO_OPERATIONS_READINESS_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
});

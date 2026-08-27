import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const client = fs.readFileSync(
  path.resolve(import.meta.dirname, "../app/operations-client.tsx"),
  "utf8",
);

test("LP parent-progress reconciliation has no browser task writer", () => {
  assert.doesNotMatch(client, /reconcileAllLpParentProgressTasks/);
  assert.doesNotMatch(client, /lpParentProgressRecords/);
  assert.doesNotMatch(client, /LP parent-progress reconciliation/);
});

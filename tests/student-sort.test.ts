import assert from "node:assert/strict";
import test from "node:test";

import { sortStudentsByName } from "../lib/student-sort";

const rows = [
  { id: "STU-3", name: "Zoe" },
  { id: "STU-2", name: "Alex" },
  { id: "STU-1", name: "Alex" },
] as const;

test("sortStudentsByName orders names ascending with deterministic ID ties", () => {
  assert.deepEqual(sortStudentsByName(rows, "asc").map((row) => row.id), ["STU-1", "STU-2", "STU-3"]);
});

test("sortStudentsByName orders names descending with deterministic ID ties", () => {
  assert.deepEqual(sortStudentsByName(rows, "desc").map((row) => row.id), ["STU-3", "STU-2", "STU-1"]);
});

test("sortStudentsByName never mutates its input", () => {
  const before = rows.map((row) => row.id);
  const sorted = sortStudentsByName(rows, "desc");
  assert.deepEqual(rows.map((row) => row.id), before);
  assert.notEqual(sorted, rows);
});

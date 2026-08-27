import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalJiaowubaoStudentSourceJson,
  formatJiaowubaoStudentSourceStagingReceipt,
  planJiaowubaoStudentSourceStaging,
  type RawJiaowubaoImportInput,
} from "../lib/jiaowubao-student-source-staging.ts";

function input(count = 3): RawJiaowubaoImportInput {
  const students = Array.from({ length: count }, (_, index) => {
    const id = String(index + 1);
    return { mem_id: id, name: `Private Learner ${id}`, ks_total: 10, ks_used: 2, ks_rest: 8 };
  });
  const contracts = students.map((student, index) => ({
    contract_id: `contract-${index + 1}`,
    contract_code: `code-${index + 1}`,
    mem_id: student.mem_id,
    course_id: "course-1",
    course_title: "Private English",
    nature: "new",
    nature_title: "新签",
    ks: 10,
    ks_use: 2,
    ks_left: 8,
    dated: "2026-08-01",
    detail_lists: [{
      detail_id: `detail-${index + 1}`,
      course_id: "course-1",
      course_title: "Private English",
      ks: 10,
      ks_left: 8,
    }],
  }));
  const courseBalances = students.map((student) => ({
    mem_id: student.mem_id,
    ks_total: 10,
    ks_used: 2,
    ks_rest: 8,
    courses: [{ course_id: "course-1", title: "Private English", ks: 10, ks_use: 2, ks_left: 8 }],
  }));
  return {
    sourceId: "jwb-api-students",
    revision: "sha256:" + "a".repeat(64),
    sourceRevisions: {
      students: "sha256:" + "b".repeat(64),
      contracts: "sha256:" + "c".repeat(64),
      courseBalances: "sha256:" + "d".repeat(64),
    },
    students,
    contracts,
    courseBalances,
    negativeAdjustmentPolicy: "reject",
  };
}

test("normalizes, sorts by sourceRow, and deterministically splits row closures", () => {
  const first = planJiaowubaoStudentSourceStaging(input());
  const second = planJiaowubaoStudentSourceStaging(input());

  assert.deepEqual(first.envelope, second.envelope);
  assert.equal(canonicalJiaowubaoStudentSourceJson(first), canonicalJiaowubaoStudentSourceJson(second));
  assert.deepEqual(first.chunks.flatMap((chunk) => chunk.rows).map((row) => row.sourceRow), ["1", "2", "3"]);
  assert.equal(first.envelope.expectedRows, 3);
  assert.equal(first.envelope.expectedChunks, first.chunks.length);
  assert.ok(first.chunks.every((chunk) => chunk.bytes <= 2 * 1024 * 1024));
  assert.ok(first.chunks.every((chunk) => chunk.bytes <= Math.floor(2 * 1024 * 1024 * 0.8)));
  assert.ok(first.chunks.every((chunk) => chunk.rows.every((row) => row.row.lessonPackages?.length === 1)));
});

test("pins raw candidate and source revisions as replay inputs", () => {
  const first = planJiaowubaoStudentSourceStaging(input());
  const changedMetadata = planJiaowubaoStudentSourceStaging({
    ...input(),
    revision: "sha256:" + "e".repeat(64),
    sourceRevisions: {
      students: "sha256:" + "f".repeat(64),
      contracts: "sha256:" + "1".repeat(64),
      courseBalances: "sha256:" + "2".repeat(64),
    },
  });
  assert.equal(first.envelope.rawCandidateSha256, changedMetadata.envelope.rawCandidateSha256);
  assert.notEqual(first.envelope.revision, changedMetadata.envelope.revision);
  assert.notEqual(first.envelope.normalizedRowsSha256, changedMetadata.envelope.normalizedRowsSha256);
  const supplied = "sha256:" + "3".repeat(64);
  assert.equal(
    planJiaowubaoStudentSourceStaging({ ...input(), rawCandidateSha256: supplied }).envelope.rawCandidateSha256,
    supplied,
  );
});

test("row closures carry verifiable canonical bytes and bind the completed row set", () => {
  const plan = planJiaowubaoStudentSourceStaging(input());
  const closures = plan.chunks.flatMap((chunk) => chunk.rows);
  for (const closure of closures) {
    assert.deepEqual(JSON.parse(closure.rowCanonicalJson), closure.row);
    assert.equal(
      closure.rowSha256,
      `sha256:${createHash("sha256").update(closure.rowCanonicalJson, "utf8").digest("hex")}`,
    );
    assert.equal(
      closure.closureSha256,
      `sha256:${createHash("sha256").update(closure.closureCanonicalJson, "utf8").digest("hex")}`,
    );
  }
  const completedCanonical = `[${closures.map((closure) => closure.closureCanonicalJson).join(",")}]`;
  assert.equal(
    plan.envelope.normalizedRowsSha256,
    `sha256:${createHash("sha256").update(completedCanonical, "utf8").digest("hex")}`,
  );
});

test("splits at a deterministic lower byte boundary and rejects one oversized row", () => {
  const fixture = input(4);
  const split = planJiaowubaoStudentSourceStaging(fixture, { maxChunkBytes: 5_000 });
  assert.ok(split.chunks.length > 1);
  assert.ok(split.chunks.every((chunk) => chunk.bytes <= 5_000));
  assert.throws(
    () => planJiaowubaoStudentSourceStaging(input(1), { maxChunkBytes: 100 }),
    (error: unknown) => error instanceof Error && error.name === "JiaowubaoStudentSourceStagingError"
      && error.message === "A single normalized JWB source row exceeds the chunk limit.",
  );
});

test("receipts and planner errors are aggregate-only and redact source row data", () => {
  const plan = planJiaowubaoStudentSourceStaging(input());
  const receipt = formatJiaowubaoStudentSourceStagingReceipt(plan, {
    state: "staging",
    chunksCommitted: 1,
    rowsCommitted: 1,
  });
  const safe = JSON.stringify(receipt);
  assert.doesNotMatch(safe, /Private Learner|Private English|0400/iu);
  assert.doesNotMatch(safe, /sourceRow|lessonPackages/iu);
  assert.throws(
    () => planJiaowubaoStudentSourceStaging({
      ...input(),
      students: [{ ...input(1).students[0], ks_total: "not-a-number" }],
    }),
    (error: unknown) => error instanceof Error && error.message === "JWB source normalization failed validation."
      && !error.message.includes("Private Learner")
      && !error.message.includes("1"),
  );
});

test("enforces planner row limits before producing chunks", () => {
  assert.throws(
    () => planJiaowubaoStudentSourceStaging(input(2), { maxRows: 1 }),
    /Normalized JWB source row count exceeds the allowed maximum/iu,
  );
});

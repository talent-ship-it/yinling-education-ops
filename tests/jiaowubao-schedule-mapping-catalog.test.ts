import assert from "node:assert/strict";
import test from "node:test";

import { parseJiaowubaoScheduleMappingReview } from "../app/jiaowubao-schedule-mapping-review.tsx";
import { parseJiaowubaoScheduleMappingPriorityReview } from "../app/jiaowubao-schedule-mapping-priority-review.tsx";

const teacher = { id: "teacher-synthetic", name: "Synthetic Teacher" };
const base = {
  state: "complete",
  runToken: "synthetic-run",
  teachersVersion: 1,
  candidates: [],
  nextCursor: null,
};

const parsers = [
  {
    label: "history",
    parse: (subjectIds: unknown[]) => parseJiaowubaoScheduleMappingReview({
      ...base,
      teachers: [{ ...teacher, subjectIds }],
      summary: { total: 0, unmapped: 0, confirmed: 0, revoked: 0, authorityChanged: 0 },
    }),
  },
  {
    label: "priority",
    parse: (subjectIds: unknown[]) => parseJiaowubaoScheduleMappingPriorityReview({
      ...base,
      teachers: [{ ...teacher, subjectIds }],
      window: { startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-10-22T00:00:00.000Z" },
      summary: { total: 0, unmapped: 0, authorityChanged: 0, revokedInWindow: 0 },
    }),
  },
];

for (const { label, parse } of parsers) {
  test(`${label} mapping accepts complete 544- and 1024-subject teacher catalogs without truncation`, () => {
    for (const count of [544, 1024]) {
      const subjectIds = Array.from({ length: count }, (_, index) => `Subject ${index}`);
      assert.deepEqual(parse(subjectIds).teachers[0]?.subjectIds, subjectIds);
    }
  });

  test(`${label} mapping rejects oversized or invalid larger teacher catalogs`, () => {
    const subjectIds = Array.from({ length: 1024 }, (_, index) => `Subject ${index}`);
    assert.throws(() => parse([...subjectIds, "One too many"]), /科目格式无效/);
    assert.throws(() => parse([...subjectIds.slice(0, 543), subjectIds[0]]), /科目重复/);
    assert.throws(() => parse([...subjectIds.slice(0, 543), null]), /格式无效/);
  });
}

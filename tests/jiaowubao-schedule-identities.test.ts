import assert from "node:assert/strict";
import test from "node:test";

import { readJiaowubaoScheduleSnapshotIdentities } from "../lib/jiaowubao-open-api-schedule-identities";

const revision = `sha256:${"a".repeat(64)}`;

test("reads one revision-pinned identity set with a monotonic cursor", async () => {
  const sourceKeys = Array.from({ length: 501 }, (_, index) =>
    `jwb-open-api:schedule:${String(index + 1).padStart(4, "0")}`);
  const cursors: Array<string | null> = [];
  const identities = await readJiaowubaoScheduleSnapshotIdentities(revision, async (input) => {
    cursors.push(input.cursorSourceKey);
    const start = input.cursorSourceKey === null ? 0 : 500;
    const items = sourceKeys.slice(start, start + 500).map((sourceKey) => ({
      sourceKey,
      sourceDate: "2026-09-22",
    }));
    return {
      state: "complete",
      revision,
      rowCount: 501,
      items,
      hasMore: start === 0,
      nextCursor: start === 0 ? items.at(-1)!.sourceKey : null,
    };
  });
  assert.deepEqual(cursors, [null, sourceKeys[499]]);
  assert.equal(identities.length, 501);
  assert.equal(identities.at(-1)?.sourceKey, sourceKeys.at(-1));
});

test("fails closed when the current pointer changes during identity pagination", async () => {
  await assert.rejects(readJiaowubaoScheduleSnapshotIdentities(revision, async () => ({
    state: "reset",
    revision: `sha256:${"b".repeat(64)}`,
    rowCount: 1,
    items: [],
    hasMore: false,
    nextCursor: null,
  })), /snapshot_changed/);
});

test("rejects incomplete, duplicate, or unbounded identity receipts", async () => {
  await assert.rejects(readJiaowubaoScheduleSnapshotIdentities(revision, async () => ({
    state: "complete",
    revision,
    rowCount: 2,
    items: [{ sourceKey: "jwb-open-api:schedule:one", sourceDate: "2026-09-22" }],
    hasMore: false,
    nextCursor: null,
  })), /page_invalid/);
  await assert.rejects(readJiaowubaoScheduleSnapshotIdentities(revision, async () => ({
    state: "complete",
    revision,
    rowCount: 2,
    items: [
      { sourceKey: "jwb-open-api:schedule:one", sourceDate: "2026-09-22" },
      { sourceKey: "jwb-open-api:schedule:one", sourceDate: "2026-09-22" },
    ],
    hasMore: false,
    nextCursor: null,
  })), /page_invalid/);
  await assert.rejects(readJiaowubaoScheduleSnapshotIdentities(revision, async () => ({
    state: "complete",
    revision,
    rowCount: 6_001,
    items: [],
    hasMore: false,
    nextCursor: null,
  })), /page_invalid/);
});

test("accepts database C-collation order for mixed-case and punctuation keys", async () => {
  const sourceKeys = [
    "jwb-open-api:schedule:0-dash",
    "jwb-open-api:schedule:A-upper",
    "jwb-open-api:schedule:Z_under",
    "jwb-open-api:schedule:a-lower",
  ];
  const identities = await readJiaowubaoScheduleSnapshotIdentities(revision, async () => ({
    state: "complete",
    revision,
    rowCount: sourceKeys.length,
    items: sourceKeys.map((sourceKey) => ({ sourceKey, sourceDate: "2026-09-22" })),
    hasMore: false,
    nextCursor: null,
  }));
  assert.deepEqual(identities.map((identity) => identity.sourceKey), sourceKeys);
});

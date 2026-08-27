import assert from "node:assert/strict";
import test from "node:test";

import {
  opsSourceIsArchived,
  opsSourceIsStale,
  partitionOpsSources,
} from "../lib/ops-source-lifecycle.ts";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

test("archived source mirrors remain auditable without counting as stale", () => {
  const archived = { status: "archived", synced_at: "2026-07-22T00:00:00.000Z" };
  assert.equal(opsSourceIsArchived(archived), true);
  assert.equal(opsSourceIsStale(archived, NOW), false);
});

test("active source freshness keeps the 36 hour boundary", () => {
  assert.equal(opsSourceIsStale({ status: "synced", synced_at: "2026-08-26T00:00:00.000Z" }, NOW), false);
  assert.equal(opsSourceIsStale({ status: "synced", synced_at: "2026-08-25T23:59:59.999Z" }, NOW), true);
  assert.equal(opsSourceIsStale({ status: "synced", synced_at: "invalid" }, NOW), true);
});

test("partitions current pipelines from retained history without reordering", () => {
  const rows = [
    { status: "synced", synced_at: "2026-08-27T00:00:00.000Z", id: "current" },
    { status: "archived", synced_at: "2026-07-22T00:00:00.000Z", id: "history" },
  ];
  const partitioned = partitionOpsSources(rows);
  assert.deepEqual(partitioned.active.map((row) => row.id), ["current"]);
  assert.deepEqual(partitioned.archived.map((row) => row.id), ["history"]);
});

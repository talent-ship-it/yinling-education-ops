import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditView } from "../lib/audit-view";

const label = (actor: string) => actor === "Nixon" ? "Admin" : actor;
const records = Array.from({ length: 19 }, (_,id) => ({ id, actor: id % 2 ? "系统" : "Nixon", action: "修改", detail: `记录 ${id}`, tone: id % 3 ? "green" : "red" }));

test("audit exports all matching records while pages and global tab counts remain distinct", () => {
  const view = buildAuditView(records, " ADMIN ", "manual", 9, label);
  assert.equal(view.filtered.length, 10);
  assert.deepEqual(view.counts, { all: 19, manual: 10, system: 9, amber: 7 });
  assert.equal(view.safePage, 2);
  assert.deepEqual(view.paged.map(x => x.id), [16, 18]);
  assert.equal(records.length, 19);
});

test("audit attention includes red and amber, preserves actor aliases, and clamps empty pages", () => {
  assert.equal(buildAuditView(records, "Nixon", "amber", 1, label).filtered.length, 4);
  assert.equal(buildAuditView([{ ...records[0], tone: "amber" }], "", "amber", 1, label).filtered.length, 1);
  const empty = buildAuditView(records, "不存在", "all", 5, label);
  assert.equal(empty.safePage, 1);
  assert.deepEqual(empty.paged, []);
  assert.equal(buildAuditView(records, "", "green", 1, label).filtered.length, 12);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("keeps the trial ledger at the handbook's exact 13 columns", () => {
  const header = client.match(/<table className="trial-ledger-table">[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/)?.[1] ?? "";
  const labels = [...header.matchAll(/<th>([^<]+)<\/th>/g)].map((match) => match[1]);

  assert.deepEqual(labels, [
    "学生姓名",
    "家长微信名",
    "LP 类型",
    "上课月份",
    "请求日期/时间",
    "上课日期和时间（墨尔本）",
    "教务",
    "课程规划老师",
    "科目",
    "老师",
    "试听状态",
    "是否付费",
    "备注",
  ]);
});

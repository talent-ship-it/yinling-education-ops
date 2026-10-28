import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JiaowubaoHourDiscrepanciesPanel, JiaowubaoHourDiscrepancyTable } from "../app/jiaowubao-hour-discrepancies";
import type { MonthlyHourDiscrepancy } from "../lib/jiaowubao-monthly-hour-discrepancies";

const item: MonthlyHourDiscrepancy = {
  id: "synthetic", lessonDate: "2026-09-07", timeTitle: "09:00-10:00", courseTitle: "Synthetic English",
  students: [{ id: "S1", name: "Synthetic Student" }], teacher: "Synthetic Teacher", teacherRole: "primary",
  teacherHours: 1, studentHours: 0, difference: null, sourceMatch: "candidate",
  operationsOwners: ["Ella"], ownerUnmatched: false, status: "待核查", reason: "分校来源待确认（候选对照）",
};

test("the monthly audit panel renders scoped month/owner controls and a loading state", () => {
  const html = renderToStaticMarkup(createElement(JiaowubaoHourDiscrepanciesPanel));
  assert.match(html, /aria-label="月度课时核查"/);
  assert.match(html, /type="month"/);
  assert.match(html, /aria-label="课时核查教务"/);
  assert.match(html, /aria-label="课时核查课时对比"/);
  assert.match(html, /老师课时 ≠ 学生课时合计/);
  assert.match(html, /role="status"/);
  assert.match(html, /正在读取月度课时/);
  assert.match(html, /disabled=""/);
});

test("the API reads an authenticated report and exposes no collecting or mutation handler", async () => {
  const route = await readFile(new URL("../app/api/jiaowubao-open-api/hour-discrepancies/route.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../app/jiaowubao-hour-discrepancies.tsx", import.meta.url), "utf8");
  assert.match(route, /getCurrentDemoSession/);
  assert.match(route, /session\.role === "teacher"/);
  assert.match(route, /getMonthlyHourDiscrepancyReport/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|DELETE|PATCH)|syncJiaowubao|mutate|putOpsState/);
  assert.doesNotMatch(panel, /from ["'](?:luxon|.*reconciliation)["']/);
  assert.match(panel, /import type.*MonthlyHourDiscrepancyReport/);
  assert.match(panel, /new AbortController/);
});

test("candidate source hours are visible without presenting a confirmed numeric difference", () => {
  const html = renderToStaticMarkup(createElement(JiaowubaoHourDiscrepancyTable, { rows: [item] }));
  assert.match(html, /<td>1<br\/>候选来源<\/td><td>0<\/td><td>分校待确认<\/td>/);
  assert.match(html, /分校来源待确认（候选对照）/);
  assert.match(html, /共 1 条待核查/);
  assert.doesNotMatch(html, /未提供/);
});

test("unlinked sources and genuinely absent or invalid hours have distinct labels", () => {
  const unlinked = renderToStaticMarkup(createElement(JiaowubaoHourDiscrepancyTable, { rows: [{ ...item, sourceMatch: "unlinked", teacherHours: null }] }));
  assert.match(unlinked, /待关联来源/);
  assert.doesNotMatch(unlinked, /来源未提供或异常/);
  const missing = renderToStaticMarkup(createElement(JiaowubaoHourDiscrepancyTable, { rows: [{ ...item, sourceMatch: "matched", teacherHours: null }] }));
  assert.match(missing, /来源未提供或异常/);
  assert.doesNotMatch(missing, /待关联来源/);
  const studentOnly = renderToStaticMarkup(createElement(JiaowubaoHourDiscrepancyTable, { rows: [{ ...item, sourceMatch: "unlinked", students: [], studentHours: null }] }));
  assert.match(studentOnly, /<td>待关联来源<\/td><td>不可核对<\/td>/);
});

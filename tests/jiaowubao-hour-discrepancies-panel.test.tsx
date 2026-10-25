import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JiaowubaoHourDiscrepanciesPanel } from "../app/jiaowubao-hour-discrepancies";

test("the monthly audit panel renders scoped month/owner controls and a loading state", () => {
  const html = renderToStaticMarkup(createElement(JiaowubaoHourDiscrepanciesPanel));
  assert.match(html, /aria-label="月度课时核查"/);
  assert.match(html, /type="month"/);
  assert.match(html, /aria-label="课时核查教务"/);
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

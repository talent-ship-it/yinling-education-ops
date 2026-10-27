import { expect, test, type Page, type Route } from "@playwright/test";
import type { MonthlyHourDiscrepancy } from "../../lib/jiaowubao-monthly-hour-discrepancies";

function discrepancy(index: number, extra: Partial<MonthlyHourDiscrepancy> = {}): MonthlyHourDiscrepancy {
  return {
    id: `SYNTH-HOURS-${index}`, lessonDate: "2026-09-07", timeTitle: "09:00-10:00", courseTitle: `Synthetic Course ${index}`,
    students: [{ id: `SYNTH-STUDENT-${index}`, name: `Synthetic Student ${index}` }], teacher: "Synthetic Teacher", teacherRole: "primary",
    teacherHours: 1, studentHours: 1, difference: null, sourceMatch: "candidate", operationsOwners: ["Ella"], ownerUnmatched: false,
    status: "待核查", reason: "分校来源待确认（候选对照）", ...extra,
  };
}

async function syntheticAudit(page: Page) {
  const unexpected: string[] = [];
  const errors: string[] = [];
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => discrepancy(index)),
    discrepancy(100, { studentHours: 2 }),
    discrepancy(101, { studentHours: 0, difference: 1, sourceMatch: "matched", operationsOwners: ["Tara"], reason: "课时不等" }),
    discrepancy(102, { teacherHours: null, sourceMatch: "unlinked", reason: "缺少教师课时来源" }),
  ];
  const entities = Object.fromEntries(["students", "teachers", "tasks", "bookings", "courses", "lpItems", "operations", "renewals", "payroll", "messages", "files", "audit"].map((entity) => [entity, []]));
  const versions = Object.fromEntries(Object.keys(entities).map((entity) => [entity, 1]));
  const stateRow = (entity: string) => ({ entity, payload: entities[entity], version: 1, updated_at: "2026-10-01T00:00:00.000Z", updated_by: "synthetic" });
  const snapshots = {
    managedExamSnapshot: { versions: { students: 1, tasks: 1 }, students: [] },
    managedTrialPaymentSnapshot: { versions: { students: 1, tasks: 1, bookings: 1, lpItems: 1 }, students: [] },
  };
  function sharedState(url: URL) {
    if (url.searchParams.get("mode") === "versions") return { versions: Object.keys(entities).map(stateRow) };
    return { rows: (url.searchParams.get("entities") ?? "").split(",").filter((entity) => entity in entities).map(stateRow), ...snapshots };
  }
  function report(url: URL) {
    const owner = url.searchParams.get("owner");
    return {
      month: url.searchParams.get("month") || "2026-09", defaultMonth: "2026-09", revision: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-01T00:00:00.000Z",
      operationsOwners: ["Ella", "Tara"], rows: rows.filter((row) => !owner || row.operationsOwners.includes(owner)),
    };
  }
  function reply(route: Route, url: URL) {
    switch (url.pathname) {
      case "/api/demo-session": return route.fulfill({ json: { ok: true, user: "Nixon", role: "admin", mustChangePassword: false } });
      case "/api/nixon-session": return route.fulfill({ json: { ok: true } });
      case "/api/app-snapshot": return route.fulfill({ json: { ...entities, versions, ...snapshots } });
      case "/api/app-state": return route.fulfill({ json: sharedState(url) });
      case "/api/audit": return route.fulfill({ json: { entries: [] } });
      case "/api/jiaowubao-open-api/hour-discrepancies": return route.fulfill({ json: report(url) });
      default: return route.fulfill({ status: 403, json: { error: "Unbound synthetic read" } });
    }
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/demo-logout" && request.method() === "POST") return route.fulfill({ json: { serverSessionRevoked: true } });
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 403, json: { error: "Synthetic audit blocks writes" } });
    }
    return reply(route, url);
  });
  await page.goto("/#section=reports");
  const panel = page.getByRole("region", { name: "月度课时核查", exact: true });
  await expect(panel.getByText("共 103 条待核查 · 第 1 页", { exact: true })).toBeVisible();
  return { panel, unexpected, errors };
}

test("the unequal-hours filter compares candidate values, resets paging, and combines with the owner filter", async ({ page }) => {
  const f = await syntheticAudit(page);
  await f.panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(f.panel.getByText("共 103 条待核查 · 第 2 页", { exact: true })).toBeVisible();
  await f.panel.getByRole("combobox", { name: "课时核查课时对比", exact: true }).selectOption("different");
  await expect(f.panel.getByText("共 2 条待核查 · 第 1 页", { exact: true })).toBeVisible();
  const rows = f.panel.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Synthetic Student 100");
  await expect(rows.first()).toContainText("分校待确认");
  await expect(rows.nth(1)).toContainText("Synthetic Student 101");
  await expect(rows.nth(1)).toContainText("Tara");
  await f.panel.getByRole("combobox", { name: "课时核查教务", exact: true }).selectOption("Tara");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Synthetic Student 101");
  await f.panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(f.panel.getByRole("combobox", { name: "课时核查课时对比", exact: true })).toHaveValue("different");
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
});

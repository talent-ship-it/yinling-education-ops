import { expect, test, type Page, type Route } from "@playwright/test";
import { LP_WORKFLOW_TYPES } from "../../lib/lp-workflows";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";

async function syntheticLedger(page: Page) {
  const errors: string[] = [];
  const unexpected: string[] = [];
  const students = LP_WORKFLOW_TYPES.map((_, index) => ({
    id: `SYNTH-LEDGER-STUDENT-${index}`, name: `Synthetic Ledger Student ${index}`, initials: "SL",
    guardianWechat: `Synthetic Parent ${index}`, status: "在读", owner: index % 2 ? "Ella" : "Molly", planner: "Eileen",
    course: "English", timezone: "Australia/Melbourne", teacher: "Synthetic Student Teacher", next: "待安排", nextTone: "blue", files: 0,
  }));
  const lpItems = LP_WORKFLOW_TYPES.map((workflowType, index) => ({
    id: `SYNTH-LEDGER-LP-${index}`, studentId: students[index]!.id, title: `Synthetic Ledger LP ${index}`,
    workflowType, owner: students[index]!.owner, stage: "待资料", due: "2026-10-23",
    resultStatus: workflowType === "试听 LP" ? "试听成功" : workflowType === "换老师试听" ? "试听失败" : "已完成",
    fields: {
      subject: "English", requestSentAt: "2026-10-21T02:00:00.000Z",
      ...(index === 0 ? { assignedTeacher: "Synthetic Trial Teacher", trialPaymentMethod: "付费试听（已付费）" }
        : index === 3 ? { newTeacher: "Synthetic New Teacher" }
        : index === 4 ? { substituteTeacher: "Synthetic Cover Teacher" }
        : index < 3 ? { teacher: `Synthetic LP Teacher ${index}` } : {}),
    },
  }));
  const entities: Record<string, unknown[]> = {
    students, lpItems, teachers: [], tasks: [], bookings: [], courses: [], operations: [], renewals: [], payroll: [], messages: [], files: [], audit: [],
  };
  const versions = Object.fromEntries(Object.keys(entities).map((entity) => [entity, 1]));
  const row = (entity: string) => ({ entity, payload: entities[entity], version: 1, updated_at: "2026-10-22T02:00:00.000Z", updated_by: "synthetic" });
  const snapshots = {
    managedExamSnapshot: { versions: { students: 1, tasks: 1 }, students: [] },
    managedTrialPaymentSnapshot: { versions: { students: 1, tasks: 1, bookings: 1, lpItems: 1 }, students: [] },
  };
  function readReply(route: Route, url: URL) {
    switch (url.pathname) {
      case "/api/demo-session": return route.fulfill({ json: { ok: true, user: "Nixon", role: "admin", mustChangePassword: false } });
      case "/api/nixon-session": return route.fulfill({ json: { ok: true } });
      case "/api/app-snapshot": return route.fulfill({ json: { ...entities, versions, ...snapshots } });
      case "/api/app-state": return route.fulfill({ json: url.searchParams.get("mode") === "versions" ? { versions: Object.keys(entities).map(row) } : { rows: (url.searchParams.get("entities") ?? "").split(",").filter((entity) => entity in entities).map(row), ...snapshots } });
      case "/api/audit": return route.fulfill({ json: { entries: [] } });
      case "/api/operations/wecom-lp-drafts": return route.fulfill({ json: { drafts: [], nextCursor: null, total: 0 } });
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
      return route.fulfill({ status: 403, json: { error: "Synthetic ledger blocks writes" } });
    }
    return readReply(route, url);
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: displayPreferencesStorageKey("Nixon"), value: JSON.stringify(defaultDisplayPreferences()) });
  await page.goto("/#section=lp");
  const panel = page.getByRole("region", { name: "LP 交接台账", exact: true });
  await expect(panel).toBeVisible();
  return { panel, errors, unexpected };
}

test("the LP type dropdown lists and finds all seven handover types", async ({ page }) => {
  const f = await syntheticLedger(page);
  const type = f.panel.getByRole("combobox", { name: "LP 类型", exact: true });
  const rows = f.panel.locator("tbody tr");
  await expect(type.locator("option")).toHaveText(["全部类型", ...LP_WORKFLOW_TYPES]);
  await expect(rows).toHaveCount(7);
  for (const workflowType of LP_WORKFLOW_TYPES) {
    await type.selectOption(workflowType);
    await expect(rows).toHaveCount(1);
    const cell = rows.locator("td").nth(2);
    if (workflowType === "试听 LP" || workflowType === "换老师试听") {
      await expect(cell.getByRole("combobox")).toContainText(`自动 · ${workflowType}`);
    } else {
      await expect(cell).toHaveText(workflowType);
      await expect(rows.locator("input, select")).toHaveCount(0);
      await expect(rows.locator("td").nth(11)).toHaveText("已完成");
      await expect(rows.locator("td").nth(12)).toHaveText("—");
    }
  }
  await type.selectOption("代课 LP");
  await expect(rows.locator("td").nth(10)).toHaveText("Synthetic Cover Teacher");
  await page.reload();
  await expect(type).toHaveValue("代课 LP");
  await expect(rows).toHaveCount(1);
  await f.panel.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(rows).toHaveCount(7);
  expect(f.errors).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test("handover types combine with ownership and outcomes without entering trial payment statistics", async ({ page }) => {
  const f = await syntheticLedger(page);
  const rows = f.panel.locator("tbody tr");
  await f.panel.getByRole("combobox", { name: "LP 类型", exact: true }).selectOption("老师 LP 修改");
  await f.panel.getByRole("combobox", { name: "教务", exact: true }).selectOption("Ella");
  await expect(rows).toHaveCount(0);
  await f.panel.getByRole("combobox", { name: "教务", exact: true }).selectOption("Molly");
  await expect(rows).toHaveCount(1);
  await expect(rows.locator("td").first()).toHaveText("Synthetic Ledger Student 2");
  await expect(rows.locator("td").nth(10)).toHaveText("Synthetic LP Teacher 2");
  await f.panel.getByRole("button", { name: "清除筛选", exact: true }).click();
  await f.panel.getByRole("combobox", { name: "业务结果", exact: true }).selectOption("已完成");
  await expect(rows).toHaveCount(5);
  await expect(f.panel.locator(".trial-ledger-success-rate strong")).toHaveText("—");
  await f.panel.getByRole("button", { name: "清除筛选", exact: true }).click();
  await f.panel.getByRole("combobox", { name: "是否付费", exact: true }).selectOption("unpaid");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("combobox", { name: "Synthetic Ledger Student 3 学生姓名", exact: true })).toHaveValue("Synthetic Ledger Student 3");
  expect(f.errors).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

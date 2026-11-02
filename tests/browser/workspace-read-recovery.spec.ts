import { expect, test, type Page, type Route } from "@playwright/test";
import { DEMO_ADMIN_USER } from "../../lib/demo-users";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";

async function fixture(page: Page, failSnapshot: boolean, teacher = false) {
  const entities: Record<string, unknown[]> = Object.fromEntries(
    ["students", "teachers", "tasks", "bookings", "courses", "lpItems", "operations", "renewals", "payroll", "messages", "files", "audit"]
      .map((entity) => [entity, []]),
  );
  if (teacher) {
    for (const entity of ["lpItems", "operations", "renewals", "payroll", "audit"]) delete entities[entity];
    entities.teachers = [{
      id: "SYNTH-TEACHER", name: "Synthetic Teacher", initials: "ST", subjects: [],
      availability: "", load: 0, capacity: 0, acceptsStudents: false, note: "",
    }];
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: displayPreferencesStorageKey("Synthetic Teacher"), value: JSON.stringify(defaultDisplayPreferences()),
    });
  }
  let snapshotReads = 0;
  let versionReads = 0;
  let taskVersion = 1;
  let failVersions = false;
  let failedRefreshReads = 0;
  const writes: string[] = [];
  const errors: string[] = [];
  const stateReads: URL[] = [];
  const versions = () => Object.fromEntries(Object.keys(entities).map((entity) => [entity, entity === "tasks" ? taskVersion : 1]));
  const row = (entity: string) => ({ entity, payload: entities[entity], version: versions()[entity], updated_at: "2026-11-01T00:00:00.000Z", updated_by: "synthetic" });
  const projections = () => ({
    managedExamSnapshot: { versions: { students: 1, tasks: taskVersion }, students: [] },
    managedTrialPaymentSnapshot: teacher ? null : { versions: { students: 1, tasks: taskVersion, bookings: 1, lpItems: 1 }, students: [] },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  function readSnapshot(route: Route) {
    snapshotReads += 1;
    return failSnapshot && snapshotReads === 1
      ? route.fulfill({ status: 503, json: { error: "Synthetic initial read unavailable" } })
      : route.fulfill({ json: { ...entities, versions: versions(), ...projections() } });
  }
  function readState(route: Route, url: URL) {
    stateReads.push(url);
    if (url.searchParams.get("mode") !== "versions") return route.fulfill({
      json: { rows: (url.searchParams.get("entities") ?? "").split(",").filter((entity) => entity in entities).map(row), ...projections() },
    });
    versionReads += 1;
    if (failVersions) {
      failedRefreshReads += 1;
      return route.fulfill({ status: 503, json: { error: "Synthetic refresh unavailable" } });
    }
    return route.fulfill({ json: { versions: Object.keys(entities).map(row) } });
  }
  const readReplies: Record<string, (route: Route, url: URL) => Promise<void>> = {
    "/api/demo-session": (route) => route.fulfill({ json: { ok: true, user: teacher ? "Synthetic Teacher" : DEMO_ADMIN_USER, role: teacher ? "teacher" : "admin", mustChangePassword: false } }),
    "/api/nixon-session": (route) => route.fulfill({ json: { ok: !teacher } }),
    "/api/app-snapshot": readSnapshot,
    "/api/app-state": readState,
    "/api/classroom/materials": (route) => route.fulfill({ json: { configured: true, canManage: false, canPresent: false, folders: [], materials: [], breadcrumbs: [], nextOffset: null } }),
  };
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/demo-logout" && request.headers()["x-yinling-logout-retry"] === "1") return route.fulfill({ json: { serverSessionRevoked: true } });
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 403, json: { error: "Synthetic fixture blocks writes" } });
    }
    return readReplies[url.pathname]?.(route, url) ?? route.fulfill({ status: 403, json: { error: "Unbound synthetic read" } });
  });
  return {
    writes, errors, stateReads,
    snapshotReads: () => snapshotReads,
    versionReads: () => versionReads,
    failedRefreshReads: () => failedRefreshReads,
    failRefresh: (value: boolean) => { failVersions = value; },
    advanceTasks: () => { taskVersion += 1; },
    replaceTasks: (tasks: unknown[]) => { entities.tasks = tasks; },
  };
}

test("an initial data read failure can be retried without logging in or writing", async ({ page }) => {
  const f = await fixture(page, true);
  await page.goto("/#section=resources");
  await expect(page.getByRole("heading", { name: "无法读取真实资料", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试读取资料", exact: true }).click();
  await expect(page.getByRole("heading", { name: "资源", exact: true })).toBeVisible();
  expect(f.snapshotReads()).toBe(2);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("a teacher can read and refresh resources without LP or payroll authority", async ({ page }) => {
  const f = await fixture(page, false, true);
  await page.goto("/#section=resources");
  await expect(page.getByRole("heading", { name: "资源", exact: true })).toBeVisible();
  await expect.poll(f.versionReads).toBeGreaterThan(0);
  f.advanceTasks();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => f.stateReads.filter((url) => url.searchParams.has("entities")).length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "资源", exact: true })).toBeVisible();
  await expect(page.locator(".live-sync")).toHaveCount(0);
  for (const url of f.stateReads) {
    expect(url.searchParams.get("entities") ?? "").not.toMatch(/lpItems|payroll/);
    expect(url.searchParams.has("includeManagedTrialPaymentSnapshot")).toBe(false);
  }
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("an account with LP authority still rejects a missing payment snapshot", async ({ page }) => {
  const f = await fixture(page, false);
  await page.route("**/api/app-snapshot", (route) => route.fulfill({ json: {
    versions: { students: 1, tasks: 1, bookings: 1, lpItems: 1 },
    managedExamSnapshot: { versions: { students: 1, tasks: 1 }, students: [] },
    managedTrialPaymentSnapshot: null,
  } }));
  await page.goto("/#section=resources");
  await expect(page.getByRole("heading", { name: "无法读取真实资料", exact: true })).toBeVisible();
  await expect(page.getByText("managed trial payment snapshot is invalid", { exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("a changed-data refresh preserves the notice for a concurrent local edit", async ({ page }) => {
  const f = await fixture(page, false);
  const task = {
    id: "SYNTH-CONCURRENT-TASK", title: "Synthetic concurrent task", studentId: "SYNTH-STUDENT",
    owner: DEMO_ADMIN_USER, due: "today", dueAt: new Date().toISOString(),
    status: "today", tone: "blue", category: "资料", trigger: "Synthetic manual task",
  };
  f.replaceTasks([task]);
  let taskWrites = 0;
  await page.route("**/api/app-state", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    expect(route.request().postDataJSON().entity).toBe("tasks");
    taskWrites += 1;
  });
  await page.goto("/#section=dashboard");
  await expect.poll(f.versionReads).toBeGreaterThan(0);
  await page.getByRole("button", { name: "编辑备注：Synthetic concurrent task", exact: true }).click();
  await page.getByRole("textbox", { name: "任务备注", exact: true }).fill("Synthetic local note");
  await page.locator(".task-inline-editor").getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => taskWrites).toBe(1);
  f.replaceTasks([{ ...task, completionNote: "Synthetic remote note" }]);
  f.advanceTasks();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".live-sync")).toHaveText("有冲突");
  await expect(page.locator(".live-sync")).toHaveAttribute("title", /同一记录已更新，请复核/u);
  await expect(page.locator(".task-copy")).toContainText("Synthetic remote note");
  const versionReads = f.versionReads();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(f.versionReads).toBeGreaterThan(versionReads);
  await expect(page.locator(".live-sync")).toHaveText("有冲突");
  expect(taskWrites).toBe(1);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("a successful changed-data refresh clears an earlier offline notice", async ({ page }) => {
  const f = await fixture(page, false);
  await page.goto("/#section=resources");
  await expect(page.getByRole("heading", { name: "资源", exact: true })).toBeVisible();
  await expect.poll(f.versionReads).toBeGreaterThan(0);
  f.failRefresh(true);
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    return f.failedRefreshReads();
  }).toBeGreaterThan(0);
  await expect(page.locator(".live-sync")).toHaveText("离线");
  f.failRefresh(false);
  f.advanceTasks();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".live-sync")).toHaveCount(0);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

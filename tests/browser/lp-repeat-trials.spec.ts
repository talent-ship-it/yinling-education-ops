import { expect, test, type Page, type Route } from "@playwright/test";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";

const NOW = "2026-10-20T02:00:00.000Z";
const STUDENT_ID = "SYNTH-REPEAT-TRIAL-STUDENT";
type Lp = { id: string; studentId: string; title: string; workflowType: string; owner: string; stage: string; due: string; fields: Record<string, unknown>; resultStatus?: string };
type CreateCommand = { commandKey: string; operation: string; studentId: string; workflowType: string; fields: Record<string, unknown>; expectedVersions: Record<string, number> };

async function syntheticWorkspace(page: Page, options: { failThirdOnce?: boolean; completedReplay?: boolean; legacyView?: boolean } = {}) {
  const posted: CreateCommand[] = [];
  const stageWrites: Lp[][] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const receipts = new Map<string, string>();
  let unavailableSent = false;
  const student = { id: STUDENT_ID, name: "Synthetic Repeat Student", initials: "SR", guardianWechat: "Synthetic Parent", status: "试听待排", owner: "Ella", planner: "Eileen", course: "Y8 English", timezone: "Australia/Melbourne", teacher: "Teacher Example", next: "待安排", nextTone: "blue", files: 0 };
  const lpItems: Lp[] = options.completedReplay ? [{ id: "SYNTH-UNRELATED-LP", studentId: STUDENT_ID, title: "Synthetic Unrelated LP", workflowType: "试听 LP", owner: "Ella", stage: "待资料", due: "2026-10-23", fields: {} }] : [];
  if (options.legacyView) lpItems.push({ id: "SYNTH-LEGACY-LP", studentId: STUDENT_ID, title: "Synthetic Legacy LP", workflowType: "老师 LP 修改", owner: "Ella", stage: "待资料", due: "2026-10-23", fields: {} });
  const entities: Record<string, unknown[]> = {
    students: [student], teachers: [{ id: "SYNTH-TEACHER", name: "Teacher Example", initials: "TE", subjects: ["Y8 English"], timezone: "Australia/Melbourne", availability: "", load: 0, capacity: 10, acceptsStudents: true, note: "", availabilityWindows: [] }],
    tasks: [], bookings: [], courses: [], lpItems, operations: [], renewals: [], payroll: [], messages: [], files: [], audit: [],
  };
  const versions: Record<string, number> = Object.fromEntries(Object.keys(entities).map((entity) => [entity, 1]));
  const row = (entity: string) => ({ entity, payload: entities[entity], version: versions[entity], updated_at: NOW, updated_by: "synthetic" });
  const snapshots = () => ({
    managedExamSnapshot: { versions: { students: versions.students, tasks: versions.tasks }, students: [] },
    managedTrialPaymentSnapshot: { versions: { students: versions.students, tasks: versions.tasks, bookings: versions.bookings, lpItems: versions.lpItems }, students: [] },
  });
  const items = () => entities.lpItems as Lp[];
  const block = (route: Route) => {
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 403, json: { error: "Unbound synthetic request" } });
  };
  function commitTrial(body: CreateCommand) {
    const priorId = receipts.get(body.commandKey);
    const lpItemId = priorId ?? `SYNTH-REPEAT-LP-${receipts.size + 1}`;
    if (!priorId) {
      receipts.set(body.commandKey, lpItemId);
      entities.lpItems = [...items(), { id: lpItemId, studentId: STUDENT_ID, title: `Synthetic Trial LP ${receipts.size}`, workflowType: body.workflowType, owner: "Ella", stage: options.completedReplay ? "完成" : "待资料", due: "2026-10-23", fields: body.fields, resultStatus: "试听未进行" }];
      for (const entity of ["students", "lpItems", "tasks", "files"]) versions[entity]++;
    }
    return { committed: true, applied: !priorId, studentId: STUDENT_ID, lpItemId, studentsRow: row("students"), lpItemsRow: row("lpItems"), tasksRow: row("tasks"), filesRow: row("files") };
  }
  function createReply(route: Route) {
    const body = route.request().postDataJSON() as CreateCommand;
    posted.push(body);
    if (![body.operation === "create", body.studentId === STUDENT_ID, body.workflowType === "试听 LP"].every(Boolean)) return block(route);
    if (options.failThirdOnce && receipts.size === 2 && !unavailableSent) {
      unavailableSent = true;
      return route.fulfill({ status: 503, json: { error: "合成服务暂不可用；可安全重试" } });
    }
    const receipt = commitTrial(body);
    if (options.completedReplay && !unavailableSent) {
      unavailableSent = true;
      return route.fulfill({ status: 503, json: { error: "合成服务暂不可用；可安全重试" } });
    }
    return route.fulfill({ json: receipt });
  }
  function stageReply(route: Route) {
    const body = route.request().postDataJSON() as { entity: string; payload: Lp[]; expectedVersion: number };
    if (body.entity !== "lpItems" || body.expectedVersion !== versions.lpItems || !Array.isArray(body.payload)
      || JSON.stringify(body.payload.map((item) => item.id)) !== JSON.stringify(items().map((item) => item.id))) return block(route);
    stageWrites.push(structuredClone(body.payload));
    entities.lpItems = structuredClone(body.payload);
    versions.lpItems++;
    return route.fulfill({ json: { row: row("lpItems") } });
  }
  function resultReply(route: Route) {
    const body = route.request().postDataJSON() as { lpItemId: string; field: string; value: string };
    if (body.lpItemId !== "SYNTH-REPEAT-LP-1" || body.field !== "resultStatus" || body.value !== "试听失败") return block(route);
    entities.lpItems = items().map((item) => item.id === body.lpItemId ? { ...item, resultStatus: body.value } : item);
    versions.lpItems++;
    return route.fulfill({ json: { committed: true, applied: true, lpItemsRow: row("lpItems") } });
  }
  function sharedReply(url: URL) {
    if (url.searchParams.get("mode") === "versions") return { versions: Object.keys(versions).map(row) };
    return { rows: (url.searchParams.get("entities") ?? "").split(",").filter((entity) => entity in entities).map(row), ...snapshots() };
  }
  function readReply(route: Route, url: URL) {
    switch (url.pathname) {
      case "/api/demo-session": return route.fulfill({ json: { ok: true, user: "Nixon", role: "admin", mustChangePassword: false } });
      case "/api/nixon-session": return route.fulfill({ json: { ok: true } });
      case "/api/app-snapshot": return route.fulfill({ json: { ...entities, versions, ...snapshots() } });
      case "/api/app-state": return route.fulfill({ json: sharedReply(url) });
      case "/api/audit": return route.fulfill({ json: { entries: [] } });
      case "/api/operations/wecom-lp-drafts": return route.fulfill({ json: { drafts: [], nextCursor: null, total: 0 } });
      default: return route.fulfill({ status: 403, json: { error: "Unbound synthetic read" } });
    }
  }
  const mutations: Record<string, (route: Route) => Promise<void>> = {
    "POST /api/demo-logout": (route) => route.fulfill({ json: { serverSessionRevoked: true } }),
    "POST /api/operations/lp": createReply,
    "PUT /api/app-state": stageReply,
    "POST /api/operations/trial-ledger": resultReply,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return request.method() === "GET" ? route.continue() : block(route);
    const mutation = mutations[`${request.method()} ${url.pathname}`];
    if (mutation) return mutation(route);
    if (request.method() !== "GET") return block(route);
    return readReply(route, url);
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: displayPreferencesStorageKey("Nixon"), value: JSON.stringify(defaultDisplayPreferences()) });
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("/#section=lp");
  await expect(page.getByRole("region", { name: "LP 交接台账", exact: true })).toBeVisible();
  return { posted, stageWrites, unexpected, errors, items };
}

function lpView(page: Page, label: string) {
  return page.getByRole("group", { name: "LP 保存视图", exact: true }).getByRole("button", { name: new RegExp(`^${label}`, "u") });
}
function ledgerRow(page: Page, id: string) {
  return page.getByRole("region", { name: "LP 交接台账", exact: true }).locator("tbody tr:not(.trial-ledger-detail-row)")
    .filter({ has: page.locator(`button[aria-controls="trial-intake-${id}"]`) });
}
function trialStage(page: Page, title: string) {
  return page.getByRole("region", { name: `${title} 试听交接详情`, exact: true }).getByRole("combobox", { name: `${title} 当前阶段`, exact: true });
}
function trialResult(page: Page, id: string) {
  return ledgerRow(page, id).getByRole("combobox", { name: "Synthetic Repeat Student 试听状态", exact: true });
}
async function openTrialDetails(page: Page, id: string) {
  const toggle = ledgerRow(page, id).locator("button[aria-controls]");
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}
async function openCreate(page: Page, description: string) {
  await page.getByRole("button", { name: "创建 LP", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "创建 LP 工作流", exact: true });
  await dialog.locator('[name="studentId"]').fill(STUDENT_ID);
  await expect(dialog.locator("#lp-student-selection")).toContainText("Synthetic Repeat Student");
  await dialog.locator('[name="oneSentenceDescription"]').fill(description);
  return dialog;
}
async function createLp(page: Page, description: string) {
  const dialog = await openCreate(page, description);
  await dialog.getByRole("button", { name: "创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function completeLp(page: Page, id: string, title: string) {
  await openTrialDetails(page, id);
  await trialStage(page, title).selectOption("完成");
  const dialog = page.getByRole("alertdialog", { name: "确认完成 LP", exact: true });
  await dialog.getByRole("button", { name: "调整为 完成", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trialStage(page, title)).toHaveValue("完成");
  await expect(ledgerRow(page, id)).toBeVisible();
}
function assertClean(fixture: Awaited<ReturnType<typeof syntheticWorkspace>>) {
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
}

test("completed trials do not hide later trials for the same student, including a safe retry", async ({ page }) => {
  const f = await syntheticWorkspace(page, { failThirdOnce: true });
  await createLp(page, "Synthetic first trial");
  await trialResult(page, "SYNTH-REPEAT-LP-1").selectOption("试听失败");
  await expect(trialResult(page, "SYNTH-REPEAT-LP-1")).toHaveValue("试听失败");
  await completeLp(page, "SYNTH-REPEAT-LP-1", "Synthetic Trial LP 1");
  const firstCompleted = structuredClone(f.items()[0]);

  await createLp(page, "Synthetic second trial");
  await openTrialDetails(page, "SYNTH-REPEAT-LP-2");
  await expect(trialStage(page, "Synthetic Trial LP 2")).toHaveValue("待资料");
  await expect(ledgerRow(page, "SYNTH-REPEAT-LP-2")).toBeVisible();
  expect(f.items()[0]).toEqual(firstCompleted);
  await completeLp(page, "SYNTH-REPEAT-LP-2", "Synthetic Trial LP 2");
  const secondCompleted = structuredClone(f.items()[1]);

  const dialog = await openCreate(page, "Synthetic third trial");
  await dialog.getByRole("button", { name: "创建 LP", exact: true }).click();
  await expect(page.getByText("合成服务暂不可用；可安全重试", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(f.items()).toHaveLength(2);
  await dialog.getByRole("button", { name: "创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await openTrialDetails(page, "SYNTH-REPEAT-LP-3");
  await expect(trialStage(page, "Synthetic Trial LP 3")).toHaveValue("待资料");
  await expect(ledgerRow(page, "SYNTH-REPEAT-LP-3")).toBeVisible();
  expect(f.posted).toHaveLength(4);
  expect(f.posted[3]).toEqual(f.posted[2]);
  expect(new Set(f.posted.map((command) => command.commandKey)).size).toBe(3);
  expect(new Set(f.items().map((item) => item.id)).size).toBe(3);
  expect(f.items()).toHaveLength(3);
  expect(f.items()[0]).toEqual(firstCompleted);
  expect(f.items()[1]).toEqual(secondCompleted);
  expect(f.stageWrites).toHaveLength(2);
  const ledger = page.getByRole("region", { name: "LP 交接台账", exact: true });
  await ledger.getByRole("combobox", { name: "业务结果", exact: true }).selectOption("试听失败");
  await expect(ledger.locator("tbody tr:not(.trial-ledger-detail-row)")).toHaveCount(1);
  await expect(ledgerRow(page, "SYNTH-REPEAT-LP-1")).toBeVisible();
  await ledger.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(ledger.locator("tbody tr:not(.trial-ledger-detail-row)")).toHaveCount(3);
  await expect(trialResult(page, "SYNTH-REPEAT-LP-1")).toHaveValue("试听失败");
  assertClean(f);
});

test("a replay preserves the returned LP's completed stage and the unrelated waiting trial", async ({ page }) => {
  const f = await syntheticWorkspace(page, { completedReplay: true });
  const unrelated = structuredClone(f.items()[0]);
  const dialog = await openCreate(page, "Synthetic completed replay");
  await dialog.getByRole("button", { name: "创建 LP", exact: true }).click();
  await expect(page.getByText("合成服务暂不可用；可安全重试", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(ledgerRow(page, "SYNTH-REPEAT-LP-1")).toBeVisible();
  await openTrialDetails(page, "SYNTH-REPEAT-LP-1");
  await expect(trialStage(page, "Synthetic Trial LP 1")).toHaveValue("完成");
  await expect(ledgerRow(page, "SYNTH-UNRELATED-LP")).toBeVisible();
  await openTrialDetails(page, "SYNTH-UNRELATED-LP");
  await expect(trialStage(page, "Synthetic Unrelated LP")).toHaveValue("待资料");
  expect(f.items()[0]).toEqual(unrelated);
  await expect(page.getByText("LP 已确认，系统没有重复保存", { exact: true })).toBeVisible();
  expect(f.posted).toHaveLength(2);
  expect(f.posted[1]).toEqual(f.posted[0]);
  expect(f.items()).toHaveLength(2);
  expect(f.items().filter((item) => item.id === "SYNTH-REPEAT-LP-1")).toHaveLength(1);
  assertClean(f);
});

for (const view of ["全部", "等待资料/确认"]) {
  test(`a new waiting trial preserves the compatible ${view} view`, async ({ page }) => {
    const f = await syntheticWorkspace(page, { legacyView: true });
    const legacy = structuredClone(f.items()[0]);
    await lpView(page, view).click();
    await createLp(page, `Synthetic compatible ${view} trial`);
    await expect(lpView(page, view)).toHaveAttribute("aria-pressed", "true");
    await expect(ledgerRow(page, "SYNTH-REPEAT-LP-1")).toBeVisible();
    await openTrialDetails(page, "SYNTH-REPEAT-LP-1");
    await expect(trialStage(page, "Synthetic Trial LP 1")).toHaveValue("待资料");
    expect(f.items()[0]).toEqual(legacy);
    expect(f.posted).toHaveLength(1);
    assertClean(f);
  });
}

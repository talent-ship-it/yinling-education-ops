import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { buildWecomLpDraft } from "../../lib/wecom-lp-draft";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";

const NOW = "2026-10-20T02:00:00.000Z";
const SOURCE_ID = "synthetic-lp-handover-1";
const STUDENT_ID = "SYNTH-LP-STUDENT-1";
const LP_ID = "SYNTH-LP-1";
const template = `【学生姓名】：Synthetic Student
【安排教师】：Teacher Example
【安排科目】：Y8 English
【一句话描述】：Synthetic assessment practice and writing confidence.
【所在地（时区）】：VIC
【家长 Or 学生本人】：家长
【是否要指定内容】：无需指定
【是否要写作】：否
【是否发试卷、收试卷】：否
【是否提到时间】：否
【是否跟进老师备课内容】：是
【大学学生】：否
【试听时长】：1小时
【试听付费方式】：后置付费试听
【教务老师】：Ella
【课程规划老师】：Eileen
【微信名】：Synthetic Parent @教务AI助手`;

type PostedCommand = {
  commandKey: string;
  sourceMessageId: string;
  sourceRevision: string;
  studentId?: string;
  newStudent?: { guardianWechat: string; timezone: string };
  fields: Record<string, unknown>;
  expectedVersions: Record<string, number>;
};

type ScreenshotMatchRequest = {
  target: { lpItemId: string } | { caseId: string; sourceMessageId: string; sourceRevision: string };
  evidence: { sourceDate: string; startTime: string; endTime: string; teacherName: string; courseName: string; sharedAccountLetter?: string };
};
type ScreenshotConfirmation = {
  commandKey: string;
  lpItemId: string;
  eventId: string;
  sourceDate: string;
  sourceRevision: string;
  expectedVersions: { students: number; lpItems: number; tasks: number };
};

const screenshotText = `2026-10-22 19:05-20:05
课程：English - Synthetic Candidate Student试听
班级：试听学员B(校长号1)2026
老师：Synthetic Screenshot Teacher(1课时)`;

function screenshotCandidate(revision = "c".repeat(64)) {
  return {
    eventId: "jwb-open-api:schedule:synthetic-screenshot-1", sourceRevision: `sha256:${revision}`, sourceDate: "2026-10-22",
    startsAt: "2026-10-22T08:05:00.000Z", endsAt: "2026-10-22T09:05:00.000Z", teacherName: "Synthetic Screenshot Teacher",
    courseName: "English - Synthetic Candidate Student试听", studentNameHint: "Synthetic Candidate Student",
    sharedAccountLabel: "试听学员B(校长号1)2026", sharedAccountLetter: "b", durationMinutes: 60,
  };
}

function screenshotMatch(candidate = screenshotCandidate(), freshness = "fresh") {
  return {
    candidates: [candidate], ambiguous: false, hasMore: false,
    coverage: {
      complete: true, state: freshness === "fresh" ? "complete" : "stale", freshness, sourceRevision: candidate.sourceRevision,
      publishedAt: NOW, sourceWindow: { start: "2026-10-20", end: "2026-10-30" },
      requestedWindow: { startsAt: "2026-10-21T13:00:00.000Z", endsAt: "2026-10-22T13:00:00.000Z" }, timeZone: "Australia/Melbourne",
    },
  };
}

function source(text = template, revision = "a".repeat(64), matched = false) {
  const messages = [{ messageId: SOURCE_ID, text, sentAt: NOW }];
  const draft = buildWecomLpDraft(messages);
  return {
    id: SOURCE_ID, sourceMessageId: SOURCE_ID, caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: revision,
    wechatName: "Synthetic Parent", studentName: draft.studentName, operationsOwner: "Ella", coursePlanner: "Eileen",
    status: draft.studentName ? "identified" : "awaiting_student_name", createdAt: NOW, messages,
    confirmed: null, draft, matchedStudentId: matched ? STUDENT_ID : null,
  };
}

type SourcePage = { drafts: unknown[]; nextCursor: string | null; total: number };
type WorkspaceOptions = {
  text?: string;
  matched?: boolean;
  postStatuses?: number[];
  sourcePage?: (url: URL) => SourcePage | Promise<SourcePage>;
  screenshotMatches?: ReturnType<typeof screenshotMatch>[];
  screenshotConfirmStatuses?: number[];
  lpItems?: unknown[];
  unclosedTasks?: unknown[];
};

async function syntheticWorkspace(page: Page, options: WorkspaceOptions = {}) {
  let draftSource = source(options.text, undefined, options.matched);
  let committed = false;
  const posted: PostedCommand[] = [];
  const reads: URL[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const requests: { url: URL; method: string }[] = [];
  const screenshotReads: ScreenshotMatchRequest[] = [];
  const screenshotPosted: ScreenshotConfirmation[] = [];
  const student = {
    id: STUDENT_ID, name: options.matched ? "Synthetic Student" : "Synthetic Existing Student", initials: "SS",
    guardianWechat: options.matched ? "Synthetic Parent" : "Synthetic Other Parent", status: "试听待排", owner: "Ella", planner: "Eileen",
    course: "Y8 English", timezone: "Australia/Melbourne", teacher: "Teacher Example", next: "待安排", nextTone: "blue", files: 0,
  };
  const entities: Record<string, unknown> = {
    students: [student], teachers: [{ id: "SYNTH-LP-TEACHER-1", name: "Teacher Example", initials: "TE", subjects: ["Y8 English"], timezone: "Australia/Melbourne", availability: "", load: 0, capacity: 10, acceptsStudents: true, note: "", availabilityWindows: [] }],
    tasks: [], bookings: [], courses: [], lpItems: options.lpItems ?? [], operations: [], renewals: [], payroll: [], messages: [], files: [], audit: [],
  };
  const versions: Record<string, number> = Object.fromEntries(Object.keys(entities).map((entity) => [entity, 1]));
  const snapshots = () => ({
    managedExamSnapshot: { versions: { students: versions.students, tasks: versions.tasks }, students: [] },
    managedTrialPaymentSnapshot: { versions: { students: versions.students, tasks: versions.tasks, bookings: versions.bookings, lpItems: versions.lpItems }, students: [] },
  });
  const row = (entity: string) => ({ entity, payload: entities[entity] ?? [], version: versions[entity] ?? 1, updated_at: NOW, updated_by: "synthetic" });
  page.on("pageerror", (error) => errors.push(error.message));
  function committedReply(body: PostedCommand) {
    const selectedId = body.studentId ?? "SYNTH-LP-NEW-STUDENT";
    if (body.newStudent) entities.students = [...entities.students as unknown[], { ...student, id: selectedId, name: body.fields.studentName, guardianWechat: body.newStudent.guardianWechat, timezone: body.newStudent.timezone }];
    entities.lpItems = [...entities.lpItems as unknown[], { id: LP_ID, studentId: selectedId, title: "Synthetic Trial LP", workflowType: "试听 LP", owner: "Ella", stage: "待资料", due: "2026-10-23", fields: body.fields }];
    for (const entity of ["students", "lpItems", "tasks", "files"]) versions[entity]++;
    committed = true;
    return { committed: true, applied: true, studentId: selectedId, lpItemId: LP_ID, studentsRow: row("students"), lpItemsRow: row("lpItems"), tasksRow: row("tasks"), filesRow: row("files") };
  }
  async function sourceReadReply(route: Route) {
    const url = new URL(route.request().url());
    reads.push(url);
    if (options.sourcePage) return route.fulfill({ json: await options.sourcePage(url) });
    const confirmed = committed ? { studentId: STUDENT_ID, lpItemId: LP_ID } : null;
    return route.fulfill({ json: { drafts: [{ ...draftSource, confirmed }], nextCursor: null, total: 1 } });
  }
  function sourceReply(route: Route) {
    if (route.request().method() === "GET") return sourceReadReply(route);
    const body = route.request().postDataJSON() as PostedCommand;
    posted.push(body);
    const status = options.postStatuses?.[posted.length - 1] ?? 200;
    if (status === 409) {
      draftSource = source(template.replace("Y8 English", "Y8 Mathematics"), "b".repeat(64), options.matched);
      return route.fulfill({ status, json: { error: "交接来源已变化，请刷新草稿。", code: "draft_conflict" } });
    }
    if (status !== 200) return route.fulfill({ status, json: { error: "合成服务暂不可用", code: "unavailable" } });
    return route.fulfill({ json: committedReply(body) });
  }
  function sharedStateReply(url: URL) {
    if (url.searchParams.get("mode") === "versions") return { versions: Object.keys(versions).map(row) };
    const requested = (url.searchParams.get("entities") ?? "").split(",");
    return { rows: requested.filter((entity) => entity in entities).map(row), ...snapshots() };
  }
  function screenshotConfirmationReply(route: Route) {
    screenshotPosted.push(route.request().postDataJSON() as ScreenshotConfirmation);
    const status = options.screenshotConfirmStatuses?.[screenshotPosted.length - 1] ?? 200;
    if (status !== 200) return route.fulfill({ status, json: { error: status === 409 ? "合成课表来源已变化，请重新核对。" : "合成小课表服务暂不可用", code: status === 409 ? "source_changed" : "unavailable" } });
    versions.lpItems++;
    versions.tasks++;
    return route.fulfill({ json: { committed: true, applied: true, lpItemsRow: row("lpItems"), tasksRow: row("tasks") } });
  }
  function screenshotReply(route: Route, url: URL) {
    if (url.pathname === "/api/operations/trial-screenshot-confirm") return screenshotConfirmationReply(route);
    screenshotReads.push(route.request().postDataJSON() as ScreenshotMatchRequest);
    return route.fulfill({ json: options.screenshotMatches?.[screenshotReads.length - 1] ?? screenshotMatch() });
  }
  function readReply(route: Route, url: URL) {
    switch (url.pathname) {
      case "/api/demo-session": return route.fulfill({ json: { ok: true, user: "Nixon", role: "admin", mustChangePassword: false } });
      case "/api/nixon-session": return route.fulfill({ json: { ok: true } });
      case "/api/app-snapshot": return route.fulfill({ json: { ...entities, versions, ...snapshots() } });
      case "/api/app-state": return route.fulfill({ json: sharedStateReply(url) });
      case "/api/audit": return route.fulfill({ json: { entries: [] } });
      case "/api/jiaowubao-open-api/unclosed-tasks": return route.fulfill({ json: { tasks: options.unclosedTasks ?? [] } });
      default: return route.fulfill({ status: 403, json: { error: "Unbound synthetic read" } });
    }
  }
  await page.context().route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ url, method: request.method() });
    if (url.hostname !== "127.0.0.1") { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/demo-logout") return route.fulfill({ json: { serverSessionRevoked: true } });
    if (url.pathname === "/api/operations/wecom-lp-drafts") return sourceReply(route);
    if (request.method() === "POST" && ["/api/operations/trial-screenshot-match", "/api/operations/trial-screenshot-confirm"].includes(url.pathname)) return screenshotReply(route, url);
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 403, json: { error: "Unbound synthetic write" } });
    }
    return readReply(route, url);
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: displayPreferencesStorageKey("Nixon"), value: JSON.stringify(defaultDisplayPreferences()) });
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("/#section=lp");
  await expect(page.getByRole("heading", { name: "机器人交接草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /核对并创建 LP/u }).first()).toBeVisible();
  return { posted, reads, errors, unexpected, requests, screenshotReads, screenshotPosted, entities };
}

async function openDraft(page: Page) {
  await page.getByRole("button", { name: /核对并创建 LP/u }).click();
  const dialog = page.getByRole("dialog", { name: "核对机器人交接", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function assertClean(fixture: Awaited<ReturnType<typeof syntheticWorkspace>>) {
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
}

test("new student's received handover prefills the review and confirms one LP", async ({ page }) => {
  const f = await syntheticWorkspace(page);
  const dialog = await openDraft(page);
  await expect(dialog.getByRole("combobox", { name: "学生档案", exact: true })).toHaveValue("new");
  await expect(dialog.getByLabel("家长微信名", { exact: true })).toHaveValue("Synthetic Parent");
  await expect(dialog.getByRole("combobox", { name: "学生时区", exact: true })).toHaveValue("Australia/Melbourne");
  await expect(dialog.locator('[name="assignedTeacher"]')).toHaveValue("Teacher Example");
  await expect(dialog.locator('[name="subject"]')).toHaveValue("Y8 English");
  await expect(dialog.locator('[name="studentName"]')).toHaveValue("Synthetic Student");
  await expect(dialog.locator('[name="writingRequired"]')).toHaveValue("否");
  await expect(dialog.locator('[name="trialDurationMinutes"]')).toHaveValue("60");
  await expect(dialog.locator('[name="trialPaymentMethod"]')).toHaveValue("后置付费试听");
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0]).toMatchObject({
    sourceMessageId: SOURCE_ID, sourceRevision: "a".repeat(64),
    newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" },
    fields: { studentNameKnown: true, studentName: "Synthetic Student", subject: "Y8 English", assignedTeacher: "Teacher Example", responsibleOperations: "Ella", planner: "Eileen", trialDurationMinutes: 60, writingRequired: false, paperRequired: false, requestSentAt: NOW },
    expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 },
  });
  expect(f.posted[0].studentId).toBeUndefined();
  await expect(page.getByRole("button", { name: "Synthetic Student 已创建 LP", exact: true })).toBeDisabled();
  await expect(page.getByText("交接已确认，学生档案、LP 和待办已保存", { exact: true })).toBeVisible();
  assertClean(f);
});

test("matched handover leaves the completed view to show the new LP for the existing student", async ({ page }) => {
  const historicalLp = {
    id: "SYNTH-LP-HISTORY", studentId: STUDENT_ID, title: "Synthetic Historical LP", workflowType: "老师新 LP",
    owner: "Ella", stage: "完成", due: "2026-10-01", revisionNumber: 2,
    fields: { subject: "Y8 English", teacher: "Synthetic Previous Teacher", documentUrl: "https://docs.example.invalid/historical-lp" },
  };
  const f = await syntheticWorkspace(page, { matched: true, lpItems: [structuredClone(historicalLp)] });
  const views = page.getByRole("group", { name: "LP 保存视图", exact: true });
  await views.getByRole("button", { name: /^已完成/u }).click();
  const dialog = await openDraft(page);
  await expect(dialog.getByRole("combobox", { name: "学生档案", exact: true })).toHaveValue("existing");
  await expect(dialog.getByRole("textbox", { name: "搜索学生姓名", exact: true })).toHaveValue("Synthetic Student");
  await expect(dialog.getByLabel("家长微信名", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0].studentId).toBe(STUDENT_ID);
  expect(f.posted[0].newStudent).toBeUndefined();
  await expect(views.getByRole("button", { name: /^进行中/u })).toHaveAttribute("aria-pressed", "true");
  const details = await openTrialDetails(page, "Synthetic Trial LP");
  await expect(details.getByRole("combobox", { name: "Synthetic Trial LP 当前阶段", exact: true })).toHaveValue("待资料");
  expect(f.entities.lpItems).toHaveLength(2);
  expect(f.entities.lpItems).toContainEqual(historicalLp);
  await views.getByRole("button", { name: /^已完成/u }).click();
  await expect(page.getByRole("combobox", { name: "Synthetic Historical LP 当前阶段", exact: true })).toHaveValue("完成");
  await expect(trialLedgerRow(page, LP_ID)).toBeVisible();
  assertClean(f);
});

test("missing handover choices remain empty and cannot be silently confirmed", async ({ page }) => {
  const f = await syntheticWorkspace(page, { text: "【安排教师】：Teacher Example\n【安排科目】：Y8 English\n【教务老师】：Ella\n【微信名】：Synthetic Parent" });
  const dialog = await openDraft(page);
  for (const name of ["planner", "studentNameKnown", "writingRequired", "paperRequired", "timeMentioned", "trialDurationMinutes", "trialPaymentMethod", "specifiedContentStatus", "preparationFollowUp"]) await expect(dialog.locator(`[name="${name}"]`)).toHaveValue("");
  await expect(dialog.locator('[name="contactParents"]')).not.toBeChecked();
  await expect(dialog.locator('[name="contactStudent"]')).not.toBeChecked();
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).checkValidity())).toBe(false);
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("source conflict closes the stale form and reopening uses the latest revision", async ({ page }) => {
  const f = await syntheticWorkspace(page, { postStatuses: [409] });
  const dialog = await openDraft(page);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(/请重新打开最新草稿核对/u)).toBeVisible();
  const updated = await openDraft(page);
  await expect(updated.locator('[name="subject"]')).toHaveValue("Y8 Mathematics");
  await updated.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(updated).not.toBeVisible();
  expect(f.posted).toHaveLength(2);
  expect(f.posted.map((body) => body.sourceRevision)).toEqual(["a".repeat(64), "b".repeat(64)]);
  expect(f.posted[1].fields.subject).toBe("Y8 Mathematics");
  expect(f.posted[1].commandKey).not.toBe(f.posted[0].commandKey);
  assertClean(f);
});

test("retry after a temporary failure preserves the exact command UUID and input", async ({ page }) => {
  const f = await syntheticWorkspace(page, { postStatuses: [503] });
  const dialog = await openDraft(page);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(page.getByText("合成服务暂不可用", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认并创建 LP", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(2);
  expect(f.posted[0].commandKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(f.posted[1]).toEqual(f.posted[0]);
  assertClean(f);
});

function screenshotImport(dialog: Locator) {
  return dialog.getByRole("region", { name: "教务宝排课截图导入", exact: true });
}

async function parseScreenshot(dialog: Locator, text = screenshotText) {
  const region = screenshotImport(dialog);
  await region.getByRole("textbox", { name: "识别文字（可修正）", exact: true }).fill(text);
  await region.getByRole("button", { name: "解析并核对教务宝", exact: true }).click();
  await expect(region.getByRole("radio")).toHaveCount(1);
  await expect(region.getByRole("radio")).not.toBeChecked();
  return region;
}

async function handoverValues(dialog: Locator) {
  const fields = ["assignedTeacher", "studentName", "studentNameKnown", "trialDurationMinutes", "subject", "requestSentAt", "writingRequired", "paperRequired", "timeMentioned", "trialPaymentMethod", "planner", "locationTimezone"];
  return Object.fromEntries(await Promise.all(fields.map(async (field) => [field, await dialog.locator(`[name="${field}"]`).inputValue()])));
}

function trialLedgerRow(page: Page, id: string) {
  return page.getByRole("region", { name: "LP 交接台账", exact: true }).locator("tbody tr:not(.trial-ledger-detail-row)")
    .filter({ has: page.locator(`button[aria-controls="trial-intake-${id}"]`) });
}

async function openTrialDetails(page: Page, title: string, id = LP_ID) {
  const row = trialLedgerRow(page, id);
  await expect(row).toBeVisible();
  const toggle = row.locator("button[aria-controls]");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const details = page.getByRole("region", { name: `${title} 试听交接详情`, exact: true });
  await expect(details.getByRole("combobox", { name: `${title} 当前阶段`, exact: true })).toBeVisible();
  return details;
}

async function createSyntheticLp(page: Page) {
  const dialog = await openDraft(page);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trialLedgerRow(page, LP_ID)).toBeVisible();
  await expect(trialLedgerRow(page, LP_ID)).toHaveCount(1);
}

async function openScreenshotConfirmation(page: Page) {
  const details = await openTrialDetails(page, "Synthetic Trial LP");
  await details.getByRole("button", { name: "补全教务宝小课表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "补全教务宝小课表", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a synthetic PNG is recognized by the real local OCR worker with no external upload", async ({ page }) => {
  const workerUrls: string[] = [];
  page.on("worker", (worker) => workerUrls.push(worker.url()));
  test.setTimeout(120_000);
  const f = await syntheticWorkspace(page);
  const dialog = await openDraft(page);
  const region = screenshotImport(dialog);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1400; canvas.height = 450;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black"; context.font = "80px monospace";
    context.fillText("2026-10-22", 80, 160);
    context.fillText("19:05-20:05", 80, 310);
    return canvas.toDataURL("image/png");
  });
  await region.getByLabel("截图文件（本地识别，最多 3 MB）", { exact: true }).setInputFiles({ name: "synthetic-schedule.png", mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1]!, "base64") });
  const text = region.getByRole("textbox", { name: "识别文字（可修正）", exact: true });
  await expect(text).toHaveValue(/2026-10-22/u, { timeout: 90_000 });
  await expect(text).toHaveValue(/19:05\s*[-–—]\s*20:05/u);
  await expect(text).toBeEnabled();
  const assets = f.requests.filter(({ url }) => url.pathname.startsWith("/trial-ocr/"));
  expect(assets.map(({ url }) => url.pathname)).toEqual(expect.arrayContaining([
    "/trial-ocr/v7/tesseract.min.js", "/trial-ocr/v7/lang/eng.traineddata.gz", "/trial-ocr/v7/lang/chi_sim.traineddata.gz",
  ]));
  expect(workerUrls).toContain(`${new URL(page.url()).origin}/trial-screenshot-ocr.worker.js`);
  expect(assets.some(({ url }) => /^\/trial-ocr\/v7\/core\/tesseract-core.*\.wasm(?:\.js)?$/u.test(url.pathname))).toBe(true);
  expect(new Set(assets.map(({ url }) => url.origin))).toEqual(new Set([new URL(page.url()).origin]));
  expect(f.requests.filter(({ method, url }) => method !== "GET" && url.pathname !== "/api/demo-logout")).toEqual([]);
  expect(f.screenshotReads).toEqual([]); expect(f.screenshotPosted).toEqual([]); expect(f.posted).toEqual([]);
  assertClean(f);
});

test("reviewed screenshot candidates only replace checked fields and preserve the LP confirmation contract", async ({ page }) => {
  const candidate = { ...screenshotCandidate(), endsAt: "2026-10-22T08:50:00.000Z", durationMinutes: 45 };
  const f = await syntheticWorkspace(page, { screenshotMatches: [screenshotMatch(candidate)] });
  const dialog = await openDraft(page);
  const before = await handoverValues(dialog);
  const preferences = await page.evaluate((key) => localStorage.getItem(key), displayPreferencesStorageKey("Nixon"));
  const region = await parseScreenshot(dialog, screenshotText.replace("20:05", "19:50"));
  const apply = region.getByRole("button", { name: "填入待核对表单", exact: true });
  await expect(apply).toBeDisabled();
  expect(await handoverValues(dialog)).toEqual(before);
  await region.getByRole("radio", { name: `选择课节：${candidate.courseName} · ${candidate.teacherName}`, exact: true }).check();
  for (const field of ["填入老师", "填入学生姓名", "填入试听时长（分钟）"]) await expect(region.getByRole("checkbox", { name: field, exact: true })).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await region.getByRole("checkbox", { name: "填入老师", exact: true }).check();
  expect(await handoverValues(dialog)).toEqual(before);
  expect(f.posted).toEqual([]); expect(f.screenshotPosted).toEqual([]);
  await apply.click();
  expect(await handoverValues(dialog)).toEqual({ ...before, assignedTeacher: candidate.teacherName });
  expect(await page.evaluate((key) => localStorage.getItem(key), displayPreferencesStorageKey("Nixon"))).toBe(preferences);
  expect(f.screenshotReads).toEqual([{
    target: { caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceMessageId: SOURCE_ID, sourceRevision: "a".repeat(64) },
    evidence: { sourceDate: "2026-10-22", startTime: "19:05", endTime: "19:50", teacherName: candidate.teacherName, courseName: candidate.courseName, sharedAccountLetter: "b" },
  }]);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0]).toMatchObject({
    sourceMessageId: SOURCE_ID, sourceRevision: "a".repeat(64), newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" },
    fields: { studentName: "Synthetic Student", assignedTeacher: candidate.teacherName, subject: "Y8 English", trialDurationMinutes: 60, writingRequired: false, paperRequired: false, timeMentioned: false, requestSentAt: NOW, planner: "Eileen" },
    expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 },
  });
  expect(f.posted[0]).not.toHaveProperty("eventId");
  expect(f.screenshotPosted).toEqual([]);
  assertClean(f);
});

test("an existing synthetic LP needs a manually selected fresh source and retries the same confirmation after 503", async ({ page }) => {
  const candidate = screenshotCandidate();
  const f = await syntheticWorkspace(page, { matched: true, screenshotMatches: [screenshotMatch(candidate, "stale"), screenshotMatch(candidate)], screenshotConfirmStatuses: [503] });
  await createSyntheticLp(page);
  const dialog = await openScreenshotConfirmation(page);
  let region = await parseScreenshot(dialog);
  const confirm = region.getByRole("button", { name: "确认补全交接与排课", exact: true });
  await expect(confirm).toBeDisabled();
  await region.getByRole("radio").check();
  await expect(confirm).toBeDisabled();
  expect(f.screenshotPosted).toEqual([]);
  region = await parseScreenshot(dialog, `${screenshotText}\n`);
  await expect(confirm).toBeDisabled();
  await region.getByRole("radio").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText("合成小课表服务暂不可用", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  expect(f.screenshotReads.map(({ target }) => target)).toEqual([{ lpItemId: LP_ID }, { lpItemId: LP_ID }]);
  expect(f.screenshotPosted).toHaveLength(2);
  expect(f.screenshotPosted[0]).toEqual({
    commandKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    lpItemId: LP_ID, eventId: candidate.eventId, sourceDate: candidate.sourceDate, sourceRevision: candidate.sourceRevision,
    expectedVersions: { students: 2, lpItems: 2, tasks: 2 },
  });
  expect(f.screenshotPosted[1]).toEqual(f.screenshotPosted[0]);
  expect(f.posted).toHaveLength(1);
  await expect(page.getByText("试听交接、排课和相关待办已补全", { exact: true })).toBeVisible();
  assertClean(f);
});

test("a source conflict closes LP supplementation and reopening requires a new reviewed source", async ({ page }) => {
  const first = screenshotCandidate();
  const fresh = screenshotCandidate("d".repeat(64));
  const f = await syntheticWorkspace(page, { matched: true, screenshotMatches: [screenshotMatch(first), screenshotMatch(fresh)], screenshotConfirmStatuses: [409] });
  await createSyntheticLp(page);
  const dialog = await openScreenshotConfirmation(page);
  const region = await parseScreenshot(dialog);
  await region.getByRole("radio").check();
  await region.getByRole("button", { name: "确认补全交接与排课", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("合成课表来源已变化，请重新核对。", { exact: true })).toBeVisible();
  const reopened = await openScreenshotConfirmation(page);
  await expect(screenshotImport(reopened).getByRole("button", { name: "确认补全交接与排课", exact: true })).toBeDisabled();
  await expect(screenshotImport(reopened).getByRole("radio")).toHaveCount(0);
  const updated = await parseScreenshot(reopened);
  await expect(updated.getByRole("button", { name: "确认补全交接与排课", exact: true })).toBeDisabled();
  await updated.getByRole("radio").check();
  await updated.getByRole("button", { name: "确认补全交接与排课", exact: true }).click();
  await expect(reopened).not.toBeVisible();
  expect(f.screenshotPosted).toHaveLength(2);
  expect(f.screenshotPosted.map(({ sourceRevision }) => sourceRevision)).toEqual([first.sourceRevision, fresh.sourceRevision]);
  expect(f.screenshotPosted[1].commandKey).not.toBe(f.screenshotPosted[0].commandKey);
  expect(f.screenshotPosted[1]).toMatchObject({ lpItemId: LP_ID, eventId: fresh.eventId, sourceDate: "2026-10-22", expectedVersions: { students: 2, lpItems: 2, tasks: 2 } });
  expect(f.posted).toHaveLength(1);
  assertClean(f);
});


for (const width of [1280, 390]) {
  test(`unclosed lesson details toggle with pointer and keyboard at ${width}px without changing tasks`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await syntheticWorkspace(page, { unclosedTasks: [{
      id: "SYNTH-UNCLOSED", ruleKey: "jiaowubao.unclosed", title: "【未结课】<未匹配教务> <2 节>",
      owner: "", studentId: "SYNTH-UNCLOSED", category: "课后", status: "today", tone: "amber",
      due: "今天", dueAt: NOW, trigger: "2026-10-18 · 12345\n2026-10-19 · 12346",
    }] });
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    const toggle = page.getByRole("button", { name: "课节明细（日期 · 编号）", exact: true });
    const lessons = page.locator(".task-lesson-details ul");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(lessons).toBeHidden();
    expect(await toggle.evaluate((button) => Boolean(button.parentElement?.closest("button")))).toBe(false);
    const section = new URL(page.url()).hash;
    const requestsBeforeToggle = f.requests.length;
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(lessons).toBeVisible();
    await expect(lessons.locator("li")).toHaveText(["2026-10-18 · 12345", "2026-10-19 · 12346"]);
    await toggle.press("Enter");
    await expect(lessons).toBeHidden();
    await toggle.press("Space");
    await expect(lessons).toBeVisible();
    const reads = f.requests.filter(({ url }) => url.pathname === "/api/jiaowubao-open-api/unclosed-tasks").length;
    await page.clock.fastForward(60_000);
    await expect.poll(() => f.requests.filter(({ url }) => url.pathname === "/api/jiaowubao-open-api/unclosed-tasks").length).toBeGreaterThan(reads);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(lessons).toBeVisible();
    expect(new URL(page.url()).hash).toBe(section);
    expect(f.requests.slice(requestsBeforeToggle).filter(({ method }) => method !== "GET")).toEqual([]);
    assertClean(f);
  });
}

function timedSource(id: string, name: string, sentAt: string, confirmed = false) {
  const initial = source(template.replace("Synthetic Student", name));
  return {
    ...initial, id, sourceMessageId: id, createdAt: NOW, handoverAt: sentAt,
    messages: [{ messageId: id, text: template, sentAt }],
    confirmed: confirmed ? { studentId: STUDENT_ID, lpItemId: LP_ID } : null,
  };
}

const earliest = timedSource("synthetic-earliest", "Synthetic Earlier", "2026-10-19T15:00:00.000Z");
const midnight = timedSource("synthetic-midnight", "Synthetic Midnight", "2026-10-19T16:00:00.000Z");
const latest = { ...timedSource("synthetic-latest", "Synthetic Latest", "2026-10-20T15:59:00.000Z", true), handoverAt: undefined };

function rangePage(url: URL): SourcePage {
  if (!url.searchParams.has("from")) return url.searchParams.has("cursor")
    ? { drafts: [midnight, latest], nextCursor: null, total: 3 }
    : { drafts: [earliest], nextCursor: "all-next", total: 3 };
  if (url.searchParams.has("cursor")) return { drafts: [latest], nextCursor: null, total: 2 };
  return { drafts: [midnight], nextCursor: "day-next", total: 2 };
}

function draftPanel(page: Page) {
  return page.getByRole("region", { name: "机器人交接草稿", exact: true });
}

async function filterDay(page: Page, from = "2026-10-20", to = from) {
  const panel = draftPanel(page);
  await panel.getByLabel("开始日期", { exact: true }).fill(`${from}T00:00`);
  await panel.getByLabel("结束日期", { exact: true }).fill(`${to}T23:59`);
  await panel.getByRole("button", { name: "筛选", exact: true }).click();
}

function queryOf(url: URL) {
  return Object.fromEntries(url.searchParams);
}

test("the ledger request range also filters robot handovers and resets their pagination", async ({ page }) => {
  const f = await syntheticWorkspace(page, {
    sourcePage: rangePage,
    lpItems: [{ id: LP_ID, studentId: STUDENT_ID, title: "Synthetic Existing LP", workflowType: "试听 LP",
      owner: "Ella", stage: "待资料", due: "2026-08-31", requestedAt: "2026-08-28T01:14:00.000Z" }],
  });
  const ledger = page.getByRole("region", { name: "LP 交接台账", exact: true });
  const panel = draftPanel(page);
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(3);
  await ledger.getByLabel("需求时间从（北京时间）", { exact: true }).fill("2026-10-20T00:00");
  await ledger.getByLabel("需求时间至（北京时间）", { exact: true }).fill("2026-10-20T23:59");
  await expect(ledger.locator("tbody tr")).toHaveCount(0);
  await expect(panel.getByText("Synthetic Midnight", { exact: true })).toBeVisible();
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  await expect(panel.getByLabel("开始日期", { exact: true })).toHaveValue("2026-10-20T00:00");
  await expect(panel.getByLabel("结束日期", { exact: true })).toHaveValue("2026-10-20T23:59");
  const handoverResults = ledger.getByRole("button", { name: "机器人交接：2 条", exact: true });
  await expect(ledger.getByRole("status", { name: "交接筛选结果", exact: true })).toContainText("已创建 LP：0 条");
  await handoverResults.click();
  await expect(panel.getByRole("heading", { name: "机器人交接草稿", exact: true })).toBeFocused();
  expect(await panel.locator("h2").evaluate((heading) => heading.getBoundingClientRect().top >= document.querySelector(".topbar")!.getBoundingClientRect().bottom)).toBe(true);
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59" });
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(2);
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59", cursor: "day-next" });
  await panel.getByRole("button", { name: "清除", exact: true }).click();
  await expect(ledger.getByLabel("需求时间从（北京时间）", { exact: true })).toHaveValue("");
  await expect(ledger.getByLabel("需求时间至（北京时间）", { exact: true })).toHaveValue("");
  await expect(ledger.locator("tbody tr")).toHaveCount(1);
  await filterDay(page);
  await expect(ledger.getByLabel("需求时间从（北京时间）", { exact: true })).toHaveValue("2026-10-20T00:00");
  await ledger.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(panel.getByLabel("开始日期", { exact: true })).toHaveValue("");
  await expect(panel.getByText("Synthetic Earlier", { exact: true })).toBeVisible();
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai" });
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("shared handover search and small-timetable filters work without any created LP", async ({ page }) => {
  const missing = timedSource("synthetic-no-schedule", "Synthetic Missing Schedule", "2026-10-20T02:00:00.000Z");
  const matched = { ...timedSource("synthetic-with-schedule", "Synthetic With Schedule", "2026-10-20T03:00:00.000Z"),
    trialSchedule: { source: "jiaowubao-open-api", eventId: "synthetic-event", startsAt: "2026-10-22T08:00:00.000Z", endsAt: "2026-10-22T09:00:00.000Z",
      courseName: "Synthetic English", studentName: "Synthetic With Schedule", teacherName: "Synthetic Teacher", teacherId: null, plannerHint: null, matchedAt: NOW } };
  const f = await syntheticWorkspace(page, { sourcePage: (url) => {
    const rows = url.searchParams.get("scheduleMatch") === "unmatched" ? [missing]
      : url.searchParams.get("scheduleMatch") === "matched" ? [matched] : [missing, matched];
    const drafts = url.searchParams.get("query") === "Missing" ? rows.filter((row) => row.id === missing.id) : rows;
    return { drafts, total: drafts.length, nextCursor: null };
  } });
  const ledger = page.getByRole("region", { name: "LP 交接台账", exact: true });
  const panel = draftPanel(page);
  const search = ledger.getByRole("searchbox", { name: "搜索", exact: true });
  const schedule = ledger.getByRole("combobox", { name: "课表匹配", exact: true });
  await expect(search).toBeVisible();
  await expect(ledger.getByRole("button", { name: "机器人交接：2 条", exact: true })).toBeVisible();
  await schedule.selectOption("unmatched");
  await search.fill("Missing");
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  await expect(panel.getByLabel("搜索交接", { exact: true })).toHaveValue("Missing");
  await expect(panel.getByRole("combobox", { name: "课表匹配", exact: true })).toHaveValue("unmatched");
  await expect(ledger.getByRole("button", { name: "机器人交接：1 条", exact: true })).toBeVisible();
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", query: "Missing", scheduleMatch: "unmatched" });
  await filterDay(page);
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59", query: "Missing", scheduleMatch: "unmatched" });
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  expect(f.reads.at(-1)!.searchParams.get("scheduleMatch")).toBe("unmatched");
  await panel.getByLabel("搜索交接", { exact: true }).fill("");
  await panel.getByRole("combobox", { name: "课表匹配", exact: true }).selectOption("matched");
  await panel.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(schedule).toHaveValue("matched");
  await expect(panel.getByText("Synthetic With Schedule", { exact: true })).toBeVisible();
  await expect(panel.getByText("Synthetic Missing Schedule", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(schedule).toHaveValue("matched");
  await expect(panel.getByLabel("开始日期", { exact: true })).toHaveValue("2026-10-20T00:00");
  await ledger.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(2);
  await expect(panel.getByRole("combobox", { name: "课表匹配", exact: true })).toHaveValue("all");
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await expect(panel.getByRole("combobox", { name: "课表匹配", exact: true })).toBeVisible();
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("small-timetable pagination retains search and date filters and resets when the filter changes", async ({ page }) => {
  const f = await syntheticWorkspace(page, { sourcePage: rangePage });
  const ledger = page.getByRole("region", { name: "LP 交接台账", exact: true });
  const panel = draftPanel(page);
  await filterDay(page);
  await ledger.getByRole("searchbox", { name: "搜索", exact: true }).fill("Synthetic");
  await ledger.getByRole("combobox", { name: "课表匹配", exact: true }).selectOption("unmatched");
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(2);
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59", query: "Synthetic", scheduleMatch: "unmatched", cursor: "day-next" });
  await ledger.getByRole("combobox", { name: "课表匹配", exact: true }).selectOption("matched");
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  expect(f.reads.at(-1)!.searchParams.has("cursor")).toBe(false);
  expect(f.reads.at(-1)!.searchParams.get("scheduleMatch")).toBe("matched");
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("date range paginates with the same timezone and refresh or clear resets its cursor", async ({ page }) => {
  const f = await syntheticWorkspace(page, { sourcePage: rangePage });
  const panel = draftPanel(page);
  expect(queryOf(f.reads[0])).toEqual({ timezone: "Asia/Shanghai" });
  await expect(panel.getByText("时区：北京时间（中国）（Asia/Shanghai）", { exact: true })).toBeVisible();
  await filterDay(page);
  await expect(panel.getByRole("button", { name: "Synthetic Midnight 核对并创建 LP", exact: true })).toBeVisible();
  await expect(panel.getByText("Synthetic Earlier", { exact: true })).toHaveCount(0);
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59" });
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Synthetic Latest 已创建 LP", exact: true })).toBeDisabled();
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59", cursor: "day-next" });
  await expect(panel.locator("time")).toHaveText([/20\/10\/2026.*00:00/u, /20\/10\/2026.*23:59/u]);
  expect(await panel.locator("time").evaluateAll((times) => times.map((time) => time.getAttribute("datetime")))).toEqual([midnight.handoverAt, latest.messages[0].sentAt]);
  await expect(panel.getByText("2 条", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59" });
  await panel.getByRole("button", { name: "清除", exact: true }).click();
  await expect(panel.getByText("Synthetic Earlier", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("开始日期", { exact: true })).toHaveValue("");
  await expect(panel.getByLabel("结束日期", { exact: true })).toHaveValue("");
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai" });
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.locator("time")).toHaveText([/19\/10\/2026.*23:00/u, /20\/10\/2026.*00:00/u, /20\/10\/2026.*23:59/u]);
  await expect(panel.getByRole("button", { name: "Synthetic Latest 已创建 LP", exact: true })).toBeDisabled();
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", cursor: "all-next" });
  assertClean(f);
});

test("an inverted date range shows an error without requesting or replacing the current page", async ({ page }) => {
  const f = await syntheticWorkspace(page, { sourcePage: rangePage });
  const count = f.reads.length;
  await filterDay(page, "2026-10-21", "2026-10-20");
  await expect(draftPanel(page).getByRole("alert")).toHaveText("开始日期不能晚于结束日期");
  await expect(draftPanel(page).getByText("Synthetic Earlier", { exact: true })).toBeVisible();
  expect(f.reads).toHaveLength(count);
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("applying a range discards an older page that resolves after the filter changed", async ({ page }) => {
  let release: (value: SourcePage) => void = () => {};
  let released = false;
  const delayed = new Promise<SourcePage>((resolve) => { release = resolve; });
  async function delayedPage(url: URL) {
    if (url.searchParams.get("cursor") !== "all-next") return rangePage(url);
    const result = await delayed;
    released = true;
    return result;
  }
  const f = await syntheticWorkspace(page, { sourcePage: delayedPage });
  const panel = draftPanel(page);
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect.poll(() => f.reads.at(-1)?.searchParams.get("cursor")).toBe("all-next");
  await filterDay(page);
  await expect(panel.getByText("Synthetic Midnight", { exact: true })).toBeVisible();
  release({ drafts: [earliest], nextCursor: "stale-page", total: 3 });
  await expect.poll(() => released).toBe(true);
  await expect(panel.getByText("Synthetic Earlier", { exact: true })).toHaveCount(0);
  await expect(panel.locator(".collection-row")).toHaveCount(1);
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Synthetic Latest 已创建 LP", exact: true })).toBeDisabled();
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59", cursor: "day-next" });
  assertClean(f);
});


test("trusted trial schedules remain readonly beside manual ledger overrides and both LP detail types", async ({ page }) => {
  const candidate = screenshotCandidate();
  const trialSchedule = {
    ...candidate, source: "jiaowubao-open-api", teacherId: "SYNTH-LP-TEACHER-1", studentName: "Synthetic Student",
    plannerHint: "Eileen", matchedAt: NOW,
  };
  const intake = {
    planner: "Eileen", requestSentAt: NOW, contactParents: true, contactStudent: false,
    writingRequired: false, paperRequired: false, trialDurationMinutes: 45,
  };
  const base = { studentId: STUDENT_ID, owner: "Ella", stage: "待资料", due: "2026-10-23" };
  const f = await syntheticWorkspace(page, { lpItems: [
    {
      ...base, id: LP_ID, title: "Synthetic Trial Metadata", workflowType: "试听 LP", trialSchedule, trialIntake: intake,
      fields: { assignedTeacher: "Synthetic Manual Teacher", subject: "Synthetic Manual Subject", trialDurationMinutes: 45 },
      trialLedgerOverrides: { teacher: "Synthetic Manual Teacher", subject: "Synthetic Manual Subject", scheduledAt: "2026-10-22T22:30:00.000Z" },
    },
    {
      ...base, id: "SYNTH-CHANGE-TRIAL", title: "Synthetic Teacher Change", workflowType: "换老师试听",
      fields: { newTeacher: "Synthetic Change Teacher", subject: "Synthetic Change Subject" },
      trialSchedule: { ...trialSchedule, eventId: "synthetic-change-schedule", courseName: "Synthetic Complete Change Course", sharedAccountLabel: "试听学员C2026", sharedAccountLetter: "c" },
    },
  ] });
  const row = trialLedgerRow(page, LP_ID);
  await expect(row.getByLabel("Synthetic Student 老师", { exact: true })).toHaveValue("Synthetic Manual Teacher");
  await expect(row.getByLabel("Synthetic Student 科目", { exact: true })).toHaveValue("Synthetic Manual Subject");
  await expect(row.getByLabel("Synthetic Student 上课日期", { exact: true })).toHaveValue("2026-10-23");
  await expect(row.getByLabel("Synthetic Student 上课时间（墨尔本）", { exact: true })).toHaveValue("09:30");
  const api = row.getByRole("region", { name: "教务宝小课表", exact: true });
  for (const value of [candidate.teacherName, candidate.courseName, "2026-10-22", "19:05 – 20:05", "60 分钟", candidate.sharedAccountLabel]) await expect(api.getByText(value, { exact: true })).toBeVisible();
  await expect(api.locator("input,select,button,textarea")).toHaveCount(0);
  const trial = await openTrialDetails(page, "Synthetic Trial Metadata");
  await expect(trial.getByRole("region", { name: "教务宝小课表", exact: true }).getByText("60 分钟", { exact: true })).toBeVisible();
  await expect(trial.getByText("交接试听时长", { exact: true }).locator("..")).toHaveText("交接试听时长45 分钟");
  const change = await openTrialDetails(page, "Synthetic Teacher Change", "SYNTH-CHANGE-TRIAL");
  await expect(change.getByRole("region", { name: "教务宝小课表", exact: true }).getByText("Synthetic Complete Change Course", { exact: true })).toBeVisible();
  await expect(change.getByText("试听学员C2026", { exact: true })).toBeVisible();
  await expect(change.getByRole("button", { name: "补全教务宝小课表", exact: true })).toHaveCount(0);
  expect(f.posted).toEqual([]);
  expect(f.screenshotPosted).toEqual([]);
  assertClean(f);
});

test("handover rows show the proven student and confirmed Jiaowubao class time separately from handover time", async ({ page }) => {
  const candidate = screenshotCandidate();
  const pending = source(template.replace("【学生姓名】：Synthetic Student", "【学生姓名】："));
  const linked = { ...pending, id: "synthetic-linked-handover", sourceMessageId: "synthetic-linked-handover", resolvedStudentName: "Synthetic Proven Child",
    confirmed: { studentId: STUDENT_ID, lpItemId: LP_ID },
    trialSchedule: { source: "jiaowubao-open-api", eventId: candidate.eventId, startsAt: candidate.startsAt, endsAt: candidate.endsAt,
      courseName: candidate.courseName, studentName: "Synthetic Proven Child", teacherId: null, teacherName: candidate.teacherName,
      plannerHint: null, matchedAt: NOW, durationMinutes: 60, sharedAccountLabel: candidate.sharedAccountLabel, sharedAccountLetter: "b" } };
  const f = await syntheticWorkspace(page, { sourcePage: () => ({ drafts: [pending, linked], nextCursor: null, total: 2 }) });
  const panel = page.getByRole("region", { name: "机器人交接草稿", exact: true });
  await expect(panel.getByText("Synthetic Proven Child", { exact: true })).toBeVisible();
  const schedule = panel.getByRole("region", { name: "教务宝小课表" });
  await expect(schedule.getByText("2026-10-22", { exact: true })).toBeVisible();
  await expect(schedule.getByText("19:05 – 20:05", { exact: true })).toBeVisible();
  await expect(schedule.getByText("上课时间（墨尔本）", { exact: true })).toBeVisible();
  await expect(panel.getByText("上课时间：待核对教务宝课表", { exact: true })).toBeVisible();
  await expect(panel.getByText("待补学生姓名", { exact: true })).toBeVisible();
  await expect(panel.getByText(/交接时间：/u)).toHaveCount(2);
  expect(f.posted).toHaveLength(0);
  assertClean(f);
});

test("a roster-resolved draft name is visible and prefilled without silently creating an LP", async ({ page }) => {
  const unknown = source(template.replace("【学生姓名】：Synthetic Student", "【学生姓名】："));
  const resolved = { ...unknown, resolvedStudentName: "Synthetic Proven Child", matchedStudentId: STUDENT_ID,
    draft: { ...unknown.draft, studentName: "Synthetic Proven Child", fields: { ...unknown.draft.fields, studentNameKnown: true, studentName: "Synthetic Proven Child" } } };
  const f = await syntheticWorkspace(page, { sourcePage: () => ({ drafts: [resolved], nextCursor: null, total: 1 }) });
  await expect(page.getByRole("button", { name: "Synthetic Proven Child 核对并创建 LP", exact: true })).toBeVisible();
  await expect(page.getByText("待补学生姓名", { exact: true })).toHaveCount(0);
  const dialog = await openDraft(page);
  await expect(dialog.locator('[name="studentName"]')).toHaveValue("Synthetic Proven Child");
  expect(f.posted).toHaveLength(0);
  assertClean(f);
});


test("background refresh updates reconciled results while preserving loaded pages, filters and open edits", async ({ page }) => {
  let updated = false;
  const schedule = { source: "jiaowubao-open-api", ...screenshotCandidate(), matchedAt: NOW, studentName: "Synthetic Midnight", teacherId: null, plannerHint: null };
  const f = await syntheticWorkspace(page, { sourcePage: (url) => {
    const result = rangePage(url);
    return updated ? { ...result, drafts: result.drafts.map((item) => (item as { id: string }).id === midnight.id ? { ...midnight, trialSchedule: schedule, resolvedStudentName: "Synthetic Midnight" } : item) } : result;
  } });
  await filterDay(page);
  const panel = draftPanel(page);
  await panel.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(panel.locator(".collection-row")).toHaveCount(2);
  await panel.getByRole("button", { name: "Synthetic Midnight 核对并创建 LP", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "核对机器人交接", exact: true });
  await dialog.locator('[name="subject"]').fill("Synthetic unsaved edit");
  const before = f.reads.length;
  updated = true;
  await page.clock.runFor(60_001);
  await expect.poll(() => f.reads.length).toBeGreaterThan(before);
  await expect(panel.getByText("Synthetic Screenshot Teacher", { exact: true })).toBeVisible();
  await expect(panel.locator(".collection-row")).toHaveCount(2);
  await expect(panel.getByLabel("开始日期", { exact: true })).toHaveValue("2026-10-20T00:00");
  await expect(dialog.locator('[name="subject"]')).toHaveValue("Synthetic unsaved edit");
  expect(queryOf(f.reads.at(-1)!)).toEqual({ timezone: "Asia/Shanghai", from: "2026-10-20T00:00", to: "2026-10-20T23:59", cursor: "day-next" });
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("candidate class information is visible without preselecting the student's identity", async ({ page }) => {
  const unnamed = source(template.replace("【学生姓名】：Synthetic Student", "【学生姓名】："));
  const candidate = { studentId: STUDENT_ID, studentName: "Synthetic Candidate Child", schedule: { source: "jiaowubao-open-api", ...screenshotCandidate(), matchedAt: NOW, studentName: "Synthetic Candidate Child", teacherId: null, plannerHint: null } };
  const f = await syntheticWorkspace(page, { sourcePage: () => ({ drafts: [{ ...unnamed, scheduleEvidence: { status: "candidate", checkedAt: NOW, candidates: [candidate] } }], nextCursor: null, total: 1 }) });
  const panel = draftPanel(page);
  await expect(panel.getByText("候选课表，待核对学生", { exact: true })).toBeVisible();
  await expect(panel.getByText("Synthetic Candidate Child", { exact: true })).toBeVisible();
  await expect(panel.getByText("19:05 – 20:05", { exact: true })).toBeVisible();
  const dialog = await openDraft(page);
  await expect(dialog.getByRole("combobox", { name: "学生档案", exact: true })).toHaveValue("new");
  await expect(dialog.locator('[name="studentNameKnown"]')).toHaveValue("");
  await expect(dialog.locator('[name="studentName"]')).toHaveCount(0);
  await dialog.locator('[name="studentNameKnown"]').selectOption("是");
  await expect(dialog.locator('[name="studentName"]')).toHaveValue("");
  expect(f.posted).toEqual([]);
  assertClean(f);
});

test("focus refresh withdraws invalidated schedule evidence without waiting for a manual refresh", async ({ page }) => {
  let invalidated = false;
  const initial = { ...source(), trialSchedule: { source: "jiaowubao-open-api", ...screenshotCandidate(), matchedAt: NOW, studentName: "Synthetic Student", teacherId: null, plannerHint: null } };
  const f = await syntheticWorkspace(page, { sourcePage: () => ({ drafts: [invalidated ? source() : initial], nextCursor: null, total: 1 }) });
  const panel = draftPanel(page);
  await expect(panel.getByText("Synthetic Screenshot Teacher", { exact: true })).toBeVisible();
  invalidated = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.getByText("Synthetic Screenshot Teacher", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("上课时间：待核对教务宝课表", { exact: true })).toBeVisible();
  expect(f.posted).toEqual([]);
  assertClean(f);
});


test("repeat trial handover stays a pending ordinary trial and preserves historical context", async ({ page }) => {
  const reason = "以前试听过写作,现在想重新安排,本次还没有试听。";
  const f = await syntheticWorkspace(page, { text: `二次试听 信息交接\n${template.replace("安排教师", "新老师")}\n【二次试听原因+注意事项】：${reason}\n【特殊备注】：提前确认材料` });
  const dialog = await openDraft(page);
  await expect(dialog.locator('select[name="workflowType"]')).toHaveValue("试听 LP");
  await expect(dialog.locator('[name="assignedTeacher"]')).toHaveValue("Teacher Example");
  await expect(dialog.locator('[name="newTeacher"]')).toHaveCount(0);
  await expect(dialog.locator('[name="specialNotes"]')).toHaveValue(`${reason}\n提前确认材料`);
  expect(f.posted).toHaveLength(0);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0]).toMatchObject({ workflowType: "试听 LP", fields: { assignedTeacher: "Teacher Example", specialNotes: `${reason}\n提前确认材料` } });
  expect(f.posted[0].fields.trialSchedule).toBeUndefined();
  assertClean(f);
});

import { expect, test, type Page, type Route } from "@playwright/test";
import { buildWecomLpDraft } from "../../lib/wecom-lp-draft";

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

async function syntheticWorkspace(page: Page, options: { text?: string; matched?: boolean; postStatuses?: number[] } = {}) {
  let draftSource = source(options.text, undefined, options.matched);
  let committed = false;
  const posted: PostedCommand[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const student = {
    id: STUDENT_ID, name: options.matched ? "Synthetic Student" : "Synthetic Existing Student", initials: "SS",
    guardianWechat: options.matched ? "Synthetic Parent" : "Synthetic Other Parent", status: "试听待排", owner: "Ella", planner: "Eileen",
    course: "Y8 English", timezone: "Australia/Melbourne", teacher: "Teacher Example", next: "待安排", nextTone: "blue", files: 0,
  };
  const entities: Record<string, unknown> = {
    students: [student], teachers: [{ id: "SYNTH-LP-TEACHER-1", name: "Teacher Example", initials: "TE", subjects: ["Y8 English"], timezone: "Australia/Melbourne", availability: "", load: 0, capacity: 10, acceptsStudents: true, note: "", availabilityWindows: [] }],
    tasks: [], bookings: [], courses: [], lpItems: [], operations: [], renewals: [], payroll: [], messages: [], files: [], audit: [],
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
    entities.lpItems = [{ id: LP_ID, studentId: selectedId, title: "Synthetic Trial LP", workflowType: "试听 LP", owner: "Ella", stage: "待资料", due: "2026-10-23", fields: body.fields }];
    for (const entity of ["students", "lpItems", "tasks", "files"]) versions[entity]++;
    committed = true;
    return { committed: true, applied: true, studentId: selectedId, lpItemId: LP_ID, studentsRow: row("students"), lpItemsRow: row("lpItems"), tasksRow: row("tasks"), filesRow: row("files") };
  }
  function sourceReply(route: Route) {
    if (route.request().method() === "GET") return route.fulfill({ json: { drafts: committed ? [] : [draftSource], nextCursor: null, total: committed ? 0 : 1 } });
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
  function readReply(route: Route, url: URL) {
    switch (url.pathname) {
      case "/api/demo-session": return route.fulfill({ json: { ok: true, user: "Nixon", role: "admin", mustChangePassword: false } });
      case "/api/nixon-session": return route.fulfill({ json: { ok: true } });
      case "/api/app-snapshot": return route.fulfill({ json: { ...entities, versions, ...snapshots() } });
      case "/api/app-state": return route.fulfill({ json: sharedStateReply(url) });
      case "/api/audit": return route.fulfill({ json: { entries: [] } });
      default: return route.fulfill({ status: 403, json: { error: "Unbound synthetic read" } });
    }
  }
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/demo-logout") return route.fulfill({ json: { serverSessionRevoked: true } });
    if (url.pathname === "/api/operations/wecom-lp-drafts") return sourceReply(route);
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 403, json: { error: "Unbound synthetic write" } });
    }
    return readReply(route, url);
  });
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("/#section=lp");
  await expect(page.getByRole("heading", { name: "机器人交接草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /核对并创建 LP/u })).toBeVisible();
  return { posted, errors, unexpected };
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
  await expect(page.getByText("交接已确认，学生档案、LP 和待办已保存", { exact: true })).toBeVisible();
  assertClean(f);
});

test("matched handover selects the existing student without creating another record", async ({ page }) => {
  const f = await syntheticWorkspace(page, { matched: true });
  const dialog = await openDraft(page);
  await expect(dialog.getByRole("combobox", { name: "学生档案", exact: true })).toHaveValue("existing");
  await expect(dialog.getByRole("textbox", { name: "搜索学生姓名", exact: true })).toHaveValue("Synthetic Student");
  await expect(dialog.getByLabel("家长微信名", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0].studentId).toBe(STUDENT_ID);
  expect(f.posted[0].newStudent).toBeUndefined();
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

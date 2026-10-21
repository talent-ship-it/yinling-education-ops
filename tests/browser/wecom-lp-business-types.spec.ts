import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { buildWecomLpDraft } from "../../lib/wecom-lp-draft";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";

const NOW = "2026-10-21T02:00:00.000Z";
const STUDENT_ID = "SYNTH-LP-BUSINESS-STUDENT";
const SOURCE_ID = "synthetic-lp-business-handover";
const OLD_LP_ID = "SYNTH-LP-BUSINESS-HISTORY";
const NEW_LP_ID = "SYNTH-LP-BUSINESS-NEW";
const SUBJECT = "Y8 English";
const TEACHER = "Synthetic Arranged Teacher";
const STUDENT = "Synthetic Existing Student";
const TYPES = ["老师新 LP", "换老师试听", "老师 LP 修改"] as const;
type BusinessType = (typeof TYPES)[number];
type Command = {
  commandKey: string; sourceMessageId: string; sourceRevision: string; workflowType: BusinessType;
  studentId?: string; newStudent?: unknown; fields: Record<string, unknown>; expectedVersions: Record<string, number>;
};
const templates: Record<BusinessType, string> = {
  "老师新 LP": `【老生新LP信息交接】
【学生姓名】：${STUDENT}
【安排科目】：${SUBJECT}
【安排教师】：${TEACHER}
【是否要指定内容】：无需指定
【是否要写作】：是
【是否发试卷、收试卷】：否
【是否跟进老师备课内容】：是`,
  "换老师试听": `【二次试听信息交接】
【学生】：${STUDENT}
【安排教师】：${TEACHER}
【家长是否有指定内容】：无需指定
【是否跟进老师备课内容】：是
【二次试听原因+注意事项】：Reassess pacing; allow time for questions.`,
  "老师 LP 修改": `【老生LP修改信息交接】
【学生姓名】：${STUDENT}
【涉及科目】：${SUBJECT}
【变动内容】：Replace unit 2 with revision of unit 1.`,
};
const oldLp = {
  id: OLD_LP_ID, studentId: STUDENT_ID, title: "Synthetic Historical LP", workflowType: "老师新 LP", owner: "Ella",
  stage: "完成", due: "2026-10-01", revisionNumber: 2,
  fields: { teacher: "Synthetic Previous Teacher", subject: SUBJECT, documentUrl: "https://docs.example.invalid/historical-lp" },
  revisions: [{ id: "SYNTH-HISTORY-REVISION", workflowId: OLD_LP_ID, number: 2, changedAt: NOW, changedBy: "Ella", before: {}, after: { documentUrl: "https://docs.example.invalid/historical-lp" } }],
};

function source(type: BusinessType, revision = "a".repeat(64), changed = false) {
  const text = changed ? templates[type].replace(SUBJECT, "Y8 Mathematics").replace("unit 2", "unit 3") : templates[type];
  const messages = [{ messageId: SOURCE_ID, text, sentAt: NOW, studentId: STUDENT_ID }];
  const parsed = buildWecomLpDraft(messages);
  return {
    id: SOURCE_ID, sourceMessageId: SOURCE_ID, caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: revision,
    workflowType: type, wechatName: "", studentName: STUDENT, operationsOwner: "Ella", coursePlanner: "Eileen",
    status: "identified", createdAt: NOW, handoverAt: NOW, messages, confirmed: null,
    matchedStudentId: STUDENT_ID, resolvedStudentName: STUDENT,
    draft: { ...parsed, workflowType: type },
  };
}

async function syntheticWorkspace(page: Page, type: BusinessType, postStatuses: number[] = []) {
  let draftSource = source(type);
  let committed = false;
  const posted: Command[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  const student = {
    id: STUDENT_ID, name: STUDENT, initials: "SS", guardianWechat: "Synthetic Parent", status: "在读", owner: "Ella", planner: "Eileen",
    course: SUBJECT, timezone: "Australia/Melbourne", teacher: "待匹配", next: "待安排", nextTone: "blue", files: 1,
  };
  const entities: Record<string, unknown[]> = {
    students: [student], teachers: [{ id: "SYNTH-ARRANGED-TEACHER", name: TEACHER, initials: "ST", subjects: [SUBJECT], timezone: "Australia/Melbourne", availability: "", load: 0, capacity: 10, acceptsStudents: true, note: "", availabilityWindows: [] }],
    lpItems: [structuredClone(oldLp)], tasks: [], bookings: [], courses: [], operations: [], renewals: [], payroll: [], messages: [], files: [], audit: [],
  };
  const versions = Object.fromEntries(Object.keys(entities).map((entity) => [entity, 1]));
  const row = (entity: string) => ({ entity, payload: entities[entity] ?? [], version: versions[entity] ?? 1, updated_at: NOW, updated_by: "synthetic" });
  const snapshots = () => ({
    managedExamSnapshot: { versions: { students: versions.students, tasks: versions.tasks }, students: [] },
    managedTrialPaymentSnapshot: { versions: { students: versions.students, tasks: versions.tasks, bookings: versions.bookings, lpItems: versions.lpItems }, students: [] },
  });
  function confirm(route: Route) {
    const command = route.request().postDataJSON() as Command;
    posted.push(command);
    const status = postStatuses[posted.length - 1] ?? 200;
    if (status === 409) {
      draftSource = source(type, "b".repeat(64), true);
      return route.fulfill({ status, json: { error: "交接来源已变化，请刷新草稿。", code: "draft_conflict" } });
    }
    if (status !== 200) return route.fulfill({ status, json: { error: "合成服务暂不可用", code: "unavailable" } });
    if (command.workflowType !== type || command.studentId !== STUDENT_ID || command.newStudent !== undefined) {
      return route.fulfill({ status: 400, json: { error: "Synthetic business type or existing-student target mismatch" } });
    }
    if (!committed) {
      entities.lpItems.push({ id: NEW_LP_ID, studentId: STUDENT_ID, title: `Synthetic ${type}`, workflowType: type, owner: "Ella", stage: "待资料", due: "2026-10-23", revisionNumber: 1, fields: command.fields });
      for (const entity of ["students", "lpItems", "tasks", "files"]) versions[entity]++;
    }
    committed = true;
    return route.fulfill({ json: { committed: true, applied: true, studentId: STUDENT_ID, lpItemId: NEW_LP_ID, studentsRow: row("students"), lpItemsRow: row("lpItems"), tasksRow: row("tasks"), filesRow: row("files") } });
  }
  function sharedStateReply(url: URL) {
    if (url.searchParams.get("mode") === "versions") return { versions: Object.keys(versions).map(row) };
    const requested = (url.searchParams.get("entities") ?? "").split(",");
    return { rows: requested.filter((entity) => entity in entities).map(row), ...snapshots() };
  }
  function draftReply(route: Route) {
    if (route.request().method() === "POST") return confirm(route);
    const confirmed = committed ? { studentId: STUDENT_ID, lpItemId: NEW_LP_ID } : null;
    return route.fulfill({ json: { drafts: [{ ...draftSource, confirmed }], nextCursor: null, total: 1 } });
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
  function handleRoute(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/operations/wecom-lp-drafts") return draftReply(route);
    if (url.pathname === "/api/demo-logout") return route.fulfill({ json: { serverSessionRevoked: true } });
    if (request.method() === "GET") return readReply(route, url);
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 403, json: { error: "Unbound synthetic write" } });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/*", handleRoute);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: displayPreferencesStorageKey("Nixon"), value: JSON.stringify(defaultDisplayPreferences()) });
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("/#section=lp");
  await expect(page.getByRole("heading", { name: "机器人交接草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /核对并创建 LP/u })).toBeVisible();
  return { posted, errors, unexpected, entities };
}

async function openDraft(page: Page, type: BusinessType) {
  await page.getByRole("button", { name: /核对并创建 LP/u }).click();
  const dialog = page.getByRole("dialog", { name: "核对机器人交接", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('select[name="workflowType"]')).toHaveValue(type);
  await expect(dialog.getByRole("textbox", { name: "搜索学生姓名", exact: true })).toHaveValue(STUDENT);
  await expect(dialog.locator('option[value="new"]')).toHaveCount(0);
  await expect(dialog.locator('[name="wecomGuardianWechat"]')).toHaveCount(0);
  return dialog;
}

async function reviewMissingFields(dialog: Locator) {
  for (const [name, value] of [["responsibleOperations", "Ella"], ["specifiedContentStatus", "无需指定"], ["preparationFollowUp", "否"]]) {
    const control = dialog.locator(`[name="${name}"]`);
    if (await control.count() && !await control.inputValue()) {
      if (await control.evaluate((element) => element.tagName === "SELECT")) await control.selectOption(value);
      else await control.fill(value);
    }
  }
  const subject = dialog.locator('[name="subject"]');
  if (await subject.count() && !await subject.inputValue()) {
    if (await subject.evaluate((element) => element.tagName === "SELECT")) await subject.selectOption(SUBJECT);
    else await subject.fill(SUBJECT);
  }
}

function assertClean(fixture: Awaited<ReturnType<typeof syntheticWorkspace>>) {
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.entities.lpItems.find((lp) => (lp as { id: string }).id === OLD_LP_ID)).toEqual(oldLp);
}

async function assertSourceFields(dialog: Locator, type: BusinessType) {
  if (type === "老师新 LP") {
    await expect(dialog.locator('[name="teacher"]')).toHaveValue(TEACHER);
    await expect(dialog.locator('[name="writingRequired"]')).toHaveValue("是");
    await expect(dialog.locator('[name="paperRequired"]')).toHaveValue("否");
  } else if (type === "换老师试听") {
    await expect(dialog.locator('[name="newTeacher"]')).toHaveValue(TEACHER);
    const previousTeacher = dialog.locator('[name="originalTeacher"]');
    if (await previousTeacher.count()) await expect(previousTeacher).toHaveValue("");
    await expect(dialog.locator('[name="changeReason"]')).toHaveValue("Reassess pacing; allow time for questions.");
  } else {
    await expect(dialog.locator('[name="modificationRequirements"]')).toHaveValue("Replace unit 2 with revision of unit 1.");
    const teacher = dialog.locator('[name="teacher"]');
    if (await teacher.count()) await expect(teacher).toHaveValue("");
  }
}

function assertSubmittedFields(command: Command, type: BusinessType) {
  expect(command.fields.subject).toBe(SUBJECT);
  if (type === "老师新 LP") expect(command.fields).toMatchObject({ teacher: TEACHER, writingRequired: true, paperRequired: false, preparationFollowUp: "是" });
  if (type === "换老师试听") {
    expect(command.fields).toMatchObject({ newTeacher: TEACHER, changeReason: "Reassess pacing; allow time for questions." });
    expect(command.fields.originalTeacher ?? "").toBe("");
  }
  if (type === "老师 LP 修改") expect(command.fields.teacher ?? "").toBe("");
}

for (const type of TYPES) test(`${type}: minimal existing-student handover preserves its business type and LP history`, async ({ page }) => {
  const f = await syntheticWorkspace(page, type);
  const views = page.getByRole("group", { name: "LP 保存视图", exact: true });
  await views.getByRole("button", { name: /^已完成/u }).click();
  const dialog = await openDraft(page, type);
  await assertSourceFields(dialog, type);
  await reviewMissingFields(dialog);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0]).toMatchObject({ workflowType: type, studentId: STUDENT_ID, sourceMessageId: SOURCE_ID, sourceRevision: "a".repeat(64) });
  expect(f.posted[0].newStudent).toBeUndefined();
  assertSubmittedFields(f.posted[0], type);
  await expect(views.getByRole("button", { name: /^进行中/u })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("combobox", { name: `Synthetic ${type} 当前阶段`, exact: true })).toHaveValue("待资料");
  await expect(page.getByRole("button", { name: `${STUDENT} 已创建 LP`, exact: true })).toBeDisabled();
  await views.getByRole("button", { name: /^已完成/u }).click();
  await expect(page.getByRole("combobox", { name: "Synthetic Historical LP 当前阶段", exact: true })).toHaveValue("完成");
  assertClean(f);
});

test("temporary failure retries the same LP modification command and workflow type", async ({ page }) => {
  const f = await syntheticWorkspace(page, "老师 LP 修改", [503]);
  const dialog = await openDraft(page, "老师 LP 修改");
  await reviewMissingFields(dialog);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(page.getByText("合成服务暂不可用", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认并创建 LP", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.posted).toHaveLength(2);
  expect(f.posted[1]).toEqual(f.posted[0]);
  expect(f.posted[0].workflowType).toBe("老师 LP 修改");
  expect(f.posted[0].commandKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(f.entities.lpItems).toHaveLength(2);
  assertClean(f);
});

test("source conflict discards stale business fields and uses a new reviewed command", async ({ page }) => {
  const f = await syntheticWorkspace(page, "老师 LP 修改", [409]);
  const dialog = await openDraft(page, "老师 LP 修改");
  await reviewMissingFields(dialog);
  await dialog.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(/请重新打开最新草稿核对/u)).toBeVisible();
  const updated = await openDraft(page, "老师 LP 修改");
  await expect(updated.locator('[name="subject"]')).toHaveValue("Y8 Mathematics");
  await expect(updated.locator('[name="modificationRequirements"]')).toHaveValue("Replace unit 3 with revision of unit 1.");
  await reviewMissingFields(updated);
  await updated.getByRole("button", { name: "确认并创建 LP", exact: true }).click();
  await expect(updated).not.toBeVisible();
  expect(f.posted).toHaveLength(2);
  expect(f.posted.map((body) => body.sourceRevision)).toEqual(["a".repeat(64), "b".repeat(64)]);
  expect(f.posted[1].workflowType).toBe("老师 LP 修改");
  expect(f.posted[1].commandKey).not.toBe(f.posted[0].commandKey);
  expect(f.posted[1].fields).toMatchObject({ subject: "Y8 Mathematics", modificationRequirements: "Replace unit 3 with revision of unit 1." });
  expect(f.entities.lpItems).toHaveLength(2);
  assertClean(f);
});

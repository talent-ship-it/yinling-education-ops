import { expect, test, type Page } from "@playwright/test";
import { fixture, serverFixture } from "../ava-calendar-server-fixture";
import { createTeacherSelfAvailabilityHandler } from "../../lib/teacher-availability-self-service";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";

function workspaceSnapshot(state: ReturnType<typeof fixture>) {
  const rows = Object.fromEntries(state.rows.map((row) => [row.entity, row]));
  const versions = { students: rows.students!.version, teachers: rows.teachers!.version, tasks: 1, bookings: rows.bookings!.version, lpItems: rows.lpItems!.version };
  return {
    students: (rows.students!.payload as Record<string, unknown>[]).map((student) => ({ initials: "合", status: "在读", course: "VCE English", timezone: "UTC", next: "待安排", nextTone: "blue", files: 0, ...student })),
    teachers: (rows.teachers!.payload as Record<string, unknown>[]).map((teacher) => ({ initials: "ST", subjects: ["VCE English"], availability: "合成开放时段", load: 0, capacity: 12, acceptsStudents: true, note: "合成样本", ...teacher })),
    versions,
    managedExamSnapshot: { versions: { students: versions.students, tasks: versions.tasks }, students: [] },
    managedTrialPaymentSnapshot: { versions: { bookings: versions.bookings, students: versions.students, lpItems: versions.lpItems, tasks: versions.tasks }, students: [] },
  };
}

async function syntheticCalendar(page: Page, teacher = true, prepare: (state: ReturnType<typeof fixture>) => void = () => {}, shared?: ReturnType<typeof fixture>) {
  const state = shared ?? fixture();
  state.session = teacher ? { user: "Synthetic Teacher", role: "teacher", permissions: ["operations.read", "availability.write.self"] } : state.session;
  state.fullAdmin = !teacher;
  prepare(state);
  await page.addInitScript(({ key, value }) => { localStorage.setItem(key, value); }, { key: displayPreferencesStorageKey(state.session.user), value: JSON.stringify(defaultDisplayPreferences()) });
  const server = serverFixture(state);
  const writes: unknown[] = [];
  const external: string[] = [];
  const self = createTeacherSelfAvailabilityHandler({
    readSession: async () => ({ session: state.session }), readRows: async () => structuredClone(state.rows),
    save: async (input) => {
      if (state.rows.some((row) => input.scopeVersions[row.entity] !== undefined && input.scopeVersions[row.entity] !== row.version)) throw Object.assign(new Error("version_conflict"), { code: "40001" });
      const row = state.rows.find(({ entity }) => entity === "teachers")!;
      if (row.version !== input.expectedVersion) throw Object.assign(new Error("version_conflict"), { code: "40001" });
      row.payload = input.payload; row.version++; state.versions.find(({ entity }) => entity === "teachers")!.version = row.version;
      writes.push(input); return structuredClone([row]);
    },
  });
  const workspace: Record<string, () => unknown> = {
    "/api/demo-session": () => ({ ok: true, ...state.session, mustChangePassword: false }),
    "/api/demo-logout": () => ({ serverSessionRevoked: true }),
    "/api/app-snapshot": () => workspaceSnapshot(state),
    "/api/nixon-session": () => ({ ok: !teacher }),
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") { external.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (workspace[url.pathname]) return route.fulfill({ json: workspace[url.pathname]!() });
    if (url.pathname === "/api/ava-calendar" || url.pathname === "/api/ava-calendar/range") {
      const window = { start: url.searchParams.get("start")!, end: url.searchParams.get("end")! };
      const response = await (url.pathname.endsWith("/range") ? server.getRange(window) : server.get("human", window));
      return route.fulfill({ status: response.status, json: await response.json() });
    }
    if (url.pathname === "/api/teacher-availability/self") {
      const request = route.request();
      const response = await self(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(request.method() === "POST" ? { body: request.postData()! } : {}) }));
      return route.fulfill({ status: response.status, json: await response.json() });
    }
    return route.fulfill({ status: 403, json: { error: "Synthetic harness rejects unbound API" } });
  });
  await page.clock.install({ time: new Date("2026-10-12T00:00:00Z") });
  await page.goto("/ava-calendar/live");
  return { state, writes, external, server, self };
}

test("teacher can open the immediate self-availability editor", async ({ page }) => {
  const f = await syntheticCalendar(page);
  await expect(page.getByRole("button", { name: "我的开放时段", exact: true })).toBeVisible();
  expect(f.external).toEqual([]);
});

async function day(page: Page, editable = true) {
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("UTC");
  const view = page.getByRole("combobox", { name: "日历视图", exact: true });
  if (await view.isEnabled()) await view.selectOption("timeGridDay");
  await page.getByLabel("日期", { exact: true }).fill("2026-10-12");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect(page.locator(".fc-timegrid-col[data-date='2026-10-12']").first()).toBeVisible();
  if (editable) await expect(page.locator("[data-writable='true']")).toHaveCount(1);
}
async function point(page: Page, time: string, column = 0) {
  const root = page.locator(".fc").nth(column);
  const row = root.locator(`.fc-timegrid-slot-lane[data-time='${time}:00']`);
  await row.scrollIntoViewIfNeeded();
  const slot = await row.boundingBox();
  const col = await root.locator(".fc-timegrid-col[data-date]").first().boundingBox();
  return { x: col!.x + col!.width * .6, y: slot!.y + 3 };
}
async function twoPoints(page: Page, start = "07:00", end = "08:30", touch = false, column = 0) {
  let position = await point(page, start, column);
  if (touch) await page.touchscreen.tap(position.x, position.y); else await page.mouse.click(position.x, position.y);
  await expect(page.locator("[data-first-point]")).toHaveCount(1);
  position = await point(page, end, column);
  if (touch) await page.touchscreen.tap(position.x, position.y); else await page.mouse.click(position.x, position.y);
  await expect(page.getByRole("dialog", { name: "新开放时段", exact: true })).toBeVisible();
}

test("draw saves immediately, adjusts and deletes AVA without moving a scheduled lesson", async ({ page }, info) => {
  const f = await syntheticCalendar(page);
  await day(page);
  await expect(page.locator("[data-event-id='event-1']")).toHaveCount(1);
  await point(page, "08:00");
  const [first, last] = await page.locator(".fc").evaluate((root) => {
    const column = root.querySelector(".fc-timegrid-col[data-date]")!.getBoundingClientRect();
    return ["07:00", "08:00"].map((time) => {
      const slot = root.querySelector(`[data-time='${time}:00'].fc-timegrid-slot-lane`)!.getBoundingClientRect();
      return { x: column.x + column.width * .6, y: slot.y + 3 };
    });
  });
  await page.mouse.move(first!.x, first!.y); await page.mouse.down(); await page.mouse.move(last!.x, last!.y, { steps: 20 }); await page.mouse.up();
  const editor = page.getByRole("dialog", { name: "新开放时段", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("开始", { exact: true })).toHaveValue("2026-10-12T07:00");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect.poll(() => f.writes.length).toBe(1);
  await expect(page.locator("[data-ava-id]")).toHaveCount(3);
  await page.getByRole("button", { name: "我的开放时段", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "我的开放时段", exact: true });
  await manager.getByRole("button", { name: "修改", exact: true }).last().click();
  const update = page.getByRole("dialog", { name: "修改开放时段", exact: true });
  await update.getByLabel("结束", { exact: true }).fill("2026-10-12T09:00");
  await update.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(2);
  await expect(update).not.toBeVisible();
  await page.getByRole("button", { name: "我的开放时段", exact: true }).click();
  await manager.getByRole("button", { name: "修改", exact: true }).last().click();
  await update.getByRole("button", { name: "删除开放时段", exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(3);
  await expect(update).not.toBeVisible();
  await expect(page.locator("[data-ava-id]")).toHaveCount(2);
  await expect(page.locator("[data-event-id='event-1']")).toHaveAttribute("data-start", "2026-10-12T02:00:00.123Z");
  await expect(page.locator(".fc-event-draggable, .fc-event-resizable")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`${info.project.name}-desktop.png`), fullPage: true });
  expect(f.external).toEqual([]);
});

test.describe("phone two-point entry", () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  test("touch selection preserves its full interval and modal actions stay reachable", async ({ page }, info) => {
    const f = await syntheticCalendar(page);
    await day(page);
    await twoPoints(page, "05:30", "06:30", true);
    await page.getByRole("button", { name: "关闭开放时段", exact: true }).click();
    await expect(page.locator("[data-first-point]")).toHaveCount(0);
    await twoPoints(page, "07:00", "08:30", true);
    const editor = page.getByRole("dialog", { name: "新开放时段", exact: true });
    await expect(editor.getByLabel("结束", { exact: true })).toHaveValue("2026-10-12T08:30");
    await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeInViewport({ ratio: 1 });
    await editor.getByLabel("结束", { exact: true }).focus();
    await expect(editor.getByRole("button", { name: "关闭开放时段", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`${info.project.name}-mobile320-editor.png`), fullPage: true });
    await page.setViewportSize({ width: 568, height: 320 });
    await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(editor.getByRole("button", { name: "关闭开放时段", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`${info.project.name}-landscape-editor.png`), fullPage: true });
    await page.setViewportSize({ width: 320, height: 568 });
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    await expect(editor).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${info.project.name}-mobile320-calendar.png`), fullPage: true });
    expect(f.external).toEqual([]);
  });
});

test("stale and failed reads show last sync; unavailable lessons hide green but never prevent self save", async ({ page }, info) => {
  const f = await syntheticCalendar(page, true, (state) => { state.page = { ...state.page, state: "stale", freshness: "stale" }; });
  await day(page);
  await expect(page.getByRole("alert").filter({ hasText: "课表已过旧" })).toContainText("最后成功同步：2026-10-12 00:00");
  await expect(page.locator("[data-ava-id]")).toHaveCount(2);
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ status: 503, json: { error: "synthetic unavailable snapshot" } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "已隐藏绿色" })).toContainText("最后成功同步：2026-10-12 00:00");
  await expect(page.locator("[data-ava-id]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`${info.project.name}-source-unavailable.png`), fullPage: true });
  await twoPoints(page);
  await page.getByRole("dialog", { name: "新开放时段", exact: true }).getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.external).toEqual([]);
});

for (const width of [1440, 320]) {
  test(`empty dates keep the teacher self calendar writable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
    const f = await syntheticCalendar(page);
    await day(page);
    await page.getByLabel("日期", { exact: true }).fill("2026-10-14");
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await expect(page.locator("[data-teacher='T1'][data-writable='true']")).toHaveCount(1);
    await twoPoints(page);
    const editor = page.getByRole("dialog", { name: "新开放时段", exact: true });
    await expect(editor.getByLabel("开始", { exact: true })).toHaveValue("2026-10-14T07:00");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    await expect(editor).not.toBeVisible();
    await expect(page.locator("[data-ava-id]")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`empty-date-self-${width}.png`), fullPage: true });
    expect(f.external).toEqual([]);
  });
}

const SYNTHETIC_NAMES = ["合成甲", "合成乙", "合成丙", "合成丁", "合成戊", "合成己"];
function sixColors(state: ReturnType<typeof fixture>) {
  const owners = ["Tiffany", "Ella", "Abby", "Molly", "Thea", "Erin"];
  const students = owners.map((owner, index) => ({ id: `S${index + 1}`, name: SYNTHETIC_NAMES[index]!, owner, teacher: "Synthetic Teacher", jwbSourceRow: String(101 + index) }));
  state.rows.find(({ entity }) => entity === "students")!.payload = students;
  const base = state.page.events[0]!;
  state.page = { ...state.page, events: students.map((student, index) => {
    const startsAt = new Date(Date.parse("2026-10-12T04:00:00Z") + index * 3600000).toISOString();
    const duration = [15, 30, 45, 60, 15, 30][index]!;
    return { ...base, eventId: `color-${index}`, startsAt, endsAt: new Date(Date.parse(startsAt) + duration * 60000).toISOString(), sourceParticipants: [{ memberId: student.jwbSourceRow, label: student.name }, ...(index ? [] : [{ memberId: "shared-A", label: "试听学员A" }])] };
  }) };
  const trial = state.page.events[0]!;
  state.rows.find(({ entity }) => entity === "lpItems")!.payload = [{ id: "LP1", workflowType: "试听 LP", studentId: "S1", trialSchedule: { source: "jiaowubao-open-api", sourceRevision: state.page.revision, eventId: trial.eventId, teacherId: "T1", startsAt: trial.startsAt, endsAt: trial.endsAt } }];
}
function otherTeacher(state: ReturnType<typeof fixture>) {
  const teachers = state.rows.find(({ entity }) => entity === "teachers")!.payload as Record<string, unknown>[];
  teachers.push({ ...structuredClone(teachers[0]), id: "T2", name: "Synthetic Other", jiaowubaoOpenApi: { sourceId: "902", confidence: "exact", resolution: "stable_source_id", snapshotRevision: state.page.revision }, availabilityWindows: [] });
}

test("student names, six owner colors, trial marker and real short-card durations survive phone widths", async ({ page }, info) => {
  const f = await syntheticCalendar(page, true, sixColors);
  await day(page);
  for (let index = 0; index < 6; index++) await expect(page.locator(`[data-event-id='color-${index}'] [data-owner-color='owner-${index + 1}']`)).toHaveText(SYNTHETIC_NAMES[index]!);
  await expect(page.locator("[data-event-id='color-0'] [data-trial]")).toHaveText("试听");
  await point(page, "04:00");
  for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const violations = await page.locator("[data-event-id]").evaluateAll((events) => events.flatMap((event) => {
      const box = event.getBoundingClientRect();
      return [...event.querySelectorAll("strong, [data-trial]")].filter((child) => {
        const rect = child.getBoundingClientRect();
        return rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
      }).map(() => event.getAttribute("data-event-id"));
    }));
    expect(violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${info.project.name}-colors-${viewport.width}x${viewport.height}.png`), fullPage: true });
  }
  const first = await point(page, "04:00");
  await page.mouse.click(first.x, first.y + 5);
  const details = page.getByRole("dialog", { name: "试听课", exact: true });
  await expect(details).toContainText("15 分钟");
  await expect(details.getByRole("button")).toHaveCount(1);
  expect(f.external).toEqual([]);
});

test("shared all-teacher columns sync scrolling and preserve each mobile axis; month headers remain weekdays", async ({ page }, info) => {
  const f = await syntheticCalendar(page, false, (state) => { otherTeacher(state); sixColors(state); });
  await day(page, false);
  await page.getByRole("button", { name: "只看有课/AVA", exact: true }).click();
  await expect(page.locator(".fc")).toHaveCount(2);
  await expect(page.locator(".fc-col-header-cell-cushion")).toHaveText(["Synthetic Teacher", "Synthetic Other"]);
  await expect(page.getByRole("button", { name: "我的开放时段", exact: true })).toHaveCount(0);
  await page.locator(".fc-timegrid-body").nth(1).evaluate((element) => { element.closest(".fc-scroller")!.scrollTop = 300; });
  await expect.poll(() => page.locator(".fc-timegrid-body").evaluateAll((elements) => Math.max(...elements.map((element) => element.closest(".fc-scroller")!.scrollTop)) - Math.min(...elements.map((element) => element.closest(".fc-scroller")!.scrollTop)))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath(`${info.project.name}-all-teachers-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator("[aria-label='日历滚动区域']").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const label = page.locator(".fc").nth(1).locator(".fc-timegrid-slot-label").first();
  await expect(label).toBeVisible();
  expect(await label.evaluate((element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${info.project.name}-all-teachers-mobile320.png`), fullPage: true });
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("America/New_York");
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  const view = page.getByRole("combobox", { name: "日历视图", exact: true });
  await view.selectOption("dayGridMonth");
  for (const date of ["2026-10-12", "2026-12-31", "2027-01-15"]) {
    await page.getByLabel("日期", { exact: true }).fill(date);
    await expect(page.locator(".fc-col-header-cell-cushion")).toHaveCount(7);
    expect(await page.locator(".fc-col-header-cell-cushion").allTextContents()).toEqual(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
  }
  await view.selectOption("timeGridWeek");
  await expect(page.locator(".fc-timeGridWeek-view")).toHaveCount(1);
  expect((await page.locator(".fc-col-header-cell-cushion").allTextContents()).every((text) => /\d/.test(text))).toBe(true);
  expect(f.writes.length).toBe(0);
  expect(f.external).toEqual([]);
});

test("automatic revocation clears the private self editor as well as lessons", async ({ page }) => {
  await syntheticCalendar(page);
  await day(page);
  await expect(page.getByRole("button", { name: "我的开放时段", exact: true })).toBeVisible();
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ status: 401, json: {} }));
  await page.clock.fastForward(60000);
  await expect(page.getByRole("alert").filter({ hasText: "登录已失效" })).toBeVisible();
  await expect(page.getByRole("button", { name: "我的开放时段", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-ava-id], [data-event-id]")).toHaveCount(0);
});

test("lost save response retries exactly the same command without a duplicate write", async ({ page }) => {
  const f = await syntheticCalendar(page);
  await day(page); await twoPoints(page);
  let first = true;
  const bodies: string[] = [];
  await page.route("**/api/teacher-availability/self", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    bodies.push(request.postData()!);
    const response = await f.self(new Request(request.url(), { method: "POST", headers: request.headers(), body: request.postData()! }));
    if (first) { first = false; return route.abort(); }
    return route.fulfill({ status: response.status, json: await response.json() });
  });
  const editor = page.getByRole("dialog", { name: "新开放时段", exact: true });
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("保存结果待确认");
  await editor.getByRole("button", { name: "重试同一操作", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(bodies.length).toBe(2); expect(bodies[0]).toBe(bodies[1]); expect(f.writes.length).toBe(1);
  expect(f.external).toEqual([]);
});

test("a second viewer refreshes the same saved AVA in their own browser timezone", async ({ page, browser }, info) => {
  const f = await syntheticCalendar(page);
  await day(page); await twoPoints(page);
  await page.getByRole("dialog", { name: "新开放时段", exact: true }).getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  const context = await browser.newContext({ timezoneId: "Asia/Shanghai" });
  try {
    const other = await context.newPage();
    const second = await syntheticCalendar(other, true, () => {}, f.state);
    await expect(other.getByRole("combobox", { name: "显示时区", exact: true })).toHaveValue("Asia/Shanghai");
    await other.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("timeGridDay");
    await other.getByLabel("日期", { exact: true }).fill("2026-10-12");
    await expect(other.locator("[data-ava-id]")).toHaveCount(3);
    await other.screenshot({ path: info.outputPath(`${info.project.name}-second-viewer-shanghai.png`), fullPage: true });
    expect(second.external).toEqual([]);
  } finally { await context.close(); }
});

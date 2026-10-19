import { expect, test, type Page } from "@playwright/test";
import { defaultDisplayPreferences, displayPreferencesStorageKey, type InterfaceLanguage } from "../../lib/display-preferences";
import { defaultTrialLedgerViewState, trialLedgerViewStorageKey } from "../../lib/trial-ledger-view";
import { splitAvaCalendarWindow } from "../../lib/ava-calendar-live-client";

async function isolateCalendarPage(page: Page) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") throw new Error(`Unexpected external request: ${url.origin}`);
    return url.pathname.startsWith("/api/")
      ? route.fulfill({ status: 403, json: { error: "Synthetic harness rejects unbound API" } })
      : route.continue();
  });
}

test.beforeEach(async ({ page }) => { await isolateCalendarPage(page); });

function measureLiveCalendarGeometry() {
  function controlOutOfBounds(box: DOMRect) {
    return box.width < 44 || box.height < 44 || box.left < -1 || box.right > innerWidth + 1;
  }
  function textOutOfBounds(box: DOMRect, child: DOMRect) {
    return child.left < box.left - 1 || child.right > box.right + 1 || child.top < box.top - 1 || child.bottom > box.bottom + 1;
  }
  function controls() {
    const violations: string[] = [];
    for (const control of document.querySelectorAll("main button, main select, main input")) {
      if (control.closest("dialog")) continue;
      if (controlOutOfBounds(control.getBoundingClientRect())) violations.push("control bounds");
      if (control.matches("input, select") && (innerWidth <= 700 || innerHeight <= 480) && parseFloat(getComputedStyle(control).fontSize) < 16) violations.push("input font");
    }
    return violations;
  }
  function lessons() {
    const violations: string[] = [];
    for (const event of document.querySelectorAll(".fc-timegrid-event[data-event-id]")) {
      const box = event.getBoundingClientRect();
      for (const child of event.querySelectorAll("strong, [data-trial], [data-owner-color]")) {
        const r = child.getBoundingClientRect();
        if (r.width && r.height && textOutOfBounds(box, r)) violations.push("lesson text overflow");
      }
    }
    return violations;
  }
  const overflow = document.documentElement.scrollWidth > innerWidth + 1 ? ["page overflow"] : [];
  return [...overflow, ...controls(), ...lessons()];
}

function calendarDto() {
  const owners = ["Tiffany", "Ella", "Abby", "Molly", "Thea", "Erin"];
  return {
    teachers: [{ id: "T1", name: "Synthetic Teacher" }, { id: "T2", name: "Synthetic Other" }],
    events: owners.map((owner, index) => ({ eventId: `E${index + 1}`, startsAt: `2026-10-12T${String(4 + index).padStart(2, "0")}:00:00.000Z`, endsAt: `2026-10-12T${String(4 + index).padStart(2, "0")}:30:00.000Z`, teacherId: "T1", teacherName: "Synthetic Teacher", trial: index === 0, identityPending: false, students: [{ studentId: `S${index + 1}`, studentName: `合成学生${index + 1}`, owner, ownerId: `C${index + 1}`, color: `owner-${index + 1}` }] })),
    source: { revision: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-12T00:00:00.000Z", freshness: "fresh", coverage: "complete", window: { start: "2026-09-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } },
    nativeVersions: { students: 1, teachers: 2, bookings: 3, lpItems: 4 }, consistencyKey: "b".repeat(64),
    remainingAVA: [{ id: "A1", teacherId: "T1", startsAt: "2026-10-12T03:00:00.000Z", endsAt: "2026-10-12T04:00:00.000Z" }], availabilityStatus: [],
  };
}

type CalendarFixture = Omit<ReturnType<typeof calendarDto>, "availabilityStatus"> & { availabilityStatus: { teacherId: string; reason: string }[] };

function rangeWindows(url: string) {
  const params = new URL(url).searchParams;
  return splitAvaCalendarWindow({ start: params.get("start")!, end: params.get("end")! });
}

function rangeReply(data: CalendarFixture, url: string) {
  return { slices: rangeWindows(url).map((window) => sliceReply(data, `http://127.0.0.1/api/ava-calendar?${new URLSearchParams(window)}`)) };
}

function sliceReply(data: CalendarFixture, url: string) {
  const params = new URL(url).searchParams;
  const start = Date.parse(params.get("start")!);
  const end = Date.parse(params.get("end")!);
  return { ...data, events: data.events.filter((event) => Date.parse(event.startsAt) < end && Date.parse(event.endsAt) > start), remainingAVA: data.remainingAVA.flatMap((interval) => {
    const a = Math.max(start, Date.parse(interval.startsAt));
    const b = Math.min(end, Date.parse(interval.endsAt));
    return a < b ? [{ ...interval, startsAt: new Date(a).toISOString(), endsAt: new Date(b).toISOString() }] : [];
  }) };
}

function workspaceSnapshot() {
  const versions = { students: 1, teachers: 2, tasks: 3, bookings: 4, lpItems: 5 };
  return {
    students: [{ id: "SYNTH-STU-1", name: "合成主系统学生", initials: "合", status: "试听", owner: "Abby", course: "VCE English", timezone: "Australia/Melbourne", teacher: "Amelia Brown", next: "待安排", nextTone: "blue", files: 0, grade: "Year 10", examSubject: "VCE English", location: "VIC" }],
    teachers: [{ id: "SYNTH-TEA-1", name: "Amelia Brown", initials: "AB", subjects: ["Year 10 English", "VCE English"], timezone: "Australia/Melbourne · UTC+10", availability: "周六 15:00-20:00", load: 8, capacity: 12, acceptsStudents: true, note: "Playwright 合成快照", departments: ["中小学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "测试", availabilitySlots: [{ day: 6, start: "15:00", end: "20:00" }] }],
    versions,
    managedExamSnapshot: { versions: { students: versions.students, tasks: versions.tasks }, students: [] },
    managedTrialPaymentSnapshot: { versions: { bookings: versions.bookings, students: versions.students, lpItems: versions.lpItems, tasks: versions.tasks }, students: [] },
  };
}

async function fixture(
  page: Page,
  data: CalendarFixture = calendarDto(),
  session: { user: string; role: "admin" | "limited-admin" | "staff" | "teacher" } = { user: "Amelia Brown", role: "teacher" },
  language: InterfaceLanguage = "zh-CN",
) {
  await isolateCalendarPage(page);
  await page.addInitScript(({ key, value }) => { localStorage.setItem(key, value); }, { key: displayPreferencesStorageKey(session.user), value: JSON.stringify({ ...defaultDisplayPreferences(), language }) });
  const scopedData = () => session.role === "teacher" ? {
    ...data,
    teachers: data.teachers.slice(0, 1),
    events: data.events.filter((event) => event.teacherId === data.teachers[0]?.id),
    remainingAVA: data.remainingAVA.filter((interval) => interval.teacherId === data.teachers[0]?.id),
    availabilityStatus: data.availabilityStatus.filter((status) => status.teacherId === data.teachers[0]?.id),
  } : data;
  await page.route("**/api/demo-session", (route) => route.fulfill({ json: { ok: true, ...session, mustChangePassword: false } }));
  await page.route("**/api/demo-logout", (route) => route.fulfill({ json: { serverSessionRevoked: true } }));
  await page.route("**/api/app-snapshot", (route) => route.fulfill({ json: workspaceSnapshot() }));
  await page.route("**/api/nixon-session", (route) => route.fulfill({ json: { ok: session.user === "Nixon" && session.role === "admin" } }));
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: sliceReply(scopedData(), route.request().url()) }));
  await page.route("**/api/ava-calendar/range?**", (route) => route.fulfill({ json: rangeReply(scopedData(), route.request().url()) }));
  await page.route("**/api/teacher-availability/self", (route) => route.fulfill({ status: 403, json: { error: "Synthetic readonly session has no self-write permission" } }));
  return data;
}

async function settleLazyCalendar(page: Page) {
  await expect.poll(async () => {
    await page.clock.runFor(100);
    return page.locator(".fc").count();
  }).toBeGreaterThan(0);
}

async function openLive(page: Page) {
  await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
  await page.goto("/ava-calendar/live");
  await settleLazyCalendar(page);
  await expect(page.locator(".fc")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("Australia/Melbourne");
  await page.locator('button[data-view="timeGridDay"]').click();
  await page.getByLabel("日期", { exact: true }).fill("2026-10-12");
}

function workspaceGeometry() {
  const main = document.querySelector("#main-content")!;
  const heading = main.querySelector(".view-heading")!;
  const title = heading.querySelector("h1")!;
  const panel = main.querySelector(".panel")!;
  const h = heading.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  const font = getComputedStyle(title);
  const card = getComputedStyle(panel);
  return { headingTop: h.top, headingLeft: h.left, cardLeft: p.left, cardWidth: p.width, gap: p.top - h.bottom, fontFamily: font.fontFamily, fontSize: font.fontSize, fontWeight: font.fontWeight, letterSpacing: font.letterSpacing, borderRadius: card.borderRadius, borderColor: card.borderColor, background: card.backgroundColor };
}

test("embedded AVA aligns with renewals and loads calendar code only when selected", async ({ page }, info) => {
  await fixture(page, calendarDto(), { user: "Abby", role: "staff" });
  await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
  const scripts = new Set<string>();
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.add(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
  });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
    await page.goto("/#section=renewals");
    await expect(page.locator("#main-content h1")).toHaveText("考试与续课");
    await expect(page.locator(".fc")).toHaveCount(0);
    const reference = await page.evaluate(workspaceGeometry);
    await page.screenshot({ path: info.outputPath(`aligned-renewals-${width}.png`), fullPage: true });
    const scriptCount = scripts.size;
    const documentCount = documents.length;
    await page.locator(".app-shell").evaluate((element) => { element.setAttribute("data-persistent-shell", "true"); });
    if (width === 320) {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("dialog", { name: "全部功能", exact: true }).getByRole("button", { name: "AVA日历", exact: true }).click();
    } else {
      await page.locator("#primary-navigation").getByRole("button", { name: "AVA日历", exact: true }).click();
    }
    await expect(page).toHaveURL(/\/#section=ava-calendar$/);
    await expect(page.locator("#main-content h1")).toHaveText("AVA日历");
    await expect(page.locator(".fc")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    const embedded = await page.evaluate(workspaceGeometry);
    expect(embedded).toEqual(reference);
    expect(documents.length).toBe(documentCount);
    if (width === 1440) expect(scripts.size).toBeGreaterThan(scriptCount);
    await expect(page.locator(".app-shell[data-persistent-shell='true'] .topbar")).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`aligned-ava-${width}.png`), fullPage: true });
    await info.attach(`alignment-${width}.json`, { body: JSON.stringify({ reference, embedded, documentCount, lazyScripts: [...scripts] }, null, 2), contentType: "application/json" });
  }
  await page.reload();
  await expect(page.locator("#main-content h1")).toHaveText("AVA日历");
  await expect(page.locator(".fc")).toHaveCount(1);
  await page.goBack();
  await expect(page.locator("#main-content h1")).toHaveText("考试与续课");
  await page.goForward();
  await expect(page.locator("#main-content h1")).toHaveText("AVA日历");
});

test("teacher discovers the live calendar and returns to the existing monthly submission flow", async ({ page }, info) => {
  await fixture(page, calendarDto(), { user: "Amelia Brown", role: "teacher" }, "en-AU");
  await page.goto("/");
  const nav = page.locator("#primary-navigation");
  const entry = nav.getByRole("button", { name: /AVA(?:日历| calendar)/ });
  await expect(entry).toHaveAttribute("aria-label", /AVA(?:日历| calendar)/);
  await page.locator(".app-shell").evaluate((element) => { element.setAttribute("data-persistent-shell", "true"); });
  await entry.click();
  await expect(page).toHaveURL(/\/#section=ava-calendar$/);
  await expect(entry).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".app-shell[data-persistent-shell='true'] .topbar")).toBeVisible();
  await expect(page.locator("#main-content h1")).toHaveText(/AVA(?:日历| calendar)/);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.locator(".fc")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("teacher-live-calendar-desktop.png"), fullPage: true });
  await nav.getByRole("button", { name: /^(?:工作台|Workspace)$/ }).click();
  const submitAvailability = page.getByRole("button", { name: /提交月度 AVA|Submit availability/ });
  await expect(submitAvailability).toBeVisible();
  await submitAvailability.click();
  const submission = page.getByRole("dialog");
  await expect(submission).toContainText("提交下月 AVA 与可接人数");
  await expect(submission.getByRole("textbox", { name: /老师|Teacher/ })).toHaveValue("Amelia Brown");
  await expect(submission.getByRole("button", { name: "提交教务审核", exact: true })).toBeVisible();
  await submission.getByRole("button", { name: /取消|Cancel/, exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: /更多|More/ }).click();
  const drawer = page.getByRole("dialog", { name: /全部功能|All functions/ });
  await expect(drawer.getByRole("button", { name: /AVA(?:日历| calendar)/ })).toBeVisible();
  await drawer.getByRole("button", { name: /AVA(?:日历| calendar)/ }).click();
  await expect(page).toHaveURL(/\/#section=ava-calendar(?:&|$)/);
  await expect(drawer).not.toBeVisible();
  await expect(page.locator(".app-shell[data-persistent-shell='true'] .topbar")).toBeVisible();
  await expect(page.locator(".fc")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("teacher-live-calendar-mobile320.png"), fullPage: true });
});

test("administrator discovers live AVA and returns to the existing pending-review controls", async ({ page }) => {
  await fixture(page, calendarDto(), { user: "Nixon", role: "admin" });
  await page.route("**/api/teacher-availability/review", (route) => route.fulfill({ json: {
    teacherVersion: 1,
    submissions: [{
      submission: { id: "SYNTHETIC-AVA-1", teacherId: "SYNTH-TEA-1", month: "2026-11", timezone: "Australia/Melbourne", slots: [{ day: 1, start: "16:00", end: "17:00" }] },
      submittedAt: "2026-10-12T00:00:00.000Z", teacherName: "Amelia Brown", additionalStudents: 1, notes: "仅浏览器合成审核样本",
    }],
  } }));
  await page.goto("/");
  const nav = page.locator("#primary-navigation");
  const entry = nav.getByRole("button", { name: /AVA(?:日历| calendar)/ });
  await expect(entry).toHaveAttribute("aria-label", /AVA(?:日历| calendar)/);
  await entry.click();
  await expect(page).toHaveURL(/\/#section=ava-calendar$/);
  await expect(page.locator(".fc")).toHaveCount(1);
  await nav.getByRole("button", { name: /^(?:工作台|Workspace)$/ }).click();
  await page.getByRole("navigation", { name: "主要导航" }).getByRole("button", { name: /老师资源|Teachers/ }).click();
  const availability = page.getByRole("region", { name: "Amelia Brown 月度 AVA" });
  await expect(availability.getByRole("heading", { name: "待审核提交" })).toBeVisible();
  await expect(availability.getByRole("button", { name: "通过", exact: true })).toBeVisible();
  await expect(availability.getByRole("button", { name: "拒绝", exact: true })).toBeVisible();
});

test("a verified empty calendar differs from unready data and neither state paints green AVA", async ({ page }, info) => {
  const base = calendarDto();
  const empty: CalendarFixture = {
    ...base,
    teachers: [base.teachers[0]!],
    events: [],
    remainingAVA: [],
    availabilityStatus: [{ teacherId: base.teachers[0]!.id, reason: "no_current_availability" }],
  };
  await fixture(page, empty);
  await openLive(page);
  await expect(page.getByText("当前范围无可用 AVA", { exact: true })).toBeVisible();
  await expect(page.locator("[data-ava-id]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("empty-ava-state.png"), fullPage: true });

  const unready = { ...empty, availabilityStatus: empty.teachers.map(({ id }) => ({ teacherId: id, reason: "health_not_ready" })) };
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: sliceReply(unready, route.request().url()) }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByText("AVA 数据暂未就绪", { exact: true })).toBeVisible();
  await expect(page.locator("[data-ava-id]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("unready-ava-state.png"), fullPage: true });
});

test("automatic reads wait sixty seconds and pause while the document is hidden", async ({ page }) => {
  const data = await fixture(page);
  let reads = 0;
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) reads += 1; });
  await openLive(page);
  await expect(page.locator("[data-event-id='E1']")).toBeVisible();
  const before = reads;
  data.events[0]!.students[0]!.studentName = "合成更新学生";
  await page.clock.fastForward(59999);
  expect(reads).toBe(before);
  await page.clock.fastForward(1);
  await expect(page.locator("[data-event-id='E1']")).toContainText("合成更新学生");
  expect(reads).toBe(before + 1);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  await page.clock.fastForward(60000);
  expect(reads).toBe(before + 1);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }));
  await page.clock.fastForward(60000);
  await expect.poll(() => reads).toBe(before + 2);
});

test("the fifty-second abort clears the complete private group and leaves manual retry enabled", async ({ page }) => {
  const data = await fixture(page);
  await openLive(page);
  await page.locator("[data-event-id='E1']").click();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ava-calendar?**", async (route) => { await pending; await route.fulfill({ json: data }); });
  try {
    await page.clock.fastForward(60000);
    await expect(page.getByRole("status")).toHaveText("正在读取…");
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("合成学生1", { exact: true })).toHaveCount(0);
    await page.clock.fastForward(50001);
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "读取超时，请重试。" })).toHaveText("读取超时，请重试。");
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "已隐藏绿色" })).toContainText("最后成功同步");
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("the separate authenticated live entry restores compact FullCalendar with real DTO student colors and readonly green", async ({ page }, info) => {
  await fixture(page);
  await openLive(page);
  await expect(page.locator(".fc")).toHaveCSS("--fc-today-bg-color", "#f5fbf8");
  await expect(page.locator(".fc-timegrid-event[data-event-id]" )).toHaveCount(6);
  await expect(page.locator(".fc-bg-event[data-ava-id]" )).toHaveCount(1);
  await expect(page.locator("[data-event-id='E1']").getByText("Synthetic Teacher · Tiffany", { exact: true })).toBeVisible();
  for (let index = 1; index <= 6; index += 1) {
    await expect(page.locator(`[data-event-id='E${index}'] [data-owner-color='owner-${index}']`)).toHaveText(`合成学生${index}`);
  }
  await expect(page.locator("[data-event-id='E1'] [data-trial]" )).toHaveText("试听");
  await expect(page.getByRole("button", { name: /安排|修改|管理|换账号|新时段|更多/ })).toHaveCount(0);
  await page.locator("[data-event-id='E1']").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("合成学生1");
  await expect(page.getByRole("dialog")).toContainText("30 分钟");
  await expect(page.getByRole("dialog").getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  await page.clock.runFor(50);
  await page.screenshot({ path: info.outputPath("desktop-live-day.png"), fullPage: true });
});

for (const colorScheme of ["dark", "light"] as const) {
  for (const [width, height] of [[1440, 1000], [320, 568], [568, 320]] as const) {
    test(`lesson detail text meets AA contrast in ${colorScheme} at ${width}x${height}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height });
      await fixture(page);
      await openLive(page);
      await expect(page).toHaveURL(/\/#section=ava-calendar$/);
      await page.locator("[data-event-id='E1']").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("试听课");
      await expect(dialog).toContainText("合成学生1");
      await expect(dialog).toContainText("30 分钟");
      const measurements = await dialog.evaluate((element) => {
        function rgba(value: string) {
          const channels = value.match(/[\d.]+/g)!.map(Number);
          return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1];
        }
        function over(front: number[], back: number[]) {
          return front.slice(0, 3).map((channel, index) => channel * front[3]! + back[index]! * (1 - front[3]!));
        }
        function luminance(color: number[]) {
          const linear = color.map((channel) => {
            const s = channel / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
        }
        const text = [...element.querySelectorAll("h2, strong, span, button")].map((node) => {
          const layers: Element[] = [];
          for (let parent: Element | null = node; parent; parent = parent.parentElement) {
            layers.unshift(parent);
            if (parent === element) break;
          }
          let background = [255, 255, 255];
          for (const layer of layers) {
            const style = getComputedStyle(layer);
            if (style.backgroundImage !== "none" || style.opacity !== "1") throw new Error("Unsupported contrast paint layer");
            background = over(rgba(style.backgroundColor), background);
          }
          const color = getComputedStyle(node).color;
          const foreground = over(rgba(color), background);
          const a = luminance(foreground), b = luminance(background);
          return { tag: node.tagName, text: node.textContent, color, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
        return {
          width: innerWidth, height: innerHeight, dark: matchMedia("(prefers-color-scheme: dark)").matches,
          rootInk: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
          workspaceHeadingColor: getComputedStyle(document.querySelector("#main-content h1")!).color,
          dialogBackground: getComputedStyle(element).backgroundColor, text,
        };
      });
      await testInfo.attach("detail-contrast.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath(`detail-${colorScheme}-${width}x${height}.png`) });
      expect(measurements.width).toBe(width);
      expect(measurements.height).toBe(height);
      expect(measurements.dark).toBe(colorScheme === "dark");
      expect(measurements.rootInk).toBe(colorScheme === "dark" ? "#f3f5f7" : "#1d2529");
      expect(measurements.workspaceHeadingColor).toBe(colorScheme === "dark" ? "rgb(243, 245, 247)" : "rgb(29, 37, 41)");
      expect(measurements.dialogBackground).toBe("rgb(255, 255, 255)");
      expect(measurements.text.length).toBeGreaterThan(5);
      for (const sample of measurements.text) expect(sample.contrast, `${sample.tag}: ${sample.text}`).toBeGreaterThanOrEqual(4.5);
      await expect(dialog.getByRole("heading", { level: 2 })).toBeInViewport({ ratio: 1 });
      const close = dialog.getByRole("button", { name: "关闭课程详情", exact: true });
      await expect(close).toBeInViewport({ ratio: 1 });
      const bounds = await close.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await close.click();
      await expect(dialog).not.toBeVisible();
    });
  }
}

test("portrait and landscape controls and 15/30/45/60-minute text stay within their actual bounds", async ({ page }, info) => {
  const data = calendarDto();
  const base = data.events[0]!;
  data.events = [["04:00", "04:15"], ["04:15", "04:30"], ["04:30", "05:00"], ["05:00", "05:45"], ["05:45", "06:45"]].map(([start, end], index) => ({ ...base, eventId: `SHORT${index}`, startsAt: `2026-10-12T${start}:00.000Z`, endsAt: `2026-10-12T${end}:00.000Z`, students: [{ ...base.students[0]!, studentId: `SS${index}`, studentName: `合成时长学生${index}` }], trial: true }));
  await fixture(page, data);
  await openLive(page);
  for (const [width, height] of [[320, 568], [390, 844], [568, 320], [844, 390], [1280, 800]]) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const view of ["timeGridDay", "timeGridWeek"]) {
      await page.locator(`button[data-view="${view}"]`).click();
      await page.clock.runFor(50);
      await expect(page.locator(".fc-timegrid-event[data-event-id]")).toHaveCount(5);
      const geometry = await page.evaluate(measureLiveCalendarGeometry);
      expect(geometry, `${width}x${height} ${view}`).toEqual([]);
      await expect.poll(() => page.evaluate(() => {
        const first = document.querySelector("[data-event-id='SHORT0']");
        const second = document.querySelector("[data-event-id='SHORT1']");
        if (!first || !second) return false;
        const a = first.getBoundingClientRect(); const b = second.getBoundingClientRect();
        return a.width > 0 && b.width > 0 && Math.abs(a.x - b.x) <= 1 && a.bottom <= b.y + 1;
      })).toBe(true);
      expect(await page.locator("[data-event-id='SHORT0']").getAttribute("data-end")).toBe("2026-10-12T04:15:00.000Z");
      if (view === "timeGridWeek" && [320, 844, 1280].includes(width!)) await page.screenshot({ path: info.outputPath(`${width}x${height}-week.png`), fullPage: true });
    }
  }
  await page.locator('button[data-view="timeGridDay"]').click();
  await page.setViewportSize({ width: 568, height: 320 });
  await page.locator("[data-event-id='SHORT0']").click();
  await expect(page.getByRole("dialog")).toContainText("15 分钟");
  await expect(page.getByRole("button", { name: "关闭课程详情", exact: true })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

 test("each student retains their own coordinator color; unknown identities stay neutral and strings cannot inject HTML", async ({ page }) => {
  const data = calendarDto();
  data.events[0]!.students.push({ ...data.events[1]!.students[0]!, studentName: '<img src=x onerror="window.syntheticXss=1">合成二' });
  data.events[0]!.endsAt = "2026-10-12T05:00:00.000Z";
  data.events.push({ ...data.events[1]!, eventId: "UNKNOWN", students: [], identityPending: true });
  await fixture(page, data);
  await openLive(page);
  const group = page.locator("[data-event-id='E1']");
  await expect(group).toHaveAttribute("data-owner-color", "owner-unassigned");
  await expect(group.locator("[data-owner-color='owner-1']")).toHaveText("合成学生1");
  await expect(group.locator("[data-owner-color='owner-2']")).toContainText("<img src=x");
  await expect(page.locator("[data-event-id='UNKNOWN'] [data-owner-color='owner-unassigned']")).toHaveText("学生待确认");
  await expect(page.locator(".fc-event img")).toHaveCount(0);
  expect(await page.evaluate(() => "syntheticXss" in window)).toBe(false);
  const colors = await page.locator("[aria-label='日历图例'] [data-owner-color]").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor));
  expect(new Set(colors).size).toBe(6);
  await group.focus();
  await group.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("<img src=x");
  await expect(page.getByRole("dialog").locator("img")).toHaveCount(0);
});

test("unauthenticated live entry preserves real login and the protected local API returns no private DTO", async ({ page }) => {
  let reads = 0;
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) reads += 1; });
  await page.goto("/ava-calendar/live");
  await expect(page.getByLabel("登录密码")).toBeVisible();
  await expect(page.locator(".fc")).toHaveCount(0);
  expect(reads).toBe(0);
  const response = await page.request.get("/api/ava-calendar?start=2026-10-12T00:00:00.000Z&end=2026-10-13T00:00:00.000Z");
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).not.toHaveProperty("events");
});

test("401 and 403 clear names, teachers, green and open details without trusting a server error string", async ({ page }) => {
  await fixture(page);
  await openLive(page);
  for (const status of [401, 403]) {
    await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ status, json: { error: "synthetic-secret-must-not-render" } }));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(status === 401 ? "登录已失效" : "无权查看");
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await expect(page.getByText("合成学生1", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(1);
    await expect(page.getByText("synthetic-secret-must-not-render")).toHaveCount(0);
  }
});

test("partial, stale, legacy, pending, invalid metadata and no approved AVA never retain old green", async ({ page }) => {
  const data = await fixture(page);
  await openLive(page);
  const changes = [
    { ...data, source: { ...data.source, freshness: "stale" } },
    { ...data, source: { ...data.source, coverage: "partial" } },
    { ...data, nativeVersions: undefined, consistencyKey: undefined },
    { ...data, consistencyKey: "invalid" },
    { ...data, source: { ...data.source, window: { start: "invalid", end: "invalid" } } },
    { ...data, events: [{ ...data.events[0]!, identityPending: true }] },
    { ...data, remainingAVA: [] },
    { ...data, availabilityStatus: [{ teacherId: "T1", reason: "no_approved_availability" }] },
  ];
  for (const changed of changes) {
    await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: changed }));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.locator("[data-event-id='E1']")).toContainText("合成学生1");
    await expect(page.locator("[data-ava-id]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: data }));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.locator("[data-ava-id]")).toHaveCount(1);
  }
});

test("pending manual reads do not overlap automatic reads and a superseded date cannot publish late", async ({ page }) => {
  const data = await fixture(page);
  await openLive(page);
  await page.clock.fastForward(30000);
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ava-calendar?**", async (route) => {
    reads += 1;
    if (reads === 1) { await pending; await route.fulfill({ json: { ...data, events: [] } }); }
    else await route.fulfill({ json: sliceReply(data, route.request().url()) });
  });
  try {
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    await page.clock.fastForward(31000);
    expect(reads).toBe(1);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-13");
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.locator("[data-event-id='E1']")).toContainText("合成学生1");
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  await expect(page.locator("[data-event-id]")).toHaveCount(6);
});

test("refresh retains both scroll positions while date and timezone navigation retain teacher scope", async ({ page }) => {
  await fixture(page);
  await openLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await page.locator('button[data-view="timeGridWeek"]').click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  const viewport = page.getByLabel("日历滚动区域", { exact: true });
  await viewport.evaluate((element) => { element.scrollLeft = 280; });
  const vertical = page.locator(".fc-timegrid-body").locator("xpath=ancestor::div[contains(@class,'fc-scroller')][1]");
  await vertical.evaluate((element) => { element.scrollTop = 300; });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.locator("[data-event-id]")).toHaveCount(6);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(280);
  await expect.poll(() => vertical.evaluate((element) => element.scrollTop)).toBe(300);
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("UTC");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("T1");
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(280);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect.poll(() => page.locator(".fc-timegrid-slot-lane[data-time='09:00:00']").evaluate((element) => Math.abs(element.getBoundingClientRect().top - element.closest(".fc-scroller")!.getBoundingClientRect().top))).toBeLessThanOrEqual(2);
  for (const [view, css] of [["timeGridDay", ".fc-timeGridDay-view"], ["timeGridThreeDay", ".fc-timeGridThreeDay-view"], ["dayGridMonth", ".fc-dayGridMonth-view"]]) {
    await page.locator(`button[data-view="${view!}"]`).click();
    await expect(page.locator(css!)).toHaveCount(1);
  }
  await page.clock.setSystemTime(new Date("2026-10-11T16:30:00.000Z"));
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-11");
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("Australia/Melbourne");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-12");
  await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("T1");
});

test("a month group publishes only after all five bounded slices share authority and 409 retries at most once", async ({ page }) => {
  const data = await fixture(page);
  data.teachers = data.teachers.slice(0, 1);
  await openLive(page);
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const windows: { start: string; end: string }[] = [];
  await page.route("**/api/ava-calendar/range?**", async (route) => {
    reads += 1;
    windows.push(...rangeWindows(route.request().url()));
    await pending;
    await route.fulfill({ json: rangeReply(data, route.request().url()) });
  });
  try {
    await page.locator('button[data-view="dayGridMonth"]').click();
    await expect.poll(() => reads).toBe(1);
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("正在读取…");
    release();
    await expect(page.locator("[data-event-id]")).toHaveCount(6);
    expect(windows).toHaveLength(5);
    for (let index = 0; index < windows.length; index += 1) {
      expect(Date.parse(windows[index]!.end) - Date.parse(windows[index]!.start)).toBeLessThanOrEqual(10 * 86400000);
      if (index) expect(windows[index]!.start).toBe(windows[index - 1]!.end);
    }
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  let conflicts = 0;
  await page.route("**/api/ava-calendar/range?**", (route) => { conflicts += 1; return route.fulfill({ status: 409, json: {} }); });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("课表或身份已更新");
  expect(conflicts).toBe(2);
  await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
});

test("DST in Melbourne and London preserves producer timestamps, local labels and real lesson duration", async ({ page }) => {
  const data = calendarDto();
  const cases = [
    { zone: "Australia/Melbourne", day: "2026-10-04", start: "2026-10-03T15:30:00.000Z", end: "2026-10-03T16:30:00.000Z", label: "01:30–03:30" },
    { zone: "Europe/London", day: "2026-03-29", start: "2026-03-29T00:30:00.000Z", end: "2026-03-29T01:30:00.000Z", label: "00:30–02:30" },
    { zone: "Europe/London", day: "2026-10-25", start: "2026-10-25T00:30:00.000Z", end: "2026-10-25T01:30:00.000Z", label: "01:30–01:30" },
  ];
  await fixture(page, data);
  await openLive(page);
  for (const item of cases) {
    data.events = [{ ...data.events[0]!, startsAt: item.start, endsAt: item.end }];
    await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption(item.zone);
    await page.getByLabel("日期", { exact: true }).fill(item.day);
    await expect(page.locator("[data-event-id='E1']")).toHaveCount(1);
    await expect(page.locator("[data-event-id='E1']")).toHaveAttribute("data-start", item.start);
    await expect(page.locator("[data-event-id='E1']")).toHaveAttribute("data-end", item.end);
    await expect(page.locator("[data-event-id='E1']")).toContainText(new RegExp(item.label.replace("–", "\\s*[–-]\\s*")));
    await page.locator("[data-event-id='E1']").click();
    await expect(page.getByRole("dialog")).toContainText("60 分钟");
    await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  }
});

test("cross-midnight slicing keeps actual duration and excludes an exact midnight end", async ({ page }) => {
  const data = calendarDto();
  data.events = [{ ...data.events[0]!, startsAt: "2026-10-12T23:45:00.000Z", endsAt: "2026-10-13T00:30:00.000Z" }];
  await fixture(page, data);
  await openLive(page);
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("UTC");
  await expect(page.locator("[data-event-id='E1']")).toHaveCount(1);
  await expect(page.locator("[data-event-id='E1']")).toContainText("23:45–24:00");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator("[data-event-id='E1']")).toContainText("00:00–00:30");
  await page.locator("[data-event-id='E1']").click();
  await expect(page.getByRole("dialog")).toContainText("45 分钟");
  await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  data.events[0]!.endsAt = "2026-10-13T00:00:00.000Z";
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
});

test("touchscreen phone controls and readonly details are reachable in portrait and landscape", async ({ browser, baseURL }, info) => {
  for (const [width, height] of [[320, 568], [844, 390]]) {
    const context = await browser.newContext({ baseURL, viewport: { width: width!, height: height! }, timezoneId: "Australia/Melbourne", isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await fixture(page);
    await openLive(page);
    await page.getByRole("button", { name: "下一页", exact: true }).tap();
    await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-13");
    await page.getByRole("button", { name: "今天", exact: true }).tap();
    await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-12");
    await page.getByRole("button", { name: "刷新", exact: true }).tap();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    const bounds = await page.locator("main button, main select, main input").evaluateAll((elements) => elements.filter((element) => !element.closest("dialog")).map((element) => element.getBoundingClientRect().toJSON()));
    for (const box of bounds) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
    await page.clock.runFor(50);
    await page.screenshot({ path: info.outputPath(`touch-${width}x${height}.png`), fullPage: true });
    await page.locator("[data-event-id='E1']").tap();
    await expect(page.getByRole("dialog")).toContainText("合成学生1");
    await expect(page.getByRole("button", { name: "关闭课程详情", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "关闭课程详情", exact: true }).tap();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await context.close();
  }
});

type StorageOperation = { method: "setItem" | "removeItem" | "clear"; storage: "local" | "session" | "unknown"; args: string[] };

async function observeCalendarStorage(page: Page) {
  const benignWrites: [string, string][] = [
    [displayPreferencesStorageKey("Amelia Brown"), JSON.stringify(defaultDisplayPreferences())],
    [trialLedgerViewStorageKey("Amelia Brown"), JSON.stringify(defaultTrialLedgerViewState())],
    ["yinling.sidebar-collapsed", "false"],
  ];
  await page.addInitScript((benignWrites: [string, string][] = []) => {
    const operations: StorageOperation[] = [];
    Object.defineProperty(window, "syntheticStorageOperations", { configurable: true, value: operations });
    Object.defineProperty(window, "syntheticStorageWrites", { configurable: true, value: 0, writable: true });
    function isBenignWrite(operation: StorageOperation) {
      if (operation.method !== "setItem" || operation.storage !== "local" || operation.args.length !== 2) return false;
      return benignWrites.some(([key, value]) => operation.args[0] === key && operation.args[1] === value);
    }
    function isBenignRemoval(operation: StorageOperation) {
      return operation.method === "removeItem" && operation.storage === "session" && operation.args.length === 1 && operation.args[0] === "yinling:logout-retry-notice";
    }
    for (const method of ["setItem", "removeItem", "clear"] as const) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(this: Storage, ...args: string[]) {
        const storage = this === window.localStorage ? "local" : this === window.sessionStorage ? "session" : "unknown";
        const operation: StorageOperation = { method, storage, args: args.map(String) };
        operations.push(operation);
        if (!isBenignWrite(operation) && !isBenignRemoval(operation)) Reflect.set(window, "syntheticStorageWrites", Number(Reflect.get(window, "syntheticStorageWrites")) + 1);
        return Reflect.apply(original, this, args);
      };
    }
  }, benignWrites);
}

test("Storage guard rejects unknown and nested student data while allowing only exact benign operations", async ({ page }) => {
  await observeCalendarStorage(page);
  await page.route("**/storage-guard-control", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Storage guard control</title>" }));
  await page.goto("/storage-guard-control");
  const preferencesKey = displayPreferencesStorageKey("Amelia Brown");
  const ledgerKey = trialLedgerViewStorageKey("Amelia Brown");
  const preferences = defaultDisplayPreferences();
  const ledger = defaultTrialLedgerViewState();
  const student = { studentId: "R1-UNSEEN-274", studentName: "未登记样本 Ω", teacherId: "T274", startsAt: "2026-10-16T09:15:00.000Z" };
  const privateRecord = JSON.stringify(student);
  const nestedRecord = JSON.stringify({ envelope: { records: [JSON.stringify(student)] } });
  const benign: StorageOperation[] = [
    { method: "setItem", storage: "local", args: [preferencesKey, JSON.stringify(preferences)] },
    { method: "setItem", storage: "local", args: [ledgerKey, JSON.stringify(ledger)] },
    { method: "setItem", storage: "local", args: ["yinling.sidebar-collapsed", "false"] },
    { method: "removeItem", storage: "session", args: ["yinling:logout-retry-notice"] },
  ];
  const rejected: StorageOperation[] = [
    { method: "setItem", storage: "local", args: ["calendar-private-record", privateRecord] },
    { method: "setItem", storage: "session", args: ["calendar-private-record", privateRecord] },
    { method: "setItem", storage: "local", args: ["unknown-student-name", student.studentName] },
    { method: "setItem", storage: "local", args: ["nested-student-record", nestedRecord] },
    { method: "setItem", storage: "session", args: ["serialized-student-record", JSON.stringify(nestedRecord)] },
    { method: "setItem", storage: "local", args: [preferencesKey, JSON.stringify({ ...preferences, students: [student] })] },
    { method: "setItem", storage: "local", args: [preferencesKey, JSON.stringify({ ...preferences, timezone: student.studentName })] },
    { method: "setItem", storage: "local", args: [ledgerKey, JSON.stringify({ ...ledger, query: student.studentName })] },
    { method: "setItem", storage: "local", args: [ledgerKey, JSON.stringify({ ...ledger, records: [nestedRecord] })] },
    { method: "setItem", storage: "local", args: ["yinling.sidebar-collapsed", privateRecord] },
    { method: "setItem", storage: "session", args: [preferencesKey, JSON.stringify(preferences)] },
    { method: "setItem", storage: "session", args: [ledgerKey, JSON.stringify(ledger)] },
    { method: "setItem", storage: "session", args: ["yinling.sidebar-collapsed", "false"] },
    { method: "setItem", storage: "local", args: [`${preferencesKey}-extra`, JSON.stringify(preferences)] },
    { method: "setItem", storage: "local", args: ["unknown-config-key", JSON.stringify(preferences)] },
    { method: "removeItem", storage: "session", args: ["yinling:logout-retry-notice-extra"] },
    { method: "removeItem", storage: "local", args: ["yinling:logout-retry-notice"] },
    { method: "removeItem", storage: "local", args: [preferencesKey] },
    { method: "clear", storage: "session", args: [] },
    { method: "clear", storage: "local", args: [] },
  ];
  const operations = [...benign, ...rejected];
  const results = await page.evaluate((operations) => operations.map((operation) => {
    const storage = operation.storage === "local" ? localStorage : sessionStorage;
    const before = Number(Reflect.get(window, "syntheticStorageWrites"));
    Reflect.apply(storage[operation.method], storage, operation.args);
    return { delta: Number(Reflect.get(window, "syntheticStorageWrites")) - before, value: operation.method === "setItem" ? storage.getItem(operation.args[0]!) : null };
  }), operations);
  for (const [index, result] of results.entries()) {
    expect(result.delta, JSON.stringify(operations[index])).toBe(index < benign.length ? 0 : 1);
    if (operations[index]!.method === "setItem") expect(result.value).toBe(operations[index]!.args[1]);
  }
  expect(await page.evaluate(() => Reflect.get(window, "syntheticStorageWrites"))).toBe(rejected.length);
  expect(await page.evaluate(() => Reflect.get(window, "syntheticStorageOperations"))).toEqual(operations);
});

test("live reads never persist private DTOs or mutate the API and unmount cancels scheduled reads", async ({ page }) => {
  await observeCalendarStorage(page);
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: {} }));
  await fixture(page);
  let reads = 0;
  const methods: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) { reads += 1; methods.push(request.method()); } });
  await openLive(page);
  expect(await page.evaluate(() => Reflect.get(window, "syntheticStorageWrites"))).toBe(0);
  expect(methods.every((method) => method === "GET")).toBe(true);
  const before = reads;
  await page.locator("#primary-navigation").getByRole("button", { name: /^(?:工作台|Workspace)$/ }).click();
  await expect(page.locator(".fc")).toHaveCount(0);
  await page.clock.fastForward(120000);
  expect(reads).toBe(before);
});

test("geometry assertions detect real small controls, page overflow and escaping event names", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const cases = [
    { main: "", button: "", student: "", expected: [] },
    { main: "width:400px", button: "", student: "", expected: ["page overflow"] },
    { main: "", button: "width:42px", student: "", expected: ["control bounds"] },
    { main: "", button: "", student: "position:absolute;left:122px", expected: ["lesson text overflow"] },
  ];
  for (const item of cases) {
    await page.setContent(`<style>body{margin:0;min-width:0}button{box-sizing:border-box;width:44px;height:44px}.fc-timegrid-event{position:relative;width:120px;height:80px}</style><main style="${item.main}"><button style="${item.button}">OK</button><article class="fc-timegrid-event" data-event-id="synthetic"><strong style="${item.student}">Name</strong></article></main>`);
    expect(await page.evaluate(measureLiveCalendarGeometry)).toEqual(item.expected);
  }
});

test("revocation also clears the selected teacher ID and closes private details during automatic refresh", async ({ page }) => {
  await fixture(page);
  await openLive(page);
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await page.locator("[data-event-id='E1']").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ status: 401, json: {} }));
  await page.clock.fastForward(60000);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("登录已失效");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(1);
});

function morningDirectoryFixture() {
  const data: CalendarFixture = calendarDto();
  data.teachers = Array.from({ length: 274 }, (_, index) => ({ id: `T${index + 1}`, name: `Synthetic Teacher ${index + 1}` }));
  const base = data.events[0]!;
  data.events = [
    { ...base, eventId: "MORNING7", teacherId: "T7", teacherName: data.teachers[6]!.name, startsAt: "2026-10-11T21:00:00.000Z", endsAt: "2026-10-11T21:30:00.000Z" },
    { ...base, eventId: "MORNING20", teacherId: "T20", teacherName: data.teachers[19]!.name, startsAt: "2026-10-11T22:00:00.000Z", endsAt: "2026-10-11T22:30:00.000Z" },
    { ...base, eventId: "NEXT100", teacherId: "T100", teacherName: data.teachers[99]!.name, startsAt: "2026-10-12T19:00:00.000Z", endsAt: "2026-10-12T19:30:00.000Z" },
  ];
  data.remainingAVA = [{ id: "AVA274", teacherId: "T274", startsAt: "2026-10-11T22:30:00.000Z", endsAt: "2026-10-11T23:30:00.000Z" }];
  return data;
}

function firstScreenLessonCount() {
  const navigation = document.querySelector(".mobile-bottom-nav");
  const navigationBox = navigation?.getBoundingClientRect();
  const bottom = Math.min(innerHeight, navigationBox?.height ? navigationBox.top : innerHeight);
  return [...document.querySelectorAll<HTMLElement>(".fc-timegrid-event[data-event-id]")].filter((event) => {
    const name = event.querySelector("strong")!.getBoundingClientRect();
    let left = Math.max(0, name.left), right = Math.min(innerWidth, name.right);
    let top = Math.max(0, name.top), end = Math.min(bottom, name.bottom);
    for (let parent = event.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); end = Math.min(end, box.bottom); }
    }
    if (right - left <= 20 || end - top <= 8) return false;
    return event.contains(document.elementFromPoint((left + right) / 2, (top + end) / 2));
  }).length;
}

test.describe("administrator first-screen lessons", () => {
  test.use({ timezoneId: "Australia/Melbourne" });
  for (const width of [1440, 320]) {
    test(`274 teachers expose morning lessons on the initial ${width}px screen`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
      await fixture(page, morningDirectoryFixture(), { user: "Nixon", role: "admin" });
      await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
      await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
      await page.goto("/#section=ava-calendar");
      await settleLazyCalendar(page);
      await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
      await expect(page.locator("[data-teacher]").first()).toHaveAttribute("data-teacher", "T7");
      await expect(page.getByRole("button", { name: "只看有课/AVA", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-teacher]")).toHaveCount(3);

      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`first-screen-morning-${width}.png`) });
      await info.attach("first-screen-geometry.json", { body: JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollY, scrollTop: document.querySelector(".fc-timegrid-body")?.closest(".fc-scroller")?.scrollTop, lesson: document.querySelector("[data-event-id='MORNING7']")?.getBoundingClientRect().toJSON() }))), contentType: "application/json" });
    });
  }

  for (const width of [1440, 320]) {
    test(`earlier AVA still leaves a real lesson painted on the initial ${width}px screen`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
      const data = morningDirectoryFixture();
      data.remainingAVA[0]!.startsAt = "2026-10-11T13:00:00.000Z";
      data.remainingAVA[0]!.endsAt = "2026-10-11T14:00:00.000Z";
      await fixture(page, data, { user: "Nixon", role: "admin" });
      await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
      await page.goto("/#section=ava-calendar");
      await settleLazyCalendar(page);
      await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
      await expect(page.locator("[data-teacher]").first()).toHaveAttribute("data-teacher", "T7");
      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`early-ava-morning-${width}.png`) });
    });
  }

  test("no-AVA status cannot cover the first lesson behind the 320px bottom navigation", async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const data = morningDirectoryFixture();
    data.remainingAVA = [];
    data.availabilityStatus = data.teachers.map(({ id }) => ({ teacherId: id, reason: "no_current_availability" }));
    await fixture(page, data, { user: "Nixon", role: "admin" });
    await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
    await page.goto("/#section=ava-calendar");
    await settleLazyCalendar(page);
    await expect(page.getByText("当前范围无可用 AVA", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath("no-ava-first-screen-320.png") });
    const outer = await page.evaluate(() => scrollY);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => scrollY)).toBe(outer);
  });

  for (const width of [1440, 320]) {
    test(`manual scroll survives refresh while timezone and date changes reveal lessons at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
      const data = morningDirectoryFixture();
      await fixture(page, data, { user: "Nixon", role: "admin" });
      await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
      await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
      await page.goto("/#section=ava-calendar");
      await settleLazyCalendar(page);
      await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
      await page.getByRole("button", { name: "只看有课/AVA", exact: true }).click();
      const viewport = page.getByLabel("日历滚动区域", { exact: true });
      await viewport.evaluate((element) => { element.scrollLeft = element.querySelector("[data-teacher]")!.getBoundingClientRect().width; });
      await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await page.locator(".fc-timegrid-body").first().evaluate((element) => { element.closest(".fc-scroller")!.scrollTop = 1200; });
      const tops = () => page.locator(".fc-timegrid-body").evaluateAll((elements) => elements.map((element) => element.closest(".fc-scroller")!.scrollTop));
      await expect.poll(tops).toEqual((await tops()).map(() => 1200));
      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBe(0);
      data.events[0]!.startsAt = "2026-10-11T23:00:00.000Z";
      data.events[0]!.endsAt = "2026-10-11T23:30:00.000Z";
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
      await expect(page.locator("[data-teacher]").first()).toHaveAttribute("data-teacher", "T20");
      await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0);
      await expect.poll(tops).toEqual((await tops()).map(() => 1200));
      await page.getByRole("button", { name: "只看有课/AVA", exact: true }).click();
      await expect.poll(tops).toEqual([1200, 1200, 1200]);
      await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("Asia/Shanghai");
      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
      await expect(page.locator("[data-event-id='MORNING20']")).toHaveAttribute("data-start", "2026-10-11T22:00:00.000Z");
      await page.screenshot({ path: info.outputPath(`timezone-morning-${width}.png`) });
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-13");
      await expect(page.locator("[data-teacher]").first()).toHaveAttribute("data-teacher", "T100");
      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
      await page.getByRole("button", { name: "上一页", exact: true }).click();
      await expect.poll(() => page.evaluate(firstScreenLessonCount)).toBeGreaterThan(0);
    });
  }

  test("active columns retain full-directory access and recover from date changes and empty days", async ({ page }) => {
    await fixture(page, morningDirectoryFixture(), { user: "Nixon", role: "admin" });
    await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
    await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
    await page.goto("/#section=ava-calendar");
    await settleLazyCalendar(page);
    const active = page.getByRole("button", { name: "只看有课/AVA", exact: true });
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await active.click();
    await expect(active).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-teacher]").first()).toHaveAttribute("data-teacher", "T7");
    const viewport = page.getByLabel("日历滚动区域", { exact: true });
    await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(page.locator(".fc-col-header-cell-cushion").last()).toHaveText("Synthetic Teacher 273");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-13");
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0);
    await expect(page.locator("[data-teacher]").first()).toHaveAttribute("data-teacher", "T100");
    await expect(page.locator("[data-event-id='NEXT100']")).toHaveCount(1);
    await active.click();
    await expect(page.locator("[data-teacher]")).toHaveCount(1);
    await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
    await expect(active).toHaveCount(0);
    await expect(page.locator("[data-teacher='T1']")).toHaveCount(1);
    await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("");
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-14");
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.locator("[data-event-id='NEXT100']")).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(275);
  });
});

test("273 teachers use bounded parallel columns and one range payload without per-teacher reads", async ({ page }) => {
  const data = calendarDto();
  data.teachers = Array.from({ length: 273 }, (_, index) => ({ id: `T${index + 1}`, name: `Synthetic Teacher ${index + 1}` }));
  await fixture(page, data, { user: "Nixon", role: "admin" });
  await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
  await page.goto("/ava-calendar/live");
  await settleLazyCalendar(page);
  await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(274);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "只看有课/AVA", exact: true }).click();
  expect(await page.locator(".fc").count()).toBeLessThanOrEqual(8);
  let reads = 0;
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) reads += 1; });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  expect(reads).toBe(1);
  await page.getByLabel("日历滚动区域", { exact: true }).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(page.locator(".fc-col-header-cell-cushion").last()).toHaveText("Synthetic Teacher 273");
  expect(await page.locator(".fc").count()).toBeLessThanOrEqual(8);
  expect(reads).toBe(1);
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T273");
  await expect(page.locator(".fc")).toHaveCount(1);
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
  expect(reads).toBeLessThanOrEqual(2);
});


test("all teachers can switch every view and a dense month keeps every course reachable", async ({ page }) => {
  const data = calendarDto();
  data.teachers[1]!.name = "Synthetic Last";
  data.events.push({ ...structuredClone(data.events[0]!), eventId: "OTHER-TEACHER", teacherId: "T2", teacherName: "Synthetic Last" });
  data.events.push(...Array.from({ length: 11 }, (_, index) => ({ ...structuredClone(data.events[0]!), eventId: `DENSE-${index}` })));
  await fixture(page, data, { user: "Nixon", role: "admin" });
  await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
  await page.goto("/#section=ava-calendar");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.getByLabel("日期", { exact: true }).fill("2026-10-12");
  for (const view of ["timeGridDay", "timeGridThreeDay", "timeGridWeek", "dayGridMonth"]) {
    const choice = page.locator(`button[data-view="${view}"]`);
    await choice.click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("");
    await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-10-12");
    await expect(page.locator(`.fc-${view}-view`)).toHaveCount(view === "timeGridDay" ? 2 : 1);
  }
  await expect(page.locator(".fc-more-link").first()).toBeVisible();
  await page.locator(".fc-more-link").first().click();
  const popover = page.locator(".fc-more-popover");
  await expect(popover).toBeVisible();
  const ids = await popover.locator("[data-event-id]").evaluateAll((events) => [...new Set(events.map((event) => event.getAttribute("data-event-id")))].sort());
  expect(ids).toEqual(data.events.map(({ eventId }) => eventId).sort());
  const body = popover.locator(".fc-popover-body");
  await expect(body).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const fits = () => popover.evaluate((element) => { const bounds = element.getBoundingClientRect(); const viewport = visualViewport ?? { offsetTop: 0, height: innerHeight }; return bounds.top >= viewport.offsetTop && bounds.bottom <= viewport.offsetTop + viewport.height + 1 && bounds.left >= 0 && bounds.right <= innerWidth + 1; });
  await expect.poll(fits).toBe(true);
  const last = popover.locator("[data-event-id]").last();
  const lastId = await last.getAttribute("data-event-id");
  await last.click();
  await expect(page.getByRole("dialog")).toContainText(data.events.find((event) => event.eventId === lastId)!.students[0]!.studentName);
  await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  await page.locator(".fc-more-link").first().click();
  await popover.locator("[data-event-id='OTHER-TEACHER']").click();
  await expect(page.getByRole("dialog")).toContainText("Synthetic Last");
  await expect(page.getByRole("dialog")).toContainText("合成学生1");
  await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator(".fc-more-link").first().click();
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 320, height: 480 });
  await expect.poll(fits).toBe(true);
  await popover.locator("[data-event-id]").last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
  await page.locator(".fc-more-link").first().click();
  await popover.locator(".fc-popover-close").click();
  await expect(popover).toHaveCount(0);
});

test("date view and timezone navigation preserve the mounted single calendar and selected day", async ({ page }) => {
  await fixture(page);
  await openLive(page);
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await page.getByLabel("日期", { exact: true }).fill("2026-11-18");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.locator(".fc").evaluate((element) => { (element as HTMLElement).dataset.navigationWitness = "same-calendar"; });
  for (const zone of ["UTC", "Europe/London", "Australia/Melbourne"]) {
    await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption(zone);
    for (const view of ["timeGridThreeDay", "timeGridWeek", "dayGridMonth", "timeGridDay"]) {
      await page.locator(`button[data-view="${view}"]`).click();
      await expect(page.locator(".fc")).toHaveAttribute("data-navigation-witness", "same-calendar");
      await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-11-18");
      await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    }
  }
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByLabel("日期", { exact: true })).toHaveValue("2026-11-19");
  await expect(page.locator(".fc")).toHaveAttribute("data-navigation-witness", "same-calendar");
});

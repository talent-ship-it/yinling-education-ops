import { expect, test, type Page } from "@playwright/test";

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

function sliceReply(data: ReturnType<typeof calendarDto>, url: string) {
  const params = new URL(url).searchParams;
  const start = Date.parse(params.get("start")!);
  const end = Date.parse(params.get("end")!);
  return { ...data, events: data.events.filter((event) => Date.parse(event.startsAt) < end && Date.parse(event.endsAt) > start), remainingAVA: data.remainingAVA.flatMap((interval) => {
    const a = Math.max(start, Date.parse(interval.startsAt));
    const b = Math.min(end, Date.parse(interval.endsAt));
    return a < b ? [{ ...interval, startsAt: new Date(a).toISOString(), endsAt: new Date(b).toISOString() }] : [];
  }) };
}

async function fixture(page: Page, data = calendarDto()) {
  await page.clock.install({ time: new Date("2026-10-12T02:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
  await page.route("**/api/demo-session", (route) => route.fulfill({ json: { ok: true, user: "Synthetic Teacher", role: "teacher", mustChangePassword: false } }));
  await page.route("**/api/demo-logout", (route) => route.fulfill({ json: { serverSessionRevoked: true } }));
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: sliceReply(data, route.request().url()) }));
  return data;
}

async function openLive(page: Page) {
  await page.goto("/ava-calendar/live");
  await expect(page.locator(".fc")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("Australia/Melbourne");
  await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("timeGridDay");
  await page.getByLabel("日期", { exact: true }).fill("2026-10-12");
}

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
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("读取超时，请重试。");
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

test("portrait and landscape controls and 15/30/45/60-minute text stay within their actual bounds", async ({ page }, info) => {
  const data = calendarDto();
  const base = data.events[0]!;
  data.events = [["04:00", "04:15"], ["04:15", "04:30"], ["04:30", "05:00"], ["05:00", "05:45"], ["05:45", "06:45"]].map(([start, end], index) => ({ ...base, eventId: `SHORT${index}`, startsAt: `2026-10-12T${start}:00.000Z`, endsAt: `2026-10-12T${end}:00.000Z`, students: [{ ...base.students[0]!, studentId: `SS${index}`, studentName: `合成时长学生${index}` }], trial: true }));
  await fixture(page, data);
  await openLive(page);
  for (const [width, height] of [[320, 568], [390, 844], [568, 320], [844, 390], [1280, 800]]) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const view of ["timeGridDay", "timeGridWeek"]) {
      await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption(view);
      await page.clock.runFor(50);
      await expect(page.locator(".fc-timegrid-event[data-event-id]")).toHaveCount(5);
      const geometry = await page.evaluate(measureLiveCalendarGeometry);
      expect(geometry, `${width}x${height} ${view}`).toEqual([]);
      const a = await page.locator("[data-event-id='SHORT0']").boundingBox();
      const b = await page.locator("[data-event-id='SHORT1']").boundingBox();
      expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(1);
      expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 1);
      expect(await page.locator("[data-event-id='SHORT0']").getAttribute("data-end")).toBe("2026-10-12T04:15:00.000Z");
      if (view === "timeGridWeek" && [320, 844, 1280].includes(width!)) await page.screenshot({ path: info.outputPath(`${width}x${height}-week.png`), fullPage: true });
    }
  }
  await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("timeGridDay");
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

test("all navigation views and selected timezone retain teacher scope and both calendar scroll positions", async ({ page }) => {
  await fixture(page);
  await openLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("timeGridWeek");
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
  await expect.poll(() => vertical.evaluate((element) => element.scrollTop)).toBe(300);
  for (const [view, css] of [["timeGridDay", ".fc-timeGridDay-view"], ["timeGridThreeDay", ".fc-timeGridThreeDay-view"], ["dayGridMonth", ".fc-dayGridMonth-view"]]) {
    await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption(view!);
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
  await openLive(page);
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const windows: { start: string; end: string }[] = [];
  await page.route("**/api/ava-calendar?**", async (route) => {
    reads += 1;
    const params = new URL(route.request().url()).searchParams;
    windows.push({ start: params.get("start")!, end: params.get("end")! });
    if (reads === 5) await pending;
    await route.fulfill({ json: sliceReply(data, route.request().url()) });
  });
  try {
    await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("dayGridMonth");
    await expect.poll(() => reads).toBe(5);
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
  await page.route("**/api/ava-calendar?**", (route) => { conflicts += 1; return route.fulfill({ status: 409, json: {} }); });
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

test("live reads never persist private DTOs or mutate the API and unmount cancels scheduled reads", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "syntheticStorageWrites", { configurable: true, value: 0, writable: true });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      Reflect.set(window, "syntheticStorageWrites", Number(Reflect.get(window, "syntheticStorageWrites")) + 1);
      return original.call(this, key, value);
    };
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: {} }));
  await fixture(page);
  let reads = 0;
  const methods: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) { reads += 1; methods.push(request.method()); } });
  await openLive(page);
  expect(await page.evaluate(() => Reflect.get(window, "syntheticStorageWrites"))).toBe(0);
  expect(methods.every((method) => method === "GET")).toBe(true);
  const before = reads;
  await page.getByRole("link", { name: "工作台", exact: true }).click();
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

test("273 visible teacher options use one calendar and one window payload, never a hardcoded six-column grid", async ({ page }) => {
  const data = calendarDto();
  data.teachers = Array.from({ length: 273 }, (_, index) => ({ id: `T${index + 1}`, name: `Synthetic Teacher ${index + 1}` }));
  await fixture(page, data);
  await openLive(page);
  await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(274);
  let reads = 0;
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) reads += 1; });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  expect(reads).toBe(1);
  await expect(page.locator(".fc")).toHaveCount(1);
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T273");
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
  expect(reads).toBe(1);
});

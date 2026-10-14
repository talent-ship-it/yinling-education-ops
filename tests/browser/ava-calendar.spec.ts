import { expect, test, type Page } from "@playwright/test";

test("requires the existing real login and protects the new calendar API", async ({ page }) => {
  const response = await page.goto("/ava-calendar");
  expect(response?.status()).toBe(200);
  await expect(page.getByLabel("登录密码")).toBeVisible();
  await expect(page.getByRole("heading", { name: "课程日历", exact: true })).toHaveCount(0);
  const api = await page.request.get("/api/ava-calendar?start=2026-10-11T00:00:00.000Z&end=2026-10-18T00:00:00.000Z");
  expect(api.status()).toBe(401);
  expect(api.headers()["cache-control"]).toContain("no-store");
  const body = await api.json();
  expect(body).not.toHaveProperty("events");
});

function measureCalendarGeometry() {
  function controlOutOfBounds(box: DOMRect) {
    return box.width < 43 || box.height < 43 || box.left < -1 || box.right > window.innerWidth + 1;
  }
  function lessonOutOfBounds(box: DOMRect, child: DOMRect) {
    return child.left < box.left - 1 || child.right > box.right + 1 || child.top < box.top - 1 || child.bottom > box.bottom + 1;
  }
  function controlViolations() {
    const violations: string[] = [];
    for (const element of document.querySelectorAll("main button, main select")) {
      const box = element.getBoundingClientRect();
      if (controlOutOfBounds(box)) violations.push("control bounds");
    }
    return violations;
  }
  function lessonViolations() {
    const violations: string[] = [];
    for (const card of document.querySelectorAll("[data-event-id]")) {
      const box = card.getBoundingClientRect();
      for (const element of card.querySelectorAll("strong, span, time, b")) {
        const child = element.getBoundingClientRect();
        if (lessonOutOfBounds(box, child)) violations.push("lesson overflow");
      }
    }
    return violations;
  }
  const violations: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) violations.push("page overflow");
  return [...violations, ...controlViolations(), ...lessonViolations()];
}

async function fixture(page: Page) {
  await page.clock.install({ time: new Date("2026-10-11T10:00:00.000Z") });
  await page.route("**/api/demo-session", (route) => route.fulfill({ json: { ok: true, user: "Synthetic Teacher", role: "teacher", mustChangePassword: false } }));
  const calendar = {
    teachers: [{ id: "T1", name: "Synthetic Teacher" }, { id: "T2", name: "Synthetic Other" }],
    events: [
      { eventId: "E1", startsAt: "2026-10-11T04:00:00.000Z", endsAt: "2026-10-11T04:15:00.000Z", teacherId: "T1", teacherName: "Synthetic Teacher", trial: true, identityPending: false, students: [{ studentId: "S1", studentName: "Synthetic Long Student Name 晓琳", owner: "Tiffany", ownerId: "C1", color: "owner-1" }] },
      { eventId: "E2", startsAt: "2026-10-11T04:15:00.000Z", endsAt: "2026-10-11T05:00:00.000Z", teacherId: "T1", teacherName: "Synthetic Teacher", trial: false, identityPending: false, students: [{ studentId: "S2", studentName: "Synthetic Two", owner: null, ownerId: null, color: "owner-unassigned" }] },
      { eventId: "E3", startsAt: "2026-10-11T05:00:00.000Z", endsAt: "2026-10-11T06:00:00.000Z", teacherId: "T2", teacherName: "Synthetic Other", trial: false, identityPending: true, students: [] },
    ],
    source: { revision: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-11T02:00:00.000Z", freshness: "fresh", coverage: "complete" },
  };
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: calendar }));
  return calendar;
}

test("opens the separate calendar after login and shows student ownership in the display timezone", async ({ page }) => {
  await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByRole("heading", { name: "课程日历", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("Australia/Melbourne");
  await expect(page.getByText("Synthetic Long Student Name 晓琳", { exact: true })).toBeVisible();
  await expect(page.getByText("15:00–15:15", { exact: true })).toBeVisible();
  await expect(page.getByText("试听", { exact: true })).toBeVisible();
  await expect(page.getByText("教务待分配", { exact: true })).toBeVisible();
  await expect(page.getByText("学生待确认", { exact: true })).toBeVisible();
  await expect(page.locator("[data-owner-color='owner-1']")).toHaveCount(1);
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await expect(page.locator("[data-event-id]")).toHaveCount(2);
});

test("phone layouts keep controls and lesson text inside their containers", async ({ page }, info) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ava-calendar");
  await expect(page.getByRole("heading", { name: "课程日历", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeInViewport({ ratio: 1 });
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [568, 320], [844, 390], [1280, 800]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
    const geometry = await page.evaluate(measureCalendarGeometry);
    expect(geometry, `${width}x${height}`).toEqual([]);
    if (width === 390) await page.screenshot({ path: info.outputPath("phone-calendar.png"), fullPage: true });
  }
});

test("a revoked session clears the previous private calendar instead of retaining stale names", async ({ page }) => {
  await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ status: 401, json: { error: "Expired" } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("登录已失效");
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
  await expect(page.getByText("Synthetic Two", { exact: true })).toHaveCount(0);
});

test("current ownership refreshes automatically without a manual reassignment control", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Tiffany", { exact: true })).toBeVisible();
  data.events[0]!.students[0]!.owner = "Ella";
  data.events[0]!.students[0]!.color = "owner-2";
  await page.clock.fastForward(61000);
  await expect(page.getByText("Ella", { exact: true })).toBeVisible();
  await expect(page.locator("[data-owner-color='owner-2']")).toHaveCount(1);
  await expect(page.getByText("Tiffany", { exact: true })).toHaveCount(0);
});

test("timezone conversion preserves the real duration across daylight saving changes", async ({ page }) => {
  const data = await fixture(page);
  data.events = [{ ...data.events[0]!, startsAt: "2026-10-03T15:30:00.000Z", endsAt: "2026-10-03T16:30:00.000Z" }];
  await page.goto("/ava-calendar");
  await expect(page.getByRole("heading", { name: "课程日历", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("Australia/Melbourne");
  await page.getByRole("button", { name: "上一周", exact: true }).click();
  await expect(page.getByText("01:30–03:30", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("UTC");
  await expect(page.getByText("15:30–16:30", { exact: true })).toBeVisible();
});

test("lesson identity displays every student owner and retains pending teacher details", async ({ page }) => {
  const data = await fixture(page);
  const event = { ...data.events[0]!, teacherName: "", identityPending: true, students: [data.events[0]!.students[0]!, data.events[1]!.students[0]!] };
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: { ...data, events: [event] } }));
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Long Student Name 晓琳", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await expect(page.getByText("Tiffany", { exact: true })).toBeVisible();
  await expect(page.getByText("教务待分配", { exact: true })).toBeVisible();
  await expect(page.getByText("老师待确认", { exact: true })).toBeVisible();
  await expect(page.getByText("身份待确认", { exact: true })).toBeVisible();
  await expect(page.locator("[data-owner-color='owner-1']")).toHaveCount(1);
  await expect(page.locator("[data-owner-color='owner-unassigned']")).toHaveCount(1);
  await expect(page.getByText("试听", { exact: true })).toBeVisible();
});

test("refresh clears private lessons while loading and restores the user's horizontal position", async ({ page }) => {
  const data = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  const calendar = page.getByLabel("周日历", { exact: true });
  await calendar.evaluate((element) => { element.scrollLeft = 280; });
  await expect.poll(() => calendar.evaluate((element) => element.scrollLeft)).toBe(280);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ava-calendar?**", async (route) => {
    await pending;
    await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("正在读取…");
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
  await expect(page.getByText("Synthetic Two", { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await expect.poll(() => calendar.evaluate((element) => element.scrollLeft)).toBe(280);
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("UTC");
  await expect.poll(() => calendar.evaluate((element) => element.scrollLeft)).toBe(280);
});

test("invalid responses and server errors clear private data and allow a successful retry", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  const failures = [
    { status: 503, json: { error: "Synthetic unavailable" }, message: "Synthetic unavailable" },
    { status: 503, json: {}, message: "课表暂时无法读取。" },
    { status: 200, json: { teachers: data.teachers, source: data.source }, message: "课表暂时无法读取。" },
    { status: 200, json: { events: data.events, source: data.source }, message: "课表暂时无法读取。" },
    { status: 200, json: { events: data.events, teachers: data.teachers }, message: "课表暂时无法读取。" },
  ];
  for (const failure of failures) {
    await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ status: failure.status, json: failure.json }));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(failure.message);
    await expect(page.locator("[data-event-id]")).toHaveCount(0);
    await expect(page.getByText("Synthetic Two", { exact: true })).toHaveCount(0);
    await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: data }));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  }
});

test("a superseded week request cannot overwrite the current calendar", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const outdated = { ...data, events: [] };
  await page.route("**/api/ava-calendar?**", async (route) => {
    requests += 1;
    if (requests === 1) {
      await pending;
      await route.fulfill({ json: outdated });
      return;
    }
    await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "下一周", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole("status")).toHaveText("正在读取…");
  await page.getByRole("button", { name: "上一周", exact: true }).click();
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator("[data-event-id]")).toHaveCount(3);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("the fifty-second abort clears private lessons and leaves retry available", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ava-calendar?**", async (route) => {
    await pending;
    await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("正在读取…");
  await page.clock.fastForward(50001);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("读取超时，请重试。");
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  release();
  await page.unrouteAll({ behavior: "wait" });
});

test("automatic refresh does not overlap a pending manual read", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await page.clock.fastForward(30000);
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ava-calendar?**", async (route) => {
    reads += 1;
    await pending;
    await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByRole("status")).toHaveText("正在读取…");
  await page.clock.fastForward(31000);
  expect(reads).toBe(1);
  await expect(page.getByRole("status")).toHaveText("正在读取…");
  release();
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  expect(reads).toBe(1);
});

test("automatic refresh runs at sixty seconds only while the document is visible", async ({ page }) => {
  const data = await fixture(page);
  let reads = 0;
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) reads += 1; });
  await page.goto("/ava-calendar");
  await expect(page.getByText("Tiffany", { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  data.events[0]!.students[0]!.owner = "Ella";
  await page.clock.fastForward(59999);
  expect(reads).toBe(1);
  await page.clock.fastForward(1);
  await expect(page.getByText("Ella", { exact: true })).toBeVisible();
  expect(reads).toBe(2);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  await page.clock.fastForward(60000);
  expect(reads).toBe(2);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }));
  await page.clock.fastForward(60000);
  await expect.poll(() => reads).toBe(3);
});

test("week navigation uses the selected timezone's current Monday and retains teacher scope", async ({ page }) => {
  await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await page.clock.setSystemTime(new Date("2026-10-11T16:30:00.000Z"));
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("Australia/Melbourne");
  await page.getByRole("button", { name: "本周", exact: true }).click();
  await expect(page.getByText("10-12 — 10-18", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一周", exact: true }).click();
  await expect(page.getByText("10-05 — 10-11", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("T1");
  await expect(page.locator("[data-event-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "下一周", exact: true }).click();
  await expect(page.getByText("10-12 — 10-18", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("UTC");
  await page.getByRole("button", { name: "本周", exact: true }).click();
  await expect(page.getByText("10-05 — 10-11", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("T1");
  await expect(page.locator("[data-event-id]")).toHaveCount(2);
});

test("source freshness and coverage warnings retain the authorized calendar", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: { ...data, source: { ...data.source, freshness: "stale", coverage: "partial" } } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("课表来源已过期。");
  await expect(page.locator("[data-event-id]")).toHaveCount(3);
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: { ...data, source: { ...data.source, coverage: "partial" } } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("部分日期超出课表来源范围。");
  await expect(page.locator("[data-event-id]")).toHaveCount(3);
});

test("cross-midnight lessons clip to each day and exclude an exact midnight end", async ({ page }) => {
  const data = await fixture(page);
  const event = { ...data.events[0]!, startsAt: "2026-10-11T23:45:00.000Z", endsAt: "2026-10-12T00:30:00.000Z" };
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: { ...data, events: [event] } }));
  await page.goto("/ava-calendar");
  await expect(page.getByRole("heading", { name: "课程日历", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "时区", exact: true }).selectOption("UTC");
  await page.getByRole("button", { name: "本周", exact: true }).click();
  await expect(page.getByText("23:45–24:00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一周", exact: true }).click();
  await expect(page.getByText("00:00–00:30", { exact: true })).toBeVisible();
  await page.route("**/api/ava-calendar?**", (route) => route.fulfill({ json: { ...data, events: [{ ...event, endsAt: "2026-10-12T00:00:00.000Z" }] } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
});

test("unmount cancels the calendar's scheduled refresh", async ({ page }) => {
  await fixture(page);
  let reads = 0;
  page.on("request", (request) => { if (request.url().includes("/api/ava-calendar?")) reads += 1; });
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "课程日历", exact: true })).toHaveCount(0);
  await page.clock.fastForward(120000);
  expect(reads).toBe(1);
});

test("geometry measurements detect page overflow, undersized controls and escaping lesson text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const cases = [
    { main: "", button: "", student: "", violations: [] },
    { main: "width:400px", button: "", student: "", violations: ["page overflow"] },
    { main: "", button: "width:42px", student: "", violations: ["control bounds"] },
    { main: "", button: "", student: "position:absolute;left:122px", violations: ["lesson overflow"] },
  ];
  for (const item of cases) {
    await page.setContent(`<style>body{margin:0}button{box-sizing:border-box;width:44px;height:44px}article{position:relative;width:120px;height:80px}</style><main style="${item.main}"><button style="${item.button}">OK</button><article data-event-id="synthetic"><strong style="${item.student}">Name</strong></article></main>`);
    expect(await page.evaluate(measureCalendarGeometry)).toEqual(item.violations);
  }
});

test("mobile portrait and landscape controls measure at least forty-four pixels", async ({ page }, info) => {
  await fixture(page);
  await page.goto("/ava-calendar");
  await expect(page.getByText("Synthetic Two", { exact: true })).toBeVisible();
  const measurements = [];
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [568, 320], [844, 390]]) {
    await page.setViewportSize({ width: width!, height: height! });
    const bounds = await page.locator("main button, main select").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }));
    for (const box of bounds) {
      expect(box.width, `${width}x${height}`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${width}x${height}`).toBeGreaterThanOrEqual(44);
    }
    measurements.push({ width, height, bounds });
  }
  await info.attach("mobile-control-geometry", { body: JSON.stringify(measurements), contentType: "application/json" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: info.outputPath("desktop-calendar.png"), fullPage: true });
});

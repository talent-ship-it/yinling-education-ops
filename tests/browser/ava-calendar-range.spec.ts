import { expect, test, type Page } from "@playwright/test";
import { fixture, serverFixture, event, teacher } from "../ava-calendar-server-fixture";

const instants = ["2026-10-01T02:00:00.000Z", "2026-10-03T15:30:00.000Z", "2026-10-07T13:30:00.000Z", "2026-10-12T04:00:00.000Z", "2026-10-21T05:00:00.000Z", "2026-10-25T00:30:00.000Z"];
const expected = instants.map((startsAt, index) => ({ eventId: `range-course-${index}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() }));
function producer(suffix = "") {
  const state = fixture();
  state.now = Date.parse("2026-10-12T00:00:01Z");
  state.rows = structuredClone(state.rows);
  const students = state.rows.find(({ entity }) => entity === "students")!.payload as Record<string, unknown>[];
  students[0]!.name = `Synthetic Student${suffix}`;
  state.rows.find(({ entity }) => entity === "teachers")!.payload = Array.from({ length: 274 }, (_, index) => ({ ...teacher, id: index ? `T${index + 1}` : "T1", name: index ? `Synthetic Teacher ${index + 1}` : teacher.name, jiaowubaoOpenApi: { ...teacher.jiaowubaoOpenApi, sourceId: String(901 + index) }, availabilityWindows: index ? [] : structuredClone(teacher.availabilityWindows) }));
  state.rows.find(({ entity }) => entity === "bookings")!.payload = [{ id: "B-hidden", date: "2026-10-12", start: "05:00", timezone: "UTC", duration: 30, teacherId: "T1", studentId: "S1", status: "confirmed" }];
  state.page = { ...state.page, sourceWindow: { start: "2026-09-01", end: "2026-12-31" }, events: expected.map((item) => ({ ...event, ...item, sourceDate: item.startsAt.slice(0, 10), sourceParticipants: [{ memberId: "101", label: `Synthetic Student${suffix}` }] })) };
  return state;
}
function workspaceSnapshot() {
  return { students: [], teachers: [], versions: { students: 1, teachers: 1, tasks: 1, bookings: 1, lpItems: 1 }, managedExamSnapshot: { versions: { students: 1, tasks: 1 }, students: [] }, managedTrialPaymentSnapshot: { versions: { bookings: 1, students: 1, lpItems: 1, tasks: 1 }, students: [] } };
}
type Receipt = { path: string; status: number; window: { start: string; end: string }; calls: Record<string, number> };
async function setup(page: Page) {
  let suffix = "";
  let revoked = false;
  const requests: Receipt[] = [];
  const replies: Record<string, unknown>[] = [];
  const external: string[] = [];
  const actual = async (url: string) => {
    const parsed = new URL(url);
    const window = { start: parsed.searchParams.get("start")!, end: parsed.searchParams.get("end")! };
    const server = serverFixture(producer(suffix), (rpc, body) => {
      if (rpc === "get_ops_state") expect(Object.keys(body).sort()).toEqual(["p_entities", "p_secret"]);
      if (revoked && rpc === "read_account_session") return Response.json([]);
    }, true);
    const response = await (parsed.pathname.endsWith("/range") ? server.getRange(window) : server.get("human", window));
    const json = await response.json();
    const calls: Record<string, number> = {};
    for (const { rpc } of server.calls) calls[rpc] = (calls[rpc] ?? 0) + 1;
    requests.push({ path: parsed.pathname, window, status: response.status, calls });
    replies.push(json);
    return { status: response.status, json };
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") { external.push(url.origin); return route.abort("blockedbyclient"); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/demo-session") return route.fulfill({ json: { ok: true, user: "Synthetic Administrator", role: "admin", mustChangePassword: false } });
    if (url.pathname === "/api/nixon-session") return route.fulfill({ json: { ok: true } });
    if (url.pathname === "/api/app-snapshot") return route.fulfill({ json: workspaceSnapshot() });
    if (["/api/ava-calendar", "/api/ava-calendar/range"].includes(url.pathname)) return route.fulfill(await actual(url.href));
    return route.fulfill({ status: 403, json: { error: "offline_unbound_api" } });
  });
  await page.clock.install({ time: new Date("2026-10-12T00:00:01Z") });
  await page.goto("/#section=ava-calendar");
  await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(275);
  await expect(page.locator(".fc").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "老师", exact: true }).selectOption("T1");
  await expect(page.getByRole("combobox", { name: "日历视图", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("Australia/Melbourne");
  await page.getByLabel("日期", { exact: true }).fill("2026-10-12");
  await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("dayGridMonth");
  await complete(page);
  return { requests, replies, external, actual, setSuffix: (value: string) => { suffix = value; }, revoke: () => { revoked = true; } };
}
async function complete(page: Page) {
  await expect(page.locator("[data-event-id]")).toHaveCount(expected.length);
  const seen = await page.locator("[data-event-id]").evaluateAll((elements) => elements.map((element) => ({ eventId: element.getAttribute("data-event-id"), startsAt: element.getAttribute("data-start"), endsAt: element.getAttribute("data-end") })).sort((left, right) => left.eventId!.localeCompare(right.eventId!)));
  expect(seen).toEqual(expected);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
}
async function pause(page: Page) {
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
}

test("actual old-reader month keeps all courses, occupancy and instants through day three-day week month timezone round-trips", async ({ page }, info) => {
  const f = await setup(page);
  const month = f.requests.filter(({ path }) => path.endsWith("/range")).at(-1)!;
  expect(month.status).toBe(200);
  expect(month.calls.get_ops_state).toBe(1);
  expect(month.calls.get_jiaowubao_open_api_schedule_snapshot_window).toBe(5);
  const reply = f.replies.at(-1)! as { slices: { events: { eventId: string; startsAt: string; endsAt: string }[]; remainingAVA: { teacherId: string; startsAt: string; endsAt: string }[] }[] };
  expect(reply.slices).toHaveLength(5);
  const rawEvents = reply.slices.flatMap(({ events }) => events);
  expect(rawEvents).toHaveLength(7);
  const uniqueEvents = [...new Map(rawEvents.map(({ eventId, startsAt, endsAt }) => [eventId, { eventId, startsAt, endsAt }])).values()];
  expect(uniqueEvents).toHaveLength(expected.length);
  expect(uniqueEvents).toEqual(expected);
  const remaining = reply.slices.flatMap(({ remainingAVA }) => remainingAVA);
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.every((item) => Date.parse(item.endsAt) <= Date.parse("2026-10-12T05:00:00Z") || Date.parse(item.startsAt) >= Date.parse("2026-10-12T05:30:00Z"))).toBe(true);
  for (const zone of ["UTC", "Europe/London", "Australia/Melbourne"]) {
    await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption(zone);
    await complete(page);
    await page.locator("[data-event-id='range-course-3']").click();
    await expect(page.getByRole("dialog")).toContainText("Synthetic Student");
    await expect(page.getByRole("dialog")).toContainText("60 分钟");
    await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
    await page.screenshot({ path: info.outputPath(`month-${zone.replace("/", "-")}.png`), fullPage: true });
  }
  for (const [view, selector] of [["timeGridDay", ".fc-timeGridDay-view"], ["timeGridThreeDay", ".fc-timeGridThreeDay-view"], ["timeGridWeek", ".fc-timeGridWeek-view"], ["dayGridMonth", ".fc-dayGridMonth-view"]]) {
    await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption(view!);
    await expect(page.locator(selector!)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("T1");
  }
  await complete(page);
  expect(f.external).toEqual([]);
  await info.attach("actual-old-reader-month.json", { body: JSON.stringify({ requests: f.requests, expected, external: f.external }), contentType: "application/json" });
});

test("shipping fifty-second month cancellation clears the group and ignores a completed late reply", async ({ page }, info) => {
  const f = await setup(page);
  await pause(page);
  await page.locator("[data-event-id='range-course-3']").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const body = structuredClone(f.replies.at(-1));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route("**/api/ava-calendar/range?**", async (route) => { reads++; await pending; await route.fulfill({ json: body }).catch(() => {}); });
  try {
    await page.clock.fastForward(60000);
    await expect.poll(() => reads).toBe(1);
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("Synthetic Student", { exact: true })).toHaveCount(0);
    await page.clock.fastForward(50001);
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "读取超时，请重试。" })).toHaveText("读取超时，请重试。");
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    release();
    await page.unroute("**/api/ava-calendar/range?**");
    await page.clock.runFor(100);
    await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await complete(page);
    await page.screenshot({ path: info.outputPath("month-recovered-after-cancellation.png"), fullPage: true });
    expect(f.external).toEqual([]);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  await info.attach("cancellation.json", { body: JSON.stringify({ shippingAbortMs: 50000, reads, lateReplySuppressed: true }), contentType: "application/json" });
});

test("range conflict retries once and a superseded month cannot replace the newer result", async ({ page }, info) => {
  const f = await setup(page);
  let conflicts = 0;
  await page.route("**/api/ava-calendar/range?**", (route) => { conflicts++; return route.fulfill({ status: 409, json: {} }); });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("课表或身份已更新");
  expect(conflicts).toBe(2);
  await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
  await page.unroute("**/api/ava-calendar/range?**");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const old = structuredClone(f.replies.at(-1));
  await page.route("**/api/ava-calendar/range?**", async (route) => {
    reads++;
    if (reads === 1) { await pending; await route.fulfill({ json: old }).catch(() => {}); }
    else await route.fulfill(await f.actual(route.request().url()));
  });
  try {
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    f.setSuffix(" NEW");
    await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("UTC");
    await complete(page);
    await expect(page.locator("[data-event-id='range-course-3']")).toContainText("Synthetic Student NEW");
    release();
    await page.clock.runFor(100);
    await complete(page);
    await expect(page.locator("[data-event-id='range-course-3']")).toContainText("Synthetic Student NEW");
    expect(f.external).toEqual([]);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  await info.attach("retry-supersession.json", { body: JSON.stringify({ conflicts, reads, lateReplySuppressed: true }), contentType: "application/json" });
});

test("a new month read observes session revocation immediately and removes all private state", async ({ page }) => {
  const f = await setup(page);
  f.revoke();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("登录已失效");
  await expect(page.locator("[data-event-id], [data-ava-id]")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "老师", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "老师", exact: true }).locator("option")).toHaveCount(1);
  expect(f.requests.at(-1)!.status).toBe(401);
  expect(f.requests.at(-1)!.calls.get_ops_state ?? 0).toBe(0);
  expect(f.external).toEqual([]);
});

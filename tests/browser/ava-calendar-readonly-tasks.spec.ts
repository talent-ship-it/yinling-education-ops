import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-12T02:00:00.000Z";
const manualTask = {
  id: "SYNTH-MANUAL-TASK", title: "合成明确业务任务", studentId: "SYNTH-STU-1", owner: "Abby",
  category: "其他", trigger: "合成测试", due: "2026-10-12 13:00", dueAt: "2026-10-12T02:00:00.000Z",
  status: "due", tone: "amber", assignees: ["Abby"], watchers: [],
};

async function fixture(page: Page, exhausted = true, admin = false) {
  const session = admin ? { user: "Nixon", role: "admin" } : { user: "Abby", role: "staff" };
  const versions: Record<string, number> = { students: 1, teachers: 1, tasks: 1, bookings: 1, lpItems: 1 };
  const student = {
    id: "SYNTH-STU-1", name: "合成续课学生", initials: "合", status: "活跃 + 无课时", owner: "Abby",
    course: "VCE English", timezone: "Australia/Melbourne", teacher: "Synthetic Teacher", next: "待安排", nextTone: "blue", files: 0,
    lessonPackages: [{ id: "SYNTH-PKG-1", name: "合成课包", subjectIds: ["VCE English"],
      purchaseRecords: [{ id: "SYNTH-PUR-1", purchasedAt: "2026-09-01T00:00:00.000Z", hours: 10 }], consumedHours: exhausted ? 10 : 0 }],
  };
  const entities: Record<string, unknown> = {
    students: [student], teachers: [{ id: "SYNTH-TEA-1", name: "Synthetic Teacher", initials: "ST", subjects: ["VCE English"],
      timezone: "Australia/Melbourne", availability: "", load: 0, capacity: 10, acceptsStudents: true, note: "", availabilityWindows: [] }],
    tasks: [structuredClone(manualTask)], bookings: [], lpItems: [],
  };
  const writes: { method: string; path: string; body: Record<string, unknown>; section: string }[] = [];
  const reads: string[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  let holdWrite = false;
  let releaseWrite = () => {};
  page.on("pageerror", (error) => errors.push(error.message));
  const snapshots = () => ({
    managedExamSnapshot: { versions: { students: versions.students, tasks: versions.tasks }, students: [] },
    managedTrialPaymentSnapshot: { versions: { students: versions.students, tasks: versions.tasks, bookings: versions.bookings, lpItems: versions.lpItems }, students: [] },
  });
  const row = (entity: string) => ({ entity, payload: entities[entity] ?? [], version: versions[entity], updated_at: NOW, updated_by: "synthetic" });
  const readReply = (url: URL) => {
    if (url.pathname === "/api/demo-session") return { json: { ok: true, ...session, mustChangePassword: false } };
    if (url.pathname === "/api/nixon-session") return { json: { ok: admin } };
    if (url.pathname === "/api/app-snapshot") return { json: { ...entities, versions, ...snapshots() } };
    if (url.pathname === "/api/app-state") {
      if (url.searchParams.get("mode") === "versions") return { json: { versions: Object.keys(versions).map(row) } };
      const requested = (url.searchParams.get("entities") ?? "").split(",");
      return { json: { rows: requested.filter((entity) => entity in entities).map(row), ...snapshots() } };
    }
    if (url.pathname === "/api/ava-calendar") return { json: {
      teachers: [{ id: "SYNTH-TEA-1", name: "Synthetic Teacher" }], events: [], remainingAVA: [], availabilityStatus: [],
      source: { revision: `sha256:${"a".repeat(64)}`, publishedAt: NOW, freshness: "fresh", coverage: "complete",
        window: { start: "2026-09-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } },
      nativeVersions: { students: versions.students, teachers: versions.teachers, bookings: versions.bookings, lpItems: versions.lpItems }, consistencyKey: "b".repeat(64),
    } };
    if (url.pathname === "/api/audit") return { json: { entries: [] } };
    return { status: 403, json: { error: "Unbound synthetic read" } };
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      unexpected.push(url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = request.method();
    if (method !== "GET") {
      if (url.pathname === "/api/demo-logout") return route.fulfill({ json: { serverSessionRevoked: true } });
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method, path: url.pathname, body, section: new URL(page.url()).hash });
      if (url.pathname === "/api/app-state" && method === "PUT") {
        const entity = body.entity as string;
        expect(body.expectedVersion).toBe(versions[entity]);
        if (holdWrite) {
          holdWrite = false;
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        entities[entity] = body.payload;
        versions[entity] += 1;
        return route.fulfill({ json: { row: row(entity) } });
      }
      unexpected.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 403, json: { error: "Unbound synthetic write" } });
    }
    reads.push(url.pathname + url.search);
    return route.fulfill(readReply(url));
  });
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.pauseAt(new Date("2026-10-12T02:00:01.000Z"));
  return {
    writes, reads, errors, unexpected, versions, entities,
    exhaust() { student.lessonPackages[0].consumedHours = 10; versions.students += 1; },
    holdNextTaskWrite() { holdWrite = true; return () => releaseWrite(); },
  };
}

async function flush(page: Page, milliseconds = 1500) {
  await page.clock.runFor(milliseconds);
  await page.evaluate(() => document.readyState);
}

async function openCalendar(page: Page) {
  await page.goto("/#section=ava-calendar");
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return (await page.locator("#main-content h1").allTextContents()).join("");
  }, { timeout: 15000 }).toBe("AVA日历");
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return page.locator(".fc").count();
  }, { timeout: 15000 }).toBe(1);
}

async function openDashboard(page: Page) {
  await page.goto("/#section=dashboard");
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return page.locator(".app-shell").count();
  }, { timeout: 15000 }).toBe(1);
  await flush(page);
}

function assertClean(result: Awaited<ReturnType<typeof fixture>>) {
  expect(result.errors).toEqual([]);
  expect(result.unexpected).toEqual([]);
}

for (const admin of [false, true]) {
  test(`AVA ${admin ? "admin" : "staff"} deep-link load does not persist automatic renewal reconciliation`, async ({ page }, info) => {
    const result = await fixture(page, true, admin);
    await openCalendar(page);
    await flush(page);
    expect(result.reads.some((path) => path.startsWith("/api/ava-calendar?"))).toBe(true);
    await info.attach("synthetic-methods.json", { body: JSON.stringify({ reads: result.reads, writes: result.writes }), contentType: "application/json" });
    expect(result.writes).toEqual([]);
    expect(result.versions.tasks).toBe(1);
    assertClean(result);
  });
}

test("entering AVA defers an already scheduled automatic task save", async ({ page }, info) => {
  const result = await fixture(page, false);
  await openDashboard(page);
  expect(result.writes).toEqual([]);
  result.exhaust();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("课包续课跟进 · 合成课包", { exact: true })).toBeVisible();
  expect(result.writes).toEqual([]);
  await page.locator("#primary-navigation").getByRole("button", { name: "AVA日历", exact: true }).click();
  await expect(page.locator("#main-content h1")).toHaveText("AVA日历");
  await flush(page);
  await info.attach("synthetic-methods.json", { body: JSON.stringify({ reads: result.reads, writes: result.writes }), contentType: "application/json" });
  expect(result.writes).toEqual([]);
  expect(result.versions.tasks).toBe(1);
  await page.locator("#primary-navigation").getByRole("button", { name: "工作台", exact: true }).click();
  await flush(page);
  await expect.poll(() => result.writes.length).toBe(1);
  expect(result.writes[0]).toMatchObject({ method: "PUT", path: "/api/app-state", section: "#section=dashboard", body: { entity: "tasks", expectedVersion: 1 } });
  expect(result.writes[0].body.payload).toEqual(expect.arrayContaining([expect.objectContaining({ ruleKey: "renewal.package-depletion", studentId: "SYNTH-STU-1" })]));
  expect(result.versions.tasks).toBe(2);
  assertClean(result);
});

test("AVA remote polling and display controls do not save shared tasks", async ({ page }, info) => {
  const result = await fixture(page, false);
  await openCalendar(page);
  await flush(page);
  result.exhaust();
  const before = result.reads.length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => result.reads.slice(before).some((path) => path.includes("entities="))).toBe(true);
  await flush(page);
  await page.getByRole("combobox", { name: "日历视图", exact: true }).selectOption("timeGridDay");
  await page.getByRole("combobox", { name: "显示时区", exact: true }).selectOption("Asia/Shanghai");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await flush(page);
  expect(result.writes).toEqual([]);
  expect(result.versions.students).toBe(2);
  expect(result.versions.tasks).toBe(1);
  await page.screenshot({ path: info.outputPath("ava-readonly-synthetic.png"), fullPage: true });
  assertClean(result);
});

test("explicit task completion still saves and its undo still saves from AVA", async ({ page }) => {
  const result = await fixture(page, false);
  await openDashboard(page);
  expect(result.writes).toEqual([]);
  await page.getByRole("button", { name: "完成：合成明确业务任务", exact: true }).click();
  await expect.poll(() => result.versions.tasks).toBe(2);
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0].body.payload).toEqual(expect.arrayContaining([expect.objectContaining({ id: manualTask.id, status: "done" })]));
  await page.locator("#primary-navigation").getByRole("button", { name: "AVA日历", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(() => result.versions.tasks).toBe(3);
  await flush(page);
  expect(result.writes).toHaveLength(2);
  expect(result.writes[1]).toMatchObject({ section: "#section=ava-calendar", body: { entity: "tasks", expectedVersion: 2 } });
  expect(result.writes[1].body.payload).toEqual(expect.arrayContaining([expect.objectContaining({ id: manualTask.id, status: expect.not.stringMatching(/^done$/) })]));
  assertClean(result);
});

test("non-AVA navigation does not add a new automatic renewal trigger", async ({ page }) => {
  const result = await fixture(page);
  await openDashboard(page);
  await expect.poll(() => result.writes.length).toBe(1);
  await page.clock.setSystemTime(new Date("2026-10-13T02:00:00.000Z"));
  await page.locator("#primary-navigation").getByRole("button", { name: "学生档案", exact: true }).click();
  await flush(page);
  expect(result.writes).toHaveLength(1);
  expect(result.versions.tasks).toBe(2);
  assertClean(result);
});

test("AVA blocks queued automatic reconciliation but retains an in-flight explicit save", async ({ page }) => {
  const result = await fixture(page, false);
  await openDashboard(page);
  const release = result.holdNextTaskWrite();
  await page.getByRole("button", { name: "完成：合成明确业务任务", exact: true }).click();
  await expect.poll(() => result.writes.length).toBe(1);
  result.exhaust();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("课包续课跟进 · 合成课包", { exact: true })).toBeVisible();
  await flush(page, 600);
  expect(result.writes).toHaveLength(1);
  await page.locator("#primary-navigation").getByRole("button", { name: "AVA日历", exact: true }).click();
  release();
  await expect.poll(() => result.versions.tasks).toBe(2);
  await flush(page);
  expect(result.writes).toHaveLength(1);
  expect(result.entities.tasks).toEqual([expect.objectContaining({ id: manualTask.id, status: "done" })]);
  assertClean(result);
});

import { expect, test, type Page, type Request as BrowserRequest } from "@playwright/test";
import { createAvaCalendarHandler } from "../../lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "../../lib/ava-calendar-snapshot";
import { splitAvaCalendarWindow } from "../../lib/ava-calendar-live-client";
import { defaultDisplayPreferences, displayPreferencesStorageKey } from "../../lib/display-preferences";
import { sourceNameFixture } from "../ava-calendar-source-name-fixture";

function observeMutation(request: BrowserRequest, mutations: string[]) {
  const path = new URL(request.url()).pathname;
  const bootstrap = path === "/api/demo-logout" && request.method() === "POST" && request.postData() === null;
  if (request.method() !== "GET" && !bootstrap) mutations.push(`${request.method()} ${path}`);
  return bootstrap;
}

async function fixture(page: Page, admin = true) {
  const { rows, event, revision, accounts, student } = sourceNameFixture();
  const session = { user: admin ? "Nixon" : "Tiffany", role: admin ? "admin" as const : "staff" as const, permissions: ["*"] };
  const shared = { ...event, eventId: "synthetic-event-2", startsAt: "2026-10-17T03:00:00.000Z", endsAt: "2026-10-17T04:00:00.000Z", sourceParticipants: [{ memberId: "shared-member", label: "试听学员A" }] };
  const handler = createAvaCalendarHandler({
    strictSourceIdentity: true,
    readSession: async () => ({ session, fullAdmin: admin }),
    readRows: async () => rows,
    readVersions: async () => rows,
    readAccounts: async () => accounts,
    readSnapshot: (window) => readAvaCalendarSnapshot(window, async () => {
      const events = [event, shared].filter((item) => Date.parse(item.startsAt) < Date.parse(window.end) && Date.parse(item.endsAt) > Date.parse(window.start));
      return { state: "complete", freshness: "fresh", revision, publishedAt: "2026-10-17T00:00:00Z", sourceWindow: { start: "2026-09-01", end: "2027-02-01" }, invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: events.length === 0, events };
    }),
  });
  const mutations: string[] = [];
  const replies: Record<string, unknown> = {
    "/api/demo-session": { ok: true, ...session, mustChangePassword: false },
    "/api/nixon-session": { ok: admin },
    "/api/app-snapshot": { students: [], teachers: [], tasks: [], bookings: [], lpItems: [], versions: { students: 1, teachers: 1, tasks: 1, bookings: 1, lpItems: 1 }, managedExamSnapshot: { versions: { students: 1, tasks: 1 }, students: [] }, managedTrialPaymentSnapshot: { versions: { students: 1, tasks: 1, bookings: 1, lpItems: 1 }, students: [] } },
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") throw new Error("External request denied by synthetic source-name harness");
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (observeMutation(request, mutations)) return route.fulfill({ json: { serverSessionRevoked: true } });
    if (Object.hasOwn(replies, url.pathname)) return route.fulfill({ json: replies[url.pathname] });
    if (url.pathname === "/api/ava-calendar" || url.pathname === "/api/ava-calendar/range") {
      const window = { start: url.searchParams.get("start")!, end: url.searchParams.get("end")! };
      const slices = await Promise.all(splitAvaCalendarWindow(window).map(async (slice) => {
        const response = await handler(new Request(`http://127.0.0.1/api/ava-calendar?${new URLSearchParams(slice)}`));
        expect(response.status).toBe(200);
        return response.json();
      }));
      return route.fulfill({ json: url.pathname.endsWith("/range") ? { slices } : slices[0] });
    }
    return route.fulfill({ status: 403, json: { error: "Unbound synthetic API denied" } });
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: displayPreferencesStorageKey(session.user), value: JSON.stringify({ ...defaultDisplayPreferences(), language: "zh-CN" }) });
  await page.clock.install({ time: new Date("2026-10-17T02:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-10-17T02:00:01.000Z"));
  await page.goto("/#section=ava-calendar");
  await expect.poll(async () => { await page.clock.runFor(100); return page.locator(".fc").count(); }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  return { student, mutations };
}

for (const width of [1440, 320]) {
  test(`source name is visible and neutral while identity remains pending at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 800 : 1000 });
    const { student, mutations } = await fixture(page);
    const card = page.locator('[data-event-id="synthetic-event-1"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(student.name);
    await expect(card).toHaveAttribute("data-owner-color", "owner-unassigned");
    await expect(card).toHaveAttribute("aria-label", new RegExp(student.name));
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText(student.name, { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`source-name-card-${width}.png`), fullPage: true });
    await card.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(student.name);
    await expect(dialog).toContainText("身份待确认");
    await expect(dialog).toContainText("教务待分配");
    await expect(dialog).not.toContainText("Tiffany");
    await page.screenshot({ path: info.outputPath(`source-name-detail-${width}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "关闭课程详情", exact: true }).click();
    const shared = page.locator('[data-event-id="synthetic-event-2"]');
    await expect(shared).toContainText("学生待确认");
    await expect(shared).toContainText("试听");
    await expect(page.locator("body")).not.toContainText("试听学员A");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(mutations).toEqual([]);
    await info.attach("source-name-evidence.json", { body: JSON.stringify({ syntheticOnly: true, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), mutations, pendingNameVisible: true }), contentType: "application/json" });
  });
}

test("staff cannot recover an unresolved source name through the live calendar", async ({ page }) => {
  const { student, mutations } = await fixture(page, false);
  await expect(page.locator('[data-event-id="synthetic-event-1"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(student.name);
  await expect(page.locator("body")).not.toContainText("试听学员A");
  expect(mutations).toEqual([]);
});

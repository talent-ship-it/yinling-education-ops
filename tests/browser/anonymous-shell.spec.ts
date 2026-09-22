import { expect, test } from "@playwright/test";

test("serves the signed-out shell and protects private state", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");

  await expect(page.getByRole("heading", { name: "吟领教务" })).toBeVisible();
  await expect(page.getByLabel("账号 / 姓名")).toBeVisible();
  await expect(page.getByLabel("登录密码")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "进入系统" })).toBeEnabled();

  const appState = await page.request.get("/api/app-state");
  expect(appState.status()).toBe(401);
  expect(appState.headers()["cache-control"]).toContain("no-store");
  expect(pageErrors).toEqual([]);
});

test("keeps the signed-out shell inside a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "吟领教务" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

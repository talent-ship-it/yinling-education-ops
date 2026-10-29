import { expect, test } from "@playwright/test";

test("a switched account awaiting password change can return without logging out the administrator", async ({ page }) => {
  const mutations: string[] = [];
  let switched = true;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && request.headers()["x-yinling-logout-retry"] !== "1") mutations.push(`${request.method()} ${path}`);
    if (path === "/api/demo-session") return route.fulfill({ json: switched
      ? { ok: true, user: "Synthetic Teacher", role: "teacher", mustChangePassword: true, canSwitchIdentity: true, impersonator: "Synthetic Admin" }
      : { ok: false } });
    if (path === "/api/account/identity" && request.method() === "DELETE") {
      switched = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/demo-logout" && request.headers()["x-yinling-logout-retry"] === "1") return route.fulfill({ json: { serverSessionRevoked: true } });
    return route.fulfill({ status: 403, json: { error: "Synthetic fixture rejects unexpected API calls" } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "请先设置新密码" })).toBeVisible();
  await expect(page.getByLabel("当前密码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回管理员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "吟领教务", exact: true })).toBeVisible();
  expect(mutations).toEqual(["DELETE /api/account/identity"]);
  expect(switched).toBe(false);
});

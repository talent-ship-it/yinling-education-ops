import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.AVA_CALENDAR_TEST_URL || "http://127.0.0.1:4162";

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "ava-calendar.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "output/playwright/ava-calendar",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: process.env.AVA_CALENDAR_TEST_URL ? undefined : { command: "npm start -- --hostname 127.0.0.1 --port 4162", url: baseURL, reuseExistingServer: false, timeout: 120000 },
});

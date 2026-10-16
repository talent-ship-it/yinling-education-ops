import { defineConfig, devices } from "@playwright/test";

const buildRoot = process.env.AVA_SELF_SERVICE_BUILD_ROOT;
const command = buildRoot
  ? `node node_modules/next/dist/bin/next start ${JSON.stringify(buildRoot)} --hostname 127.0.0.1 --port 4186`
  : "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 4186";

export default defineConfig({
  testDir: "tests/browser", testMatch: ["ava-self-service.spec.ts", "ava-calendar-live.spec.ts"], workers: 1, retries: 0, timeout: 60000,
  reporter: [["list"], ["json", { outputFile: "output/ava-self-service-report.json" }]], outputDir: "output/ava-self-service",
  use: { baseURL: "http://127.0.0.1:4186", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: { command, url: "http://127.0.0.1:4186", reuseExistingServer: false, timeout: 120000 },
});

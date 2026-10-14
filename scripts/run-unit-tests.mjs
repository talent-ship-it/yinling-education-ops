import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

// Vercel's build environment contains deployment credentials. Unit/contract
// tests use synthetic fixtures and must never inherit those credentials.
const env = { NODE_ENV: "test", CI: "true", TZ: "UTC" };
for (const key of ["PATH", "SystemRoot", "TMPDIR", "TMP", "TEMP"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const files = readdirSync("tests")
  .filter((file) => /\.test\.(?:tsx?|mjs)$/.test(file))
  .sort()
  .map((file) => `tests/${file}`);
if (files.length === 0) throw new Error("No test files found");
let scratch;
if (!env.TMPDIR) {
  const scratchParent = process.env.RUNNER_TEMP || resolve("node_modules", ".cache");
  if (!process.env.RUNNER_TEMP) mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  scratch = mkdtempSync(join(scratchParent, "unit-test-tmp-"));
  env.TMPDIR = scratch;
}
try {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

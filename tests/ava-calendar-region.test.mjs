import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getAppPageStaticInfo } from "next/dist/build/analysis/get-page-static-info.js";
import { loadBindings } from "next/dist/build/swc/index.js";

await loadBindings();

const project = JSON.parse(readFileSync("vercel.json", "utf8"));

async function routeConfig(path) {
  return getAppPageStaticInfo({
    pageFilePath: resolve(`app${path}/route.ts`),
    nextConfig: {},
    isDev: false,
    page: `${path}/route`,
    pageType: "app",
  });
}

test("AVA calendar reads and teacher self-service use per-function database regions without changing runtime or deadlines", async () => {
  assert.deepEqual(project.functions, {
    "app/api/ava-calendar/route.ts": { regions: ["bom1"] },
    "app/api/ava-calendar/range/route.ts": { regions: ["bom1"] },
    "app/api/teacher-availability/self/route.ts": { regions: ["bom1"] },
  });
  for (const [path, maxDuration] of [["/api/ava-calendar", 60], ["/api/ava-calendar/range", 60], ["/api/teacher-availability/self", undefined]]) {
    assert.ok(existsSync(resolve(`app${path}/route.ts`)), path);
    const config = await routeConfig(path);
    assert.equal(config.preferredRegion, undefined, path);
    assert.equal(config.runtime ?? "nodejs", "nodejs", path);
    assert.equal(config.maxDuration, maxDuration, path);
    assert.equal(config.config.dynamic, "force-dynamic", path);
    assert.equal(config.hadUnsupportedValue, false, path);
  }
});

test("shared workspace and non-UI AVA routes retain their default region", async () => {
  assert.equal(project.regions, undefined);
  for (const path of ["/api/app-state", "/api/demo-session", "/api/ava-calendar/service", "/api/teacher-availability/submit", "/api/teacher-availability/review", "/api/teacher-availability/completion"]) {
    const config = await routeConfig(path);
    assert.equal(config.preferredRegion, undefined, path);
    assert.equal(project.functions?.[`app${path}/route.ts`], undefined, path);
  }
});

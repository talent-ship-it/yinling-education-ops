import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import vm from "node:vm";

const buildRoot = ".next";
const manifestContext = { globalThis: {} };
vm.runInNewContext(
  readFileSync(`${buildRoot}/server/app/page_client-reference-manifest.js`, "utf8"),
  manifestContext,
);
const pageManifest = manifestContext.globalThis.__RSC_MANIFEST?.["/page"];
assert.ok(pageManifest, "Missing /page client reference manifest. Run next build first.");

const clientModuleNames = Object.keys(pageManifest.clientModules ?? {});
assert.ok(clientModuleNames.some((name) => name.endsWith("/app/auth-client.tsx")), "The login shell is missing from the initial client boundary.");
assert.ok(!clientModuleNames.some((name) => name.endsWith("/app/operations-client.tsx")), "The authenticated operations client leaked into the anonymous route boundary.");

const pageEntry = Object.entries(pageManifest.entryJSFiles ?? {})
  .find(([name]) => name.endsWith("/app/page"))?.[1];
assert.ok(Array.isArray(pageEntry) && pageEntry.length > 0, "The /page entry JavaScript list is unavailable.");
const initialFeatureBytes = pageEntry.reduce((total, file) => total + statSync(`${buildRoot}/${file}`).size, 0);
assert.ok(initialFeatureBytes <= 48 * 1024, `Anonymous page feature JavaScript grew to ${initialFeatureBytes} bytes (budget: 49152).`);

const loadableManifest = JSON.parse(readFileSync(`${buildRoot}/server/app/page/react-loadable-manifest.json`, "utf8"));
const lazyFiles = [...new Set(Object.values(loadableManifest).flatMap((entry) => entry.files ?? []))]
  .filter((file) => file.endsWith(".js"));
assert.ok(lazyFiles.length > 0, "The authenticated operations bundle is no longer emitted as a lazy chunk.");
let anonymousHtml = null;
try {
  anonymousHtml = readFileSync(`${buildRoot}/server/app/index.html`, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
for (const file of lazyFiles) {
  assert.ok(!pageEntry.includes(file), `${file} is both lazy and part of the anonymous page entry.`);
  if (anonymousHtml !== null) {
    assert.ok(!anonymousHtml.includes(`/_next/${file}`), `${file} is preloaded by the anonymous HTML artifact.`);
  }
}
const authenticatedFeatureBytes = lazyFiles.reduce((total, file) => total + statSync(`${buildRoot}/${file}`).size, 0);
assert.ok(authenticatedFeatureBytes <= 925 * 1024, `Authenticated feature JavaScript grew to ${authenticatedFeatureBytes} bytes (budget: 947200).`);

console.log(`client bundle budget: anonymous=${initialFeatureBytes}B authenticated-lazy=${authenticatedFeatureBytes}B`);

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../app/api", import.meta.url));

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(target);
    return entry.isFile() && entry.name === "route.ts" ? [target] : [];
  }));
  return nested.flat();
}

test("generic API failures never reflect raw Error or database messages", async () => {
  const offenders = [];
  for (const file of await routeFiles(apiRoot)) {
    const source = await readFile(file, "utf8");
    if (/error instanceof Error\s*\?\s*error\.message\s*:/u.test(source)) {
      offenders.push(path.relative(apiRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});

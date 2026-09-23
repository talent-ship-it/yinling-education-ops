import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { directPutOpsStateRouteImports } from "../scripts/check-api-write-boundaries.mjs";

test("detects direct putOpsState route imports through TypeScript syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "yinling-api-boundary-"));
  try {
    const direct = join(root, "app/api/direct");
    const extension = join(root, "app/api/extension");
    const namespace = join(root, "app/api/namespace");
    const dynamic = join(root, "app/api/dynamic");
    const harmless = join(root, "app/api/harmless");
    await Promise.all([
      mkdir(direct, { recursive: true }),
      mkdir(extension, { recursive: true }),
      mkdir(namespace, { recursive: true }),
      mkdir(dynamic, { recursive: true }),
      mkdir(harmless, { recursive: true }),
    ]);
    await writeFile(join(direct, "route.ts"), 'import { putOpsState as write } from "@/lib/ops-store";\nvoid write;\n');
    await writeFile(join(extension, "route.ts"), 'import { putOpsState } from "../../../../lib/ops-store.ts";\nvoid putOpsState;\n');
    await writeFile(join(namespace, "route.ts"), 'import * as opsStore from "@/lib/ops-store";\nvoid opsStore.putOpsState;\n');
    await writeFile(join(dynamic, "route.ts"), 'export async function POST() { const { putOpsState } = await import("@/lib/ops-store"); void putOpsState; }\n');
    await writeFile(join(harmless, "route.ts"), 'const example = "putOpsState";\n// import { putOpsState } from "@/lib/ops-store"\nvoid example;\n');
    assert.deepEqual(directPutOpsStateRouteImports(root), [
      "app/api/direct/route.ts",
      "app/api/dynamic/route.ts",
      "app/api/extension/route.ts",
      "app/api/namespace/route.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import { safeJiaowubaoCompletedLessonDatabaseFailure } from "../lib/jiaowubao-completed-lesson-database-failure.ts";
import { JiaowubaoOpenApiError } from "../lib/jiaowubao-open-api-node.ts";

const failureModule: Record<string, (error: unknown) => unknown> = {};
const failureSource = readFileSync(new URL("../lib/jiaowubao-completed-lesson-safe-failure.ts", import.meta.url), "utf8");
const modules: Record<string, unknown> = {
  "@/lib/jiaowubao-completed-lesson-database-failure": { safeJiaowubaoCompletedLessonDatabaseFailure },
  "@/lib/jiaowubao-open-api-node": { JiaowubaoOpenApiError },
  "@/lib/ops-store": { OpsStoreError: class extends Error {} },
};
vm.runInNewContext(ts.transpileModule(failureSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, {
  exports: failureModule, Error,
  require: (id: string) => {
    assert.ok(id in modules);
    return modules[id];
  },
});

function safeFailure(error: unknown) {
  return JSON.parse(JSON.stringify(failureModule.safeJiaowubaoCompletedLessonSyncFailure(error)));
}

test("database failures expose only a bounded code category", () => {
  const privateFailure = {
    message: "synthetic-private-message-must-not-appear",
    code: "23514",
    detail: "synthetic-private-detail-must-not-appear",
    constraint: "synthetic-private-constraint-must-not-appear",
  };
  const safe = safeJiaowubaoCompletedLessonDatabaseFailure(privateFailure);
  assert.deepEqual(safe, { kind: "database", code: "23514" });
  assert.deepEqual(Object.keys(safe).sort(), ["code", "kind"]);
  assert.doesNotMatch(JSON.stringify(safe), /private-message|private-detail|private-constraint/);

  assert.deepEqual(
    safeJiaowubaoCompletedLessonDatabaseFailure({ message: "hidden", code: "PGRST116" }),
    { kind: "database", code: "PGRST116" },
  );
  assert.deepEqual(
    safeJiaowubaoCompletedLessonDatabaseFailure({ message: "hidden", code: "unsafe-source-id" }),
    { kind: "database", code: "other" },
  );
});

test("known database messages map to fixed diagnostic codes without exposing the message", () => {
  const knownFailure = {
    message: "jiaowubao_completed_lesson_snapshot_page_invalid",
    code: "22023",
    detail: "synthetic-private-detail-must-not-appear",
  };
  const safe = safeJiaowubaoCompletedLessonDatabaseFailure(knownFailure);
  assert.deepEqual(
    safe,
    { kind: "database", code: "snapshot_page_invalid" },
  );
  assert.deepEqual(Object.keys(safe).sort(), ["code", "kind"]);
  assert.doesNotMatch(JSON.stringify(safe), /jiaowubao_completed|private-detail/);
});

test("source authorization diagnostics expose only fixed provider, stage and HTTP status", () => {
  for (const httpStatus of [401, 403] as const) {
    const rest = new JiaowubaoOpenApiError("not_authorized", "synthetic-private-message", undefined, undefined, {
      provider: "rest", httpStatus,
    });
    assert.deepEqual(safeFailure(rest), { kind: "open_api", code: "not_authorized", provider: "rest", httpStatus });
    for (const stage of ["initialize", "notification", "institution", "lesson", "schedule"] as const) {
      const mcp = new JiaowubaoOpenApiError("not_authorized", "synthetic-private-message", undefined, undefined, {
        provider: "mcp", stage, httpStatus,
      });
      assert.deepEqual(safeFailure(mcp), { kind: "open_api", code: "not_authorized", provider: "mcp", stage, httpStatus });
    }
  }
});

test("source authorization diagnostics validate getter values from a single snapshot", () => {
  const privateValue = "synthetic-private-getter-secret";
  for (const httpStatus of [401, 403] as const) {
    const reads = { provider: 0, httpStatus: 0, stage: 0 };
    const authFailure = {
      get provider() {
        reads.provider += 1;
        return "mcp";
      },
      get httpStatus() {
        return ++reads.httpStatus === 1 ? httpStatus : privateValue;
      },
      get stage() {
        reads.stage += 1;
        return "lesson";
      },
    };
    const error = Object.assign(new JiaowubaoOpenApiError("not_authorized", privateValue), { authFailure });
    assert.deepEqual(safeFailure(error), {
      kind: "open_api", code: "not_authorized", provider: "mcp", stage: "lesson", httpStatus,
    });
    assert.deepEqual(reads, { provider: 1, httpStatus: 1, stage: 1 });
  }
});

test("source authorization diagnostics discard arbitrary runtime metadata and source values", () => {
  const privateValue = "synthetic-private-credential-member-url";
  for (const [authFailure, expected] of [
    [{ provider: privateValue, httpStatus: 401 }, {}],
    [{ provider: "mcp", httpStatus: privateValue, stage: "lesson" }, {}],
    [{ provider: "mcp", httpStatus: 500, stage: "lesson" }, {}],
    [{ provider: "mcp", httpStatus: "401", stage: "lesson" }, {}],
    [{ provider: "mcp", httpStatus: 401, stage: privateValue }, { provider: "mcp", httpStatus: 401 }],
    [{ provider: "mcp", httpStatus: 403, stage: { token: privateValue } }, { provider: "mcp", httpStatus: 403 }],
    [{ provider: "rest", httpStatus: 403, stage: privateValue, body: privateValue }, { provider: "rest", httpStatus: 403 }],
    [{ provider: "mcp", httpStatus: 401, stage: "lesson", token: privateValue, headers: privateValue, memberId: privateValue }, { provider: "mcp", httpStatus: 401, stage: "lesson" }],
  ]) {
    const error = Object.assign(new JiaowubaoOpenApiError("not_authorized", privateValue), { authFailure });
    const safe = safeFailure(error);
    assert.deepEqual(safe, { kind: "open_api", code: "not_authorized", ...expected });
    assert.equal(JSON.stringify(safe).includes(privateValue), false);
  }
  const unrelated = Object.assign(new JiaowubaoOpenApiError("upstream_rejected", privateValue), {
    authFailure: { provider: "mcp", httpStatus: 401, stage: "lesson" },
  });
  assert.deepEqual(safeFailure(unrelated), { kind: "open_api", code: "upstream_rejected" });
});

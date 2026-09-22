import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function runClient(status, body) {
  const source = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const syncJiaowubaoCompletedLessons = async () => {");
  const end = source.indexOf("  const syncTrialSchedulesFromJiaowubao", start);
  assert.ok(start >= 0 && end > start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const notices = [], errors = [], audits = [];
  let reads = 0;
  const dependencies = {
    jiaowubaoCompletedLessonSyncing: false, jiaowubaoCompletedLessonExporting: false,
    activePayrollMonth: "2026-08", setJiaowubaoCompletedLessonSyncing() {},
    setJiaowubaoCompletedLessonError(value) { errors.push(value); },
    fetch: async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }),
    notify: (value) => notices.push(value),
    loadAllJiaowubaoCompletedLessonPages: async () => { reads++; return { state: "complete", rowCount: 12, scheduleRowCount: 5 }; },
    setJiaowubaoCompletedLessonFeed() {}, addAudit: (...args) => audits.push(args),
  };
  await new Function(...Object.keys(dependencies), `${js}; return syncJiaowubaoCompletedLessons();`)(...Object.values(dependencies));
  return { notices, errors, audits, reads };
}

test("blocked responses never present an old published snapshot as freshly synced", async () => {
  for (const [status, body] of [[409, { outcome: "blocked" }], [200, { sync: { outcome: "blocked" } }]]) {
    const result = await runClient(status, body);
    assert.equal(result.reads, 0);
    assert.equal(result.audits.length, 0);
    assert.equal(result.errors.at(-1), true);
    assert.match(result.notices.at(-1), /阻断.*此前已发布快照/);
  }
});

test("unknown successful HTTP bodies are not accepted as successful business outcomes", async () => {
  for (const body of [{}, { sync: { outcome: "unexpected" } }]) {
    const result = await runClient(200, body);
    assert.equal(result.reads, 0);
    assert.equal(result.errors.at(-1), true);
  }
});

test("published or unchanged results still reload the verified snapshot", async () => {
  for (const outcome of ["applied", "no_change"]) {
    const result = await runClient(200, { sync: { outcome } });
    assert.equal(result.reads, 1);
    assert.match(result.notices.at(-1), /已同步 12/);
  }
});

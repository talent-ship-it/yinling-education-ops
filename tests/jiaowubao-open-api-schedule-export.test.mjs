import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  exportJiaowubaoScheduleSnapshot,
  parseArguments,
  validateScheduleExportOptions,
} = await import("../scripts/jiaowubao-open-api-schedule-export.ts");

test("schedule exporter validates bounded dates and required output", () => {
  assert.deepEqual(parseArguments(["--start", "2026-08-01", "--end", "2026-08-02", "--out", "/tmp/export"]), {
    start: "2026-08-01",
    end: "2026-08-02",
    out: "/tmp/export",
  });
  assert.throws(() => validateScheduleExportOptions({ start: "2026-08-01", end: "2026-09-01", out: "/tmp/export" }), /最多 31 天/);
  assert.throws(() => parseArguments(["--start", "2026-08-01", "--end", "2026-08-02", "--out"]), /用法/);
  assert.throws(() => parseArguments(["--start", "2026-08-01", "--end", "2026-08-02", "--out", "/tmp/export", "--unknown", "x"]), /用法/);
});

test("schedule exporter writes owner-only page files and aggregate manifest", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jwb-schedule-export-parent-"));
  const out = join(parent, "export");
  const page = (number) => ({
    lists: number === 1
      ? Array.from({ length: 100 }, (_, index) => ({
        cal_id: `${number}-${index}`,
        teacher_hour: 1.5,
        cont: "internal attendance note",
        price_mem: 99,
        stu_list: [{ mem_id: `MEM-${index}`, name: "student", comment: "internal comment", price: 99 }],
      }))
      : number === 2 ? [{ cal_id: "2-0", ks_reception: 1, color: "#123456" }] : [],
  });
  const calls = [];
  const manifest = await exportJiaowubaoScheduleSnapshot(
    { start: "2026-08-01", end: "2026-08-02", out },
    async (query) => {
      calls.push(query);
      return page(query.page);
    },
  );

  assert.equal(manifest.pageCount, 2);
  assert.equal(manifest.recordCount, 101);
  assert.match(manifest.recordsSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.manifestSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.revision, manifest.manifestSha256);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((query) => query.page), [1, 2]);
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.equal((await stat(join(out, "page-0001.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(out, "manifest.json"))).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(join(out, "page-0001.json"), "utf8"));
  assert.equal(persisted[0].cal_id, "1-0");
  assert.deepEqual(persisted[0].stu_list, [{ mem_id: "MEM-0", name: "student", comment: "internal comment" }]);
  assert.equal(persisted[0].teacher_hour, 1.5);
  assert.equal(persisted[0].cont, "internal attendance note");
  assert.equal("price" in persisted[0], false);
  assert.equal("price_mem" in persisted[0], false);
  assert.deepEqual(JSON.parse(await readFile(join(out, "page-0002.json"), "utf8"))[0], { cal_id: "2-0", ks_reception: 1, color: "#123456" });
  assert.deepEqual((await readdir(out)).sort(), ["manifest.json", "page-0001.json", "page-0002.json"]);
});

test("schedule exporter never persists the terminal empty page", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jwb-schedule-export-terminal-"));
  const out = join(parent, "export");
  const calls = [];
  const manifest = await exportJiaowubaoScheduleSnapshot(
    { start: "2026-08-01", end: "2026-08-01", out },
    async (query) => {
      calls.push(query.page);
      return { lists: query.page === 1 ? Array.from({ length: 100 }, (_, index) => ({ cal_id: String(index) })) : [] };
    },
  );
  assert.equal(manifest.pageCount, 1);
  assert.equal(manifest.recordCount, 100);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual((await readdir(out)).sort(), ["manifest.json", "page-0001.json"]);
});

test("zero-row schedule export has zero pages and no empty page file", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jwb-schedule-export-empty-"));
  const out = join(parent, "export");
  const manifest = await exportJiaowubaoScheduleSnapshot(
    { start: "2026-08-01", end: "2026-08-01", out },
    async () => ({ lists: [] }),
  );
  assert.equal(manifest.pageCount, 0);
  assert.equal(manifest.recordCount, 0);
  assert.deepEqual((await readdir(out)).sort(), ["manifest.json"]);
});

test("schedule exporter stops on a repeated full page", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jwb-schedule-export-repeat-parent-"));
  const out = join(parent, "export");
  const repeated = { lists: Array.from({ length: 100 }, (_, index) => ({ cal_id: String(index) })) };
  await assert.rejects(
    exportJiaowubaoScheduleSnapshot(
      { start: "2026-08-01", end: "2026-08-01", out },
      async () => repeated,
    ),
    /重复 cal_id/,
  );
});

test("a failed export leaves no output directory behind", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jwb-schedule-export-failure-parent-"));
  const out = join(parent, "export");
  await assert.rejects(
    exportJiaowubaoScheduleSnapshot(
      { start: "2026-08-01", end: "2026-08-01", out },
      async () => ({ lists: [{ teacher_id: "missing-cal-id" }] }),
    ),
    /缺少有效 cal_id/,
  );
  await assert.rejects(stat(out), /ENOENT/);
});

test("schedule exporter rejects a cal_id repeated across pages after normalizing its type", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jwb-schedule-export-duplicate-parent-"));
  const out = join(parent, "export");
  await assert.rejects(
    exportJiaowubaoScheduleSnapshot(
      { start: "2026-08-01", end: "2026-08-01", out },
      async (query) => ({
        lists: query.page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ cal_id: index }))
          : [{ cal_id: "1" }],
      }),
    ),
    /重复 cal_id/,
  );
  await assert.rejects(stat(out), /ENOENT/);
});

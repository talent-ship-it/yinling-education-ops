import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT,
  collectJiaowubaoScheduleSnapshot,
  projectJiaowubaoScheduleSnapshotRecord,
} = await import("../lib/jiaowubao-open-api-schedule-snapshot.ts");

test("schedule snapshot keeps every documented non-price field, including private student evidence", async () => {
  const snapshot = await collectJiaowubaoScheduleSnapshot(
    { start: "2026-08-22", end: "2026-08-22" },
    async ({ page }) => ({
      lists: page === 1 ? [{
        cal_id: 7001,
        teacher_hour: 1.5,
        teacher_s_hour: 0.5,
        cont: "private attendance note",
        color: "#123456",
        ks_reception: 1,
        try_arrive: 1,
        price_mem: 88,
        stu_list: [
          { mem_id: "M-1", name: "Student", logo: "https://example.invalid/logo", comment: "private note", price: 88 },
          { mem_id: "M-2", name: "Second student", sign: 1, price: 99 },
        ],
      }] : [],
    }),
  );
  assert.equal(snapshot.manifest.format, JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT);
  assert.equal(snapshot.manifest.pageCount, 1);
  const [record] = snapshot.pages[0].records;
  assert.deepEqual(record, {
    cal_id: "7001",
    teacher_hour: 1.5,
    teacher_s_hour: 0.5,
    cont: "private attendance note",
    color: "#123456",
    ks_reception: 1,
    try_arrive: 1,
    stu_list: [
      { mem_id: "M-1", name: "Student", logo: "https://example.invalid/logo", comment: "private note" },
      { mem_id: "M-2", name: "Second student", sign: 1 },
    ],
  });
  assert.equal("price_mem" in record, false);
  assert.equal("price" in record.stu_list[0], false);
});

test("schedule snapshot fails closed on oversized student evidence rather than discarding it", () => {
  assert.throws(
    () => projectJiaowubaoScheduleSnapshotRecord({
      cal_id: "too-many-students",
      stu_list: Array.from({ length: 1001 }, (_, index) => ({ mem_id: String(index) })),
    }),
    /学员明细无效/,
  );
});

test("production uses a private 30-minute database schedule and publishes source evidence only after durable leasing", async () => {
  const [vercel, route, migration, rpcGrantMigration, completionFix, unchangedConfirmation] = await Promise.all([
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cron/jiaowubao-schedule/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260822000100_jiaowubao_open_api_schedule_v2_and_sync_lease.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260822000300_grant_server_jiaowubao_schedule_snapshot_rpc.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260822000400_fix_jiaowubao_schedule_snapshot_completion_hash.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260828000100_confirm_unchanged_jiaowubao_schedule_snapshot.sql", import.meta.url), "utf8"),
  ]);
  const scheduleMigration = await readFile(new URL("../supabase/migrations/20260822000200_schedule_jiaowubao_open_api_sync_every_30_minutes.sql", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(vercel).crons, []);
  assert.match(route, /hasCronSecret/);
  assert.match(route, /JIAOWUBAO_SCHEDULE_SYNC_TOKEN/);
  assert.match(route, /claimJiaowubaoOpenApiScheduleSyncLease/);
  assert.match(route, /completeJiaowubaoOpenApiScheduleSnapshot/);
  assert.match(route, /confirmJiaowubaoOpenApiScheduleSnapshotCurrent/);
  assert.match(route, /phase = "confirm_current"/);
  assert.match(route, /上一份完整快照保持不变/);
  assert.match(route, /value\.runId === runId && value\.pageIndex === pageIndex/);
  assert.doesNotMatch(route, /value\.state === "staging"/);
  assert.match(route, /jiaowubao_schedule_sync_failed/);
  assert.match(route, /phase \}/);
  assert.doesNotMatch(route, /console\.error\([^\n]*error/);
  assert.doesNotMatch(route, /createBooking|putOpsState|setOpsState/);
  assert.match(migration, /jiaowubao_open_api_schedule_sync_leases/);
  assert.match(migration, /price_mem/);
  assert.match(migration, /student_value \? 'price'/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_open_api_schedule_sync_leases from public, anon, authenticated/);
  assert.match(scheduleMigration, /create extension if not exists pg_net with schema extensions/);
  assert.match(scheduleMigration, /create extension if not exists pg_cron/);
  assert.match(scheduleMigration, /jiaowubao-open-api-schedule-30m/);
  assert.match(scheduleMigration, /\*\/30 \* \* \* \*/);
  assert.match(scheduleMigration, /vault\.decrypted_secrets/);
  assert.match(scheduleMigration, /https:\/\/app\.insiderleadsedu\.com\/api\/cron\/jiaowubao-schedule/);
  assert.match(scheduleMigration, /revoke all on table net\._http_response from public, anon, authenticated/);
  assert.doesNotMatch(scheduleMigration, /JIAOWUBAO_OPEN_API_SK/);
  for (const functionName of [
    "get_jiaowubao_open_api_schedule_snapshot_preflight",
    "begin_jiaowubao_open_api_schedule_snapshot_ingest",
    "stage_jiaowubao_open_api_schedule_snapshot_page",
    "complete_jiaowubao_open_api_schedule_snapshot_ingest",
  ]) {
    assert.match(rpcGrantMigration, new RegExp(`grant execute on function public\\.${functionName}`));
  }
  assert.doesNotMatch(rpcGrantMigration, /abort_jiaowubao_open_api_schedule_snapshot_ingest/);
  assert.doesNotMatch(rpcGrantMigration, /get_jiaowubao_open_api_schedule_snapshot_ingest_status/);
  assert.match(completionFix, /select 'sha256:' \|\| encode\(extensions\.digest\(coalesce\(string_agg\(p\.page_sha256/);
  assert.match(completionFix, /into payload_hash from internal\.jiaowubao_open_api_schedule_snapshot_ingest_pages p/);
  assert.doesNotMatch(completionFix, /payload_hash :=/);
  assert.match(unchangedConfirmation, /confirm_jiaowubao_open_api_schedule_snapshot_current/);
  assert.match(unchangedConfirmation, /pg_advisory_xact_lock/);
  assert.match(unchangedConfirmation, /current_row\.revision is distinct from p_revision/);
  assert.match(unchangedConfirmation, /set published_at = confirmed_at/);
  assert.match(unchangedConfirmation, /confirmed_unchanged/);
  assert.match(unchangedConfirmation, /grant execute on function public\.confirm_jiaowubao_open_api_schedule_snapshot_current/);
});

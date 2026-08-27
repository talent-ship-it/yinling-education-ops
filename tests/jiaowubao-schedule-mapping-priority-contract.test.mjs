import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, route, store, panel, fixture] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819100700_prioritize_jiaowubao_schedule_mapping_review.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL(
    "../app/api/jiaowubao-direct-import/schedule-mappings/priority/route.ts",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/jiaowubao-schedule-mapping-priority-review.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sql/jiaowubao-schedule-mapping-snapshot-performance.sql", import.meta.url), "utf8"),
]);

function functionBody(sql, schema, name) {
  return sql.match(new RegExp(
    `create or replace function ${schema}\\.${name}[\\s\\S]*?\\$${name}\\$;`,
    "i",
  ))?.[0] ?? "";
}

test("191007 adds a manifest-complete immutable UTC-day relevance layer without changing source operations", () => {
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_schedule_mapping_candidate_relevance_days/i);
  assert.match(migration, /primary key \(run_id, mapping_key, occurrence_day\)/i);
  assert.match(migration, /first_starts_at timestamptz not null/i);
  assert.match(migration, /\(first_starts_at at time zone 'UTC'\)::date = occurrence_day/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_schedule_mapping_relevance_manifests/i);
  assert.match(migration, /candidate_set_sha256 text not null/i);
  assert.match(migration, /relevance_set_sha256 text not null/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table internal\.jiaowubao_direct_schedule_mapping_candidate_relevance_days/i);
  assert.match(migration, /jiaowubao_schedule_mapping_relevance_append_only/i);
  assert.match(migration, /jiaowubao_schedule_mapping_relevance_write_forbidden/i);
  assert.match(migration, /lock table internal\.jiaowubao_direct_import_runs in exclusive mode/i);
  assert.match(migration, /latest_completed_run_id uuid/i);
  assert.match(migration, /perform internal\.materialize_jiaowubao_direct_schedule_mapping_snapshot\(latest_completed_run_id\)/i);
  assert.doesNotMatch(migration, /\bupdate\s+internal\.jiaowubao_direct_schedule_events\b/i);
  assert.doesNotMatch(migration, /\binsert into\s+internal\.jiaowubao_direct_current_schedule_blocks\b/i);
  assert.doesNotMatch(migration, /\binsert into\s+public\.(?:bookings|tasks|operations|settlements)\b/i);
});

test("only the materializer source scans raw schedule evidence; priority runtime remains snapshot-only", () => {
  const source = functionBody(
    migration,
    "internal",
    "jiaowubao_direct_schedule_mapping_relevance_source",
  );
  const publicReader = functionBody(
    migration,
    "public",
    "get_jiaowubao_direct_schedule_mapping_priority_review",
  );
  const relevanceMaterializer = functionBody(
    migration,
    "internal",
    "materialize_jiaowubao_direct_schedule_mapping_relevance",
  );
  const snapshotMaterializer = functionBody(
    migration,
    "internal",
    "materialize_jiaowubao_direct_schedule_mapping_snapshot",
  );

  assert.match(source, /internal\.jiaowubao_direct_schedule_events/i);
  assert.match(source, /schedule_event\.time_parse_status = 'parsed'/i);
  assert.match(source, /\(source_row\.starts_at at time zone 'UTC'\)::date/i);
  assert.doesNotMatch(publicReader, /internal\.jiaowubao_direct_schedule_events/i);
  assert.doesNotMatch(publicReader, /source_payload|source_row|source_workbook|event_id/i);
  assert.match(publicReader, /internal\.jiaowubao_direct_schedule_mapping_relevance_manifest\(saved_run\.id\)/i);
  assert.match(publicReader, /if not found then\s*raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_unavailable'/i);
  assert.match(relevanceMaterializer, /assert_jiaowubao_direct_schedule_mapping_relevance_integrity/i);
  assert.match(relevanceMaterializer, /jiaowubao_schedule_mapping_relevance_incomplete/i);
  assert.equal((snapshotMaterializer.match(/materialize_jiaowubao_direct_schedule_mapping_relevance\(saved_run\.id\)/g) ?? []).length, 2,
    "both a preexisting candidate snapshot and a newly written snapshot must publish/reconcile relevance");
});

test("priority reader is fixed to canonical UTC 63-day source-start relevance and excludes revoked mappings", () => {
  const publicReader = functionBody(
    migration,
    "public",
    "get_jiaowubao_direct_schedule_mapping_priority_review",
  );
  assert.match(publicReader, /date_trunc\('day', p_window_start at time zone 'UTC'\)/i);
  assert.match(publicReader, /p_window_end - p_window_start <> interval '63 days'/i);
  assert.match(publicReader, /relevance\.occurrence_day >= \(p_window_start at time zone 'UTC'\)::date/i);
  assert.match(publicReader, /relevance\.occurrence_day < \(p_window_end at time zone 'UTC'\)::date/i);
  assert.match(publicReader, /where classified\.mapping_status in \('unmapped', 'authority_changed'\)/i);
  assert.match(publicReader, /filter \(where mapping_status = 'revoked'\)/i);
  assert.match(publicReader, /case when classified\.mapping_status = 'authority_changed' then 0 else 1 end as priority_rank/i);
  assert.match(publicReader, /order by actionable\.priority_rank, actionable\.next_starts_at, actionable\.window_event_count desc, actionable\.mapping_key/i);
  assert.match(publicReader, /jiaowubao_schedule_mapping_priority_cursor_invalid/i);
  assert.match(publicReader, /when decision_row\.decision_id is null then 'unmapped'/i);
  assert.doesNotMatch(publicReader, /current_schedule_blocks|availability_effect|\bbookings\b|\btasks\b/i);
});

test("priority route is high-tier, GET-only, exact-window, opaque-cursor, and server-secret-gated", () => {
  assert.match(route, /const PAGE_LIMIT = 80;/);
  assert.match(route, /const PRIORITY_WINDOW_MS = 63 \* 24 \* 60 \* 60 \* 1_000;/);
  assert.match(route, /hasTeacherImportAdminAccess/);
  assert.match(route, /key !== "windowStart" && key !== "windowEnd" && key !== "cursor"/);
  assert.match(route, /getUTCHours\(\) !== 0/);
  assert.match(route, /!== PRIORITY_WINDOW_MS/);
  assert.match(route, /getJiaowubaoDirectScheduleMappingPriorityReview/);
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(route, /export async function POST|request\.json\(|request\.text\(/);
  assert.match(store, /JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PRIORITY_REVIEW_RPC/);
  assert.match(store, /p_secret: secret,[\s\S]*?p_window_start: input\.windowStart,[\s\S]*?p_after_mapping_key: input\.cursor/s);
});

test("the embeddable panel exposes a human-only queue, explicit absolute time, and an all-history callback", () => {
  assert.match(panel, /当前 63 天待核对/);
  assert.match(panel, /formatInstant\(candidate\.nextStartsAt, timezone\)/);
  assert.match(panel, /查看全部历史组合/);
  assert.equal((panel.match(/useState\(""\)/g) ?? []).length, 2,
    "teacher and subject selectors must start blank");
  assert.match(panel, /setSubjectId\(""\)/);
  assert.doesNotMatch(panel, /defaultValue=\{candidate\.targetTeacherId\}|value=\{candidate\.targetTeacherId\}/);
});

test("rollback fixture proves a later authority-changed pair wins before earlier unmapped source starts", () => {
  assert.match(fixture, /jiaowubao_schedule_mapping_priority_authority_seed_failed/i);
  assert.match(fixture, /Snapshot Performance Teacher Updated/i);
  assert.match(fixture, /priority_first_page #>> '\{candidates,0,status\}' <> 'authority_changed'/i);
  assert.match(fixture, /priority_first_page #>> '\{candidates,0,nextStartsAt\}' <> '2026-08-21T00:00:00\.000Z'/i);
  assert.match(fixture, /priority_authority_page := public\.get_jiaowubao_direct_schedule_mapping_priority_review\([\s\S]*?\n\s*1,\n\s*null/s);
  assert.match(fixture, /priority_after_authority_page #>> '\{candidates,0,status\}' <> 'unmapped'/i);
  assert.match(fixture, /priority_after_authority_page #>> '\{candidates,0,nextStartsAt\}' <> '2026-08-20T00:00:00\.000Z'/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_priority_status_cursor_order_failed/i);
});

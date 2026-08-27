import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819000800_fix_jiaowubao_direct_import_completion_proof.sql",
    import.meta.url,
  ),
  "utf8",
);
const originalMigration = await readFile(
  new URL(
    "../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql",
    import.meta.url,
  ),
  "utf8",
);

const extractAssertComplete = (sql) => sql.match(
  /create or replace function internal\.jiaowubao_direct_import_assert_complete\(p_run_id uuid\)[\s\S]*?\$jiaowubao_direct_import_assert_complete\$;/i,
)?.[0] ?? "";

const extractComplete = (sql) => sql.match(
  /create or replace function internal\.complete_jiaowubao_direct_import\([\s\S]*?\$complete_jiaowubao_direct_import\$;/i,
)?.[0] ?? "";

const extractRunGuard = (sql) => sql.match(
  /create or replace function internal\.jiaowubao_direct_import_run_guard\(\)[\s\S]*?\$jiaowubao_direct_import_run_guard\$;/i,
)?.[0] ?? "";

const assertComplete = extractAssertComplete(migration);
const complete = extractComplete(migration);

test("the completion proof qualifies every chunk-count column that collides with a PL/pgSQL local", () => {
  assert.match(assertComplete, /from chunk_rows chunk_proof/i);
  for (const column of [
    "source_record_count",
    "projected_record_counts",
    "supplemental_count",
    "schedule_count",
    "participant_count",
    "leave_makeup_count",
  ]) {
    assert.match(assertComplete, new RegExp(`chunk_proof\\.${column}\\b`, "i"));
  }
  assert.doesNotMatch(assertComplete, /where source_record_count\s*<>\s*supplemental_count/i);
  assert.doesNotMatch(assertComplete, /['"]supplementalRecords['"],\s*supplemental_count/i);
});

test("the repaired assertion is byte-equivalent to 001 after reversing only the reviewed qualification", () => {
  const restored = assertComplete
    .replace("from chunk_rows chunk_proof", "from chunk_rows")
    .replaceAll("chunk_proof.", "");

  assert.equal(restored, extractAssertComplete(originalMigration));
});

test("completion relies on the unchanged BEFORE UPDATE guard for one atomic full proof", () => {
  const originalComplete = extractComplete(originalMigration);
  const restoredComplete = complete.replace(
    "  payload_hash := internal.jiaowubao_direct_import_payload_sha256(p_run_id);",
    "  perform internal.jiaowubao_direct_import_assert_complete(p_run_id);\n"
      + "  payload_hash := internal.jiaowubao_direct_import_payload_sha256(p_run_id);",
  );

  assert.doesNotMatch(
    complete,
    /perform internal\.jiaowubao_direct_import_assert_complete\(p_run_id\)/i,
  );
  assert.equal(restoredComplete, originalComplete);
  assert.match(
    extractRunGuard(originalMigration),
    /perform internal\.jiaowubao_direct_import_assert_complete\(old\.id\)/i,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function internal\.jiaowubao_direct_import_run_guard\(\)|drop\s+trigger\s+jiaowubao_direct_import_runs_guard/i,
  );
});

test("both replacement functions preserve their private invoker boundaries and ACLs", () => {
  assert.match(assertComplete, /returns void\s+language plpgsql\s+security invoker\s+set search_path = ''/i);
  assert.match(complete, /returns jsonb\s+language plpgsql\s+security invoker\s+set search_path = ''/i);
  assert.match(
    migration,
    /revoke all on function internal\.jiaowubao_direct_import_assert_complete\(uuid\)\s+from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /revoke all on function internal\.complete_jiaowubao_direct_import\(uuid, text\)\s+from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(migration, /\b(?:grant|security definer|drop|truncate)\b/i);
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from)\s+public\.ops_state\b/i);
});

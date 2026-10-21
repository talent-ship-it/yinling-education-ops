import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021070512_wecom_handover_schedule_evidence.sql", import.meta.url), "utf8");

test("handover schedule cache is private and every public RPC is secret gated", () => {
  for (const name of ["read_wecom_handover_schedule_input", "save_wecom_handover_schedule_evidence", "read_wecom_handover_schedule_evidence"]) {
    const body = migration.slice(migration.indexOf(`create function public.${name}(`));
    const fn = body.slice(0, body.indexOf("$$;"));
    assert.match(fn, /security definer set search_path = ''/u);
    assert.match(fn, /internal\.verify_ops_secret\(p_secret\)/u);
    assert.match(body, new RegExp(`revoke all on function public\\.${name}\\([^;]+from public, anon, authenticated, service_role;`, "u"));
  }
  assert.match(migration, /alter table internal\.wecom_handover_schedule_evidence enable row level security/u);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) (?:public\.ops_state|internal\.wecom_archive_messages|internal\.wecom_lp_confirmations)\b/u);
});

test("private persistence has a registered disposable PostgreSQL behavioral fixture", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-evidence");
  assert.ok(fixture);
  assert.equal(fixture.source, "tests/sql/wecom-handover-schedule-evidence-runtime.sql");
  const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-evidence-runtime.sql", import.meta.url), "utf8");
  assert.match(runtime, /\\ir assert-disposable-database\.sql/u);
  assert.match(runtime, /historical_coverage_current_absence_or_reschedule_failed/u);
  assert.match(runtime, /hidden_sibling_became_unique_or_admin_failed/u);
  assert.match(runtime, /batch_did_not_rollback/u);
});
